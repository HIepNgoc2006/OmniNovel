import {
  TabRole,
  TabLeaderState,
  TabLeaderBroadcastMessage,
  TabLeaderElectionOptions,
} from './web-sync.types';

const DEFAULT_LOCK_PREFIX = 'omninovel_sync_leader';
const BROADCAST_CHANNEL_PREFIX = 'omninovel_sync_bus';

/**
 * TabLeaderElection
 *
 * Implements Multi-Tab Leader Election for OmniNovel Web Client following strict invariants:
 * 1. Web Locks API (navigator.locks) is the TRUE and EXCLUSIVE authority for leadership.
 * 2. Locks are partitioned strictly by account scope (ownerScope).
 * 3. Losing lock or changing ActiveScope immediately aborts in-flight leader sync operations.
 * 4. BroadcastChannel is purely advisory/informational and NEVER grants leadership.
 */
export class TabLeaderElection {
  private ownerScope: string;
  private readonly tabId: string;
  private readonly lockNamePrefix: string;
  private currentRole: TabRole = 'FOLLOWER';
  private acquiredAt: string | null = null;

  private leaderAbortController: AbortController | null = null;
  private lockReleaseResolve: (() => void) | null = null;
  private isDestroyed = false;
  private isElectionLoopActive = false;

  private broadcastChannel: BroadcastChannel | null = null;
  private readonly onRoleChange?: (role: TabRole, leaderSignal: AbortSignal | null) => void;
  private readonly onMessage?: (message: TabLeaderBroadcastMessage) => void;
  private readonly lockManager?: LockManager;

  constructor(options: TabLeaderElectionOptions & { lockManager?: LockManager }) {
    if (!options.ownerScope || typeof options.ownerScope !== 'string') {
      throw new Error('ownerScope must be a non-empty string.');
    }

    this.ownerScope = options.ownerScope;
    this.tabId = options.tabId || this.generateTabId();
    this.lockNamePrefix = options.lockNamePrefix || DEFAULT_LOCK_PREFIX;
    this.onRoleChange = options.onRoleChange;
    this.onMessage = options.onMessage;

    // Use passed lockManager, or default to navigator.locks in browser environments
    this.lockManager =
      options.lockManager ||
      (typeof navigator !== 'undefined' && 'locks' in navigator
        ? navigator.locks
        : undefined);

    this.initBroadcastChannel();
    this.attachUnloadListeners();
  }

  // ==================== PUBLIC API ====================

  /**
   * Starts the leader election process for the active ownerScope.
   * Immediately joins the Web Locks queue for this scope.
   */
  start(): void {
    if (this.isDestroyed) {
      throw new Error('Cannot start destroyed TabLeaderElection.');
    }
    if (this.isElectionLoopActive) {
      return;
    }

    this.isElectionLoopActive = true;
    this.runElectionLoop();
  }

  /**
   * Explicitly steps down leadership (if currently leader) and re-enters follower queue.
   */
  stepDown(): void {
    if (this.currentRole === 'LEADER') {
      this.terminateLeadership('Voluntary leader step-down');
    }
  }

  /**
   * Dynamic Scope Switching:
   * When user logs in, logs out, or switches accounts, ActiveScope changes.
   * Invariant: Instantly aborts old leader rights, releases old scope lock,
   * rebinds BroadcastChannel, and enters election queue for the new scope.
   */
  setActiveScope(newScope: string): void {
    if (!newScope || typeof newScope !== 'string') {
      throw new Error('newScope must be a non-empty string.');
    }
    if (this.ownerScope === newScope) {
      return;
    }

    const oldScope = this.ownerScope;

    // 1. Immediately abort and terminate old leadership
    this.terminateLeadership(`Scope switching from ${oldScope} to ${newScope}`);

    // 2. Rebind scope
    this.ownerScope = newScope;

    // 3. Rebind BroadcastChannel
    this.closeBroadcastChannel();
    this.initBroadcastChannel();

    // 4. Re-enter election loop for new scope if active
    if (this.isElectionLoopActive && !this.isDestroyed) {
      queueMicrotask(() => {
        if (!this.isDestroyed && this.ownerScope === newScope) {
          this.runElectionLoop();
        }
      });
    }
  }

