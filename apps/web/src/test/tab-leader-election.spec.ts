import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TabLeaderElection } from '../lib/sync/tab-leader-election';
import { TabRole, TabLeaderBroadcastMessage } from '../lib/sync/web-sync.types';

/**
 * Deterministic In-Memory LockManager adhering to W3C Web Locks API standard
 */
class InMemoryLockManager implements LockManager {
  private queues: Map<string, Array<() => Promise<void>>> = new Map();
  private heldLocks: Set<string> = new Set();

  async request<T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    callback?: LockGrantedCallback<T>
  ): Promise<T> {
    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback!;

    if (!this.heldLocks.has(name)) {
      this.heldLocks.add(name);
      try {
        return (await cb({ name, mode: 'exclusive' } as any)) as T;
      } finally {
        this.heldLocks.delete(name);
        this.processNext(name);
      }
    }

    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(name) || [];
      queue.push(async () => {
        this.heldLocks.add(name);
        try {
          const result = (await cb({ name, mode: 'exclusive' } as any)) as T;
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          this.heldLocks.delete(name);
          this.processNext(name);
        }
      });
      this.queues.set(name, queue);
    });
  }

  private processNext(name: string) {
    const queue = this.queues.get(name);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      // Execute asynchronously in next microtask
      queueMicrotask(() => {
        next();
      });
    }
  }

  async query(): Promise<LockManagerSnapshot> {
    return {
      held: Array.from(this.heldLocks).map((name) => ({ name, mode: 'exclusive' })),
      pending: [],
    };
  }
}