  /**
   * Follower tab requests the leader tab to trigger an immediate sync pass.
   */
  requestLeaderSync(payload?: Record<string, unknown>): void {
    this.broadcast({
      type: 'SYNC_REQUEST',
      senderTabId: this.tabId,
      ownerScope: this.ownerScope,
      timestamp: Date.now(),
      payload,
    });
  }

  /**
   * Leader tab broadcasts a sync state change (e.g. PULLING, PUSHING, IDLE, ERROR) to follower tabs.
   */
  broadcastSyncState(state: string, details?: Record<string, unknown>): void {
    if (this.currentRole !== 'LEADER') {
      return; // Only true leader broadcasts authoritative sync state
    }

    this.broadcast({
      type: 'SYNC_STATE_CHANGED',
      senderTabId: this.tabId,
      ownerScope: this.ownerScope,
      timestamp: Date.now(),
      payload: { state, ...details },
    });
  }

  /**
   * Broadcasts notification that local storage was mutated (e.g. new bookmark or progress saved).
   */
  broadcastStorageMutated(domain: string, entityId: string): void {
    this.broadcast({
      type: 'STORAGE_MUTATED',
      senderTabId: this.tabId,
      ownerScope: this.ownerScope,
      timestamp: Date.now(),
      payload: { domain, entityId },
    });
  }

  /**
   * Retrieves current tab leader state snapshot.
   */
  getState(): TabLeaderState {
    return {
      tabId: this.tabId,
      ownerScope: this.ownerScope,
      role: this.currentRole,
      isLeader: this.currentRole === 'LEADER',
      acquiredAt: this.acquiredAt,
    };
  }

  /**
   * Retrieves current leader AbortSignal (valid only while this tab is Leader).
   * Returns null if tab is a Follower.
   */
  getLeaderSignal(): AbortSignal | null {
    return this.currentRole === 'LEADER' && this.leaderAbortController
      ? this.leaderAbortController.signal
      : null;
  }

  /**
   * Tears down tab leader election, revokes leadership, and closes all channels.
   */
  destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.isElectionLoopActive = false;

    this.terminateLeadership('TabLeaderElection destroyed');
    this.closeBroadcastChannel();
    this.detachUnloadListeners();
    this.currentRole = 'DISCONNECTED';
  }

  // ==================== INTERNAL ELECTION LOGIC ====================

  private getLockName(scope: string): string {
    return `${this.lockNamePrefix}:${scope}`;
  }

  /**
   * Core election loop powered by Web Locks API.
   * navigator.locks.request queues this tab. When prior leader tab exits,
   * the browser automatically grants the lock callback to this tab.
   */
  private async runElectionLoop(): Promise<void> {
    if (!this.isElectionLoopActive || this.isDestroyed) {
      return;
    }

    const currentTargetScope = this.ownerScope;
    const lockName = this.getLockName(currentTargetScope);

    if (!this.lockManager) {
      // In SSR or environments without Web Locks API, act as standalone isolated leader
      this.promoteToLeader(currentTargetScope);
      return;
    }

    try {
      await this.lockManager.request(lockName, async () => {
        // Double check scope hasn't changed or election wasn't destroyed while waiting in queue
        if (
          !this.isElectionLoopActive ||
          this.isDestroyed ||
          this.ownerScope !== currentTargetScope
        ) {
          return;
        }

        // True Web Lock acquired!
        this.promoteToLeader(currentTargetScope);

        // Keep the lock held until releaseLockResolve is called (stepDown, scope change, destroy)
        await new Promise<void>((resolve) => {
          this.lockReleaseResolve = resolve;
        });

        // Demote back to follower when lock is released (only if scope hasn't changed)
        if (this.ownerScope === currentTargetScope) {
          this.demoteToFollower('Lock promise resolved');
        }
      });
    } catch (err) {
      // If lock acquisition aborted or failed, ensure follower status (only if scope hasn't changed)
      if (this.ownerScope === currentTargetScope) {
        this.demoteToFollower(err instanceof Error ? err.message : String(err));
      }
    }

    // If still active for this scope, loop to re-request (in case of transient release)
    if (
      this.isElectionLoopActive &&
      !this.isDestroyed &&
      this.ownerScope === currentTargetScope
    ) {
      setTimeout(() => this.runElectionLoop(), 50);
    }
  }

  /**
   * Promotes tab to LEADER.
   * Gated strictly by Web Locks API callback entry.
   */
  private promoteToLeader(scope: string): void {
    if (this.ownerScope !== scope || this.isDestroyed) return;

    this.currentRole = 'LEADER';
    this.acquiredAt = new Date().toISOString();
    this.leaderAbortController = new AbortController();

    // Broadcast advisory announcement
    this.broadcast({
      type: 'LEADER_ANNOUNCE',
      senderTabId: this.tabId,
      ownerScope: this.ownerScope,
      timestamp: Date.now(),
    });

    if (this.onRoleChange) {
      this.onRoleChange('LEADER', this.leaderAbortController.signal);
    }
  }

  /**
   * Demotes tab to FOLLOWER and notifies consumer.
   */
  private demoteToFollower(reason: string): void {
    if (this.currentRole === 'LEADER') {
      if (this.leaderAbortController && !this.leaderAbortController.signal.aborted) {
        this.leaderAbortController.abort(reason);
      }
      this.leaderAbortController = null;
      this.acquiredAt = null;

      // Broadcast stepdown
      this.broadcast({
        type: 'LEADER_STEPDOWN',
        senderTabId: this.tabId,
        ownerScope: this.ownerScope,
        timestamp: Date.now(),
      });
    }

    if (this.currentRole !== 'DISCONNECTED') {
      this.currentRole = 'FOLLOWER';
    }

    if (this.onRoleChange) {
      this.onRoleChange(this.currentRole, null);
    }
  }

  /**
   * Forcefully terminates current leadership:
   * 1. Aborts the leader signal immediately.
   * 2. Resolves the lock callback to free the Web Lock.
   */
  private terminateLeadership(reason: string): void {
    if (this.leaderAbortController && !this.leaderAbortController.signal.aborted) {
      this.leaderAbortController.abort(reason);
    }
    this.leaderAbortController = null;
    this.acquiredAt = null;

    if (this.lockReleaseResolve) {
      const resolve = this.lockReleaseResolve;
      this.lockReleaseResolve = null;
      resolve();
    }

    if (this.currentRole === 'LEADER') {
      this.currentRole = 'FOLLOWER';
      this.broadcast({
        type: 'LEADER_STEPDOWN',
        senderTabId: this.tabId,
        ownerScope: this.ownerScope,
        timestamp: Date.now(),
      });

      if (this.onRoleChange) {
        this.onRoleChange('FOLLOWER', null);
      }
    }
  }

  // ==================== BROADCAST CHANNEL (ADVISORY ONLY) ====================

  private getChannelName(scope: string): string {
    return `${BROADCAST_CHANNEL_PREFIX}:${scope}`;
  }

  private initBroadcastChannel(): void {
    if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
      return;
    }

    try {
      this.broadcastChannel = new BroadcastChannel(this.getChannelName(this.ownerScope));
      this.broadcastChannel.onmessage = (event: MessageEvent<TabLeaderBroadcastMessage>) => {
        this.handleBroadcastMessage(event.data);
      };
    } catch {
      // BroadcastChannel unavailable in current environment, ignore safely
      this.broadcastChannel = null;
    }
  }

  private closeBroadcastChannel(): void {
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.close();
      } catch {}
      this.broadcastChannel = null;
    }
  }

  private broadcast(message: TabLeaderBroadcastMessage): void {
    if (this.broadcastChannel && !this.isDestroyed) {
      try {
        this.broadcastChannel.postMessage(message);
      } catch {}
    }
  }

  private handleBroadcastMessage(data: TabLeaderBroadcastMessage): void {
    if (!data || data.ownerScope !== this.ownerScope || data.senderTabId === this.tabId) {
      return;
    }

    // BroadcastChannel NEVER grants leadership! It only delivers notifications.
    if (this.onMessage) {
      this.onMessage(data);
    }
  }

  // ==================== UNLOAD & LIFECYCLE LISTENERS ====================

  private onUnload = (): void => {
    this.stepDown();
    this.destroy();
  };

  private attachUnloadListeners(): void {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.onUnload);
      window.addEventListener('pagehide', this.onUnload);
    }
  }

  private detachUnloadListeners(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.onUnload);
      window.removeEventListener('pagehide', this.onUnload);
    }
  }

  private generateTabId(): string {
    return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