describe('Task 7C.3 — Step 3: Tab Leader Election (Web Locks API & Scope Partitioning)', () => {
  let lockManager: InMemoryLockManager;

  beforeEach(() => {
    lockManager = new InMemoryLockManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Leader Acquisition & Web Locks Invariants', () => {
    it('acquires leadership via Web Locks API and provisions active leader AbortSignal', async () => {
      let roleChangeCount = 0;
      let latestSignal: AbortSignal | null = null;

      const tab = new TabLeaderElection({
        ownerScope: 'account:usr-1',
        tabId: 'tab-1',
        lockManager,
        onRoleChange: (role, signal) => {
          roleChangeCount++;
          latestSignal = signal;
        },
      });

      expect(tab.getState().isLeader).toBe(false);
      expect(tab.getState().role).toBe('FOLLOWER');

      // Start election
      tab.start();

      // Yield event loop to let Web Lock promise resolve
      await new Promise((r) => setTimeout(r, 20));

      const state = tab.getState();
      expect(state.isLeader).toBe(true);
      expect(state.role).toBe('LEADER');
      expect(state.acquiredAt).not.toBeNull();
      expect(tab.getLeaderSignal()).not.toBeNull();
      expect(tab.getLeaderSignal()?.aborted).toBe(false);
      expect(latestSignal).toBe(tab.getLeaderSignal());
      expect(roleChangeCount).toBe(1);

      tab.destroy();
    });

    it('terminates leadership immediately and aborts leader signal when stepDown() is invoked', async () => {
      const tab = new TabLeaderElection({
        ownerScope: 'account:usr-1',
        tabId: 'tab-1',
        lockManager,
      });

      tab.start();
      await new Promise((r) => setTimeout(r, 20));

      expect(tab.getState().isLeader).toBe(true);
      const signal = tab.getLeaderSignal();
      expect(signal?.aborted).toBe(false);

      // Step down
      tab.stepDown();

      expect(tab.getState().isLeader).toBe(false);
      expect(tab.getState().role).toBe('FOLLOWER');
      expect(tab.getLeaderSignal()).toBeNull();
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason).toBe('Voluntary leader step-down');

      tab.destroy();
    });
  });

  describe('2. Account Scope Partitioning Invariant', () => {
    it('allows simultaneous leaders for different account scopes without blocking each other', async () => {
      const tabScopeA = new TabLeaderElection({
        ownerScope: 'account:user-alice',
        tabId: 'tab-alice',
        lockManager,
      });

      const tabScopeB = new TabLeaderElection({
        ownerScope: 'account:user-bob',
        tabId: 'tab-bob',
        lockManager,
      });

      tabScopeA.start();
      tabScopeB.start();

      await new Promise((r) => setTimeout(r, 20));

      // Both tabs MUST be leaders for their respective partition
      expect(tabScopeA.getState().isLeader).toBe(true);
      expect(tabScopeA.getState().ownerScope).toBe('account:user-alice');

      expect(tabScopeB.getState().isLeader).toBe(true);
      expect(tabScopeB.getState().ownerScope).toBe('account:user-bob');

      tabScopeA.destroy();
      tabScopeB.destroy();
    });
  });

  describe('3. Multi-Tab Competition & Failover within the Same Scope', () => {
    it('elects exactly one leader among multiple competing tabs, transferring lock when leader steps down', async () => {
      const scope = 'account:usr-active-competition';

      const tab1 = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-alpha',
        lockManager,
      });

      const tab2 = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-beta',
        lockManager,
      });

      // Start Tab 1 first
      tab1.start();
      await new Promise((r) => setTimeout(r, 20));

      // Tab 1 must be LEADER
      expect(tab1.getState().isLeader).toBe(true);
      expect(tab1.getState().role).toBe('LEADER');

      // Start Tab 2 for the same scope
      tab2.start();
      await new Promise((r) => setTimeout(r, 20));

      // Tab 2 must be FOLLOWER (waiting for lock)
      expect(tab2.getState().isLeader).toBe(false);
      expect(tab2.getState().role).toBe('FOLLOWER');

      const tab1Signal = tab1.getLeaderSignal();
      expect(tab1Signal?.aborted).toBe(false);

      // Now Tab 1 steps down
      tab1.stepDown();

      // Tab 1 leader signal MUST be aborted instantly
      expect(tab1Signal?.aborted).toBe(true);
      expect(tab1.getState().isLeader).toBe(false);

      // Allow Tab 2 to acquire lock from queue
      await new Promise((r) => setTimeout(r, 50));

      // Tab 2 MUST be promoted to LEADER
      expect(tab2.getState().isLeader).toBe(true);
      expect(tab2.getState().role).toBe('LEADER');
      expect(tab2.getLeaderSignal()?.aborted).toBe(false);

      tab1.destroy();
      tab2.destroy();
    });
  });

  describe('4. Dynamic Scope Switching & Lock Revocation', () => {
    it('revokes leadership, aborts in-flight signal, and re-elects for new scope on setActiveScope()', async () => {
      const tab = new TabLeaderElection({
        ownerScope: 'guest:device-1',
        tabId: 'tab-main',
        lockManager,
      });

      tab.start();
      await new Promise((r) => setTimeout(r, 20));

      expect(tab.getState().isLeader).toBe(true);
      expect(tab.getState().ownerScope).toBe('guest:device-1');

      const guestSignal = tab.getLeaderSignal();
      expect(guestSignal?.aborted).toBe(false);

      // Switch scope from guest to account (User Login / Guest Claim)
      tab.setActiveScope('account:usr-claimed-99');

      // Old leader signal MUST be aborted immediately!
      expect(guestSignal?.aborted).toBe(true);
      expect(guestSignal?.reason).toContain('Scope switching');

      // Yield to let tab re-acquire Web Lock for the new scope
      await new Promise((r) => setTimeout(r, 30));

      expect(tab.getState().isLeader).toBe(true);
      expect(tab.getState().ownerScope).toBe('account:usr-claimed-99');
      expect(tab.getLeaderSignal()?.aborted).toBe(false);

      tab.destroy();
    });
  });

  describe('5. BroadcastChannel Advisory Invariant', () => {
    it('treats BroadcastChannel as strictly advisory; messages do NOT grant leadership', async () => {
      const scope = 'account:usr-broadcast-test';
      const receivedMessages: TabLeaderBroadcastMessage[] = [];

      const followerTab = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-follower',
        lockManager,
        onMessage: (msg) => {
          receivedMessages.push(msg);
        },
      });

      // Follower has NOT called start() yet and has NOT acquired Web Lock
      expect(followerTab.getState().isLeader).toBe(false);

      // Simulate a fake incoming broadcast message claiming LEADER_STEPDOWN
      followerTab['handleBroadcastMessage']({
        type: 'LEADER_STEPDOWN',
        senderTabId: 'fake-other-tab',
        ownerScope: scope,
        timestamp: Date.now(),
      });

      // INVARIANT: Receiving LEADER_STEPDOWN must NOT self-promote follower to leader!
      expect(followerTab.getState().isLeader).toBe(false);
      expect(followerTab.getState().role).toBe('FOLLOWER');

      // But the message was safely delivered to onMessage for advisory awareness
      expect(receivedMessages.length).toBe(1);
      expect(receivedMessages[0].type).toBe('LEADER_STEPDOWN');

      followerTab.destroy();
    });

    it('enables follower to request sync and leader to broadcast sync state transitions', async () => {
      const scope = 'account:usr-messaging-test';
      let leaderReceivedSyncRequest = false;

      const leaderTab = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-leader-node',
        lockManager,
        onMessage: (msg) => {
          if (msg.type === 'SYNC_REQUEST') {
            leaderReceivedSyncRequest = true;
          }
        },
      });

      leaderTab.start();
      await new Promise((r) => setTimeout(r, 20));
      expect(leaderTab.getState().isLeader).toBe(true);

      const followerTab = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-follower-node',
        lockManager,
      });

      // Follower sends sync request
      followerTab.requestLeaderSync({ trigger: 'MUTATION_ENQUEUED' });

      // Follower cannot broadcast sync state (only true leader can)
      const broadcastSpy = vi.spyOn(followerTab as any, 'broadcast');
      followerTab.broadcastSyncState('PULLING');
      expect(broadcastSpy).not.toHaveBeenCalled();

      leaderTab.destroy();
      followerTab.destroy();
    });
  });

  describe('6. Fail-closed without Web Locks API (P0-02 Invariant)', () => {
    it('remains DISCONNECTED and never promotes to LEADER when Web Locks API is unavailable', async () => {
      let latestRole: TabRole | null = null;
      let latestSignal: AbortSignal | null = null;

      // Pass undefined lockManager to simulate environments without Web Locks API (SSR or older browsers)
      const fallbackTab = new TabLeaderElection({
        ownerScope: 'account:usr-fallback',
        tabId: 'tab-fallback',
        lockManager: undefined,
        onRoleChange: (role, signal) => {
          latestRole = role;
          latestSignal = signal;
        },
      });

      // Initial state must be DISCONNECTED
      expect(fallbackTab.getState().isLeader).toBe(false);
      expect(fallbackTab.getState().role).toBe('DISCONNECTED');
      expect(fallbackTab.getLeaderSignal()).toBeNull();

      // Attempt start()
      fallbackTab.start();
      await new Promise((r) => setTimeout(r, 20));

      // Invariant: Web Locks API is the EXCLUSIVE authority. Without it, tab must NOT become LEADER.
      expect(fallbackTab.getState().isLeader).toBe(false);
      expect(fallbackTab.getState().role).toBe('DISCONNECTED');
      expect(fallbackTab.getLeaderSignal()).toBeNull();
      expect(latestSignal).toBeNull();
      expect(latestRole).toBe('DISCONNECTED');

      // Unload / destroy keeps it DISCONNECTED
      fallbackTab.destroy();
      expect(fallbackTab.getState().isLeader).toBe(false);
      expect(fallbackTab.getState().role).toBe('DISCONNECTED');
    });
  });

  describe('7. Synchronous Lifecycle Operations inside onRoleChange (P0-03 Regression Tests)', () => {
    it('immediately releases Web Lock when stepDown() is invoked synchronously inside onRoleChange', async () => {
      const scope = 'account:usr-sync-stepdown';
      const tab1RoleEvents: TabRole[] = [];
      let tab2BecameLeader = false;

      let tab1Ref!: TabLeaderElection;
      tab1Ref = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-sync-1',
        lockManager,
        onRoleChange: (role) => {
          tab1RoleEvents.push(role);
          if (role === 'LEADER') {
            // Synchronous stepDown inside callback!
            tab1Ref.stepDown();
          }
        },
      });

      const tab2 = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-sync-2',
        lockManager,
        onRoleChange: (role) => {
          if (role === 'LEADER') {
            tab2BecameLeader = true;
          }
        },
      });

      // Start tab1 first, then tab2
      tab1Ref.start();
      tab2.start();

      // Yield to let lock acquisition, synchronous stepDown, and failover run
      await new Promise((r) => setTimeout(r, 40));

      // Tab 1 should have transitioned LEADER -> FOLLOWER synchronously without deadlocking
      expect(tab1RoleEvents).toEqual(['LEADER', 'FOLLOWER']);
      expect(tab1Ref.getState().isLeader).toBe(false);

      // Crucial: Tab 2 MUST have successfully acquired the lock because Tab 1 did NOT deadlock or hold the lock!
      expect(tab2BecameLeader).toBe(true);
      expect(tab2.getState().isLeader).toBe(true);
      expect(tab2.getState().role).toBe('LEADER');

      tab1Ref.destroy();
      tab2.destroy();
    });

    it('immediately releases Web Lock when destroy() is invoked synchronously inside onRoleChange', async () => {
      const scope = 'account:usr-sync-destroy';
      let tab2BecameLeader = false;

      let tab1Ref!: TabLeaderElection;
      tab1Ref = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-destroy-1',
        lockManager,
        onRoleChange: (role) => {
          if (role === 'LEADER') {
            // Synchronous destroy inside callback!
            tab1Ref.destroy();
          }
        },
      });

      const tab2 = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-destroy-2',
        lockManager,
        onRoleChange: (role) => {
          if (role === 'LEADER') {
            tab2BecameLeader = true;
          }
        },
      });

      tab1Ref.start();
      tab2.start();

      await new Promise((r) => setTimeout(r, 40));

      expect(tab1Ref.getState().isLeader).toBe(false);
      expect(tab1Ref.getState().role).toBe('DISCONNECTED');

      // Crucial: Tab 2 MUST acquire leadership without waiting indefinitely
      expect(tab2BecameLeader).toBe(true);
      expect(tab2.getState().isLeader).toBe(true);

      tab1Ref.destroy();
      tab2.destroy();
    });

    it('immediately releases old scope Web Lock and acquires new scope when setActiveScope() is invoked synchronously inside onRoleChange', async () => {
      const scopeA = 'account:usr-scope-A';
      const scopeB = 'account:usr-scope-B';
      let tab2BecameLeaderScopeA = false;

      let tab1Ref!: TabLeaderElection;
      tab1Ref = new TabLeaderElection({
        ownerScope: scopeA,
        tabId: 'tab-scope-1',
        lockManager,
        onRoleChange: (role) => {
          if (role === 'LEADER' && tab1Ref.getState().ownerScope === scopeA) {
            // Synchronously switch scope upon becoming leader for scopeA
            tab1Ref.setActiveScope(scopeB);
          }
        },
      });

      const tab2ScopeA = new TabLeaderElection({
        ownerScope: scopeA,
        tabId: 'tab-scopeA-2',
        lockManager,
        onRoleChange: (role) => {
          if (role === 'LEADER') {
            tab2BecameLeaderScopeA = true;
          }
        },
      });

      tab1Ref.start();
      tab2ScopeA.start();

      await new Promise((r) => setTimeout(r, 60));

      // Tab 2 must have acquired lock for scope A because Tab 1 released it immediately!
      expect(tab2BecameLeaderScopeA).toBe(true);
      expect(tab2ScopeA.getState().isLeader).toBe(true);

      // Tab 1 must now be leader for scope B!
      expect(tab1Ref.getState().ownerScope).toBe(scopeB);
      expect(tab1Ref.getState().isLeader).toBe(true);

      tab1Ref.destroy();
      tab2ScopeA.destroy();
    });
  });
});
