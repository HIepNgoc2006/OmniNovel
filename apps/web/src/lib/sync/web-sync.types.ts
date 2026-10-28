import { SyncDomain, SyncOperation } from '@omninovel/shared';

export type TabRole = 'LEADER' | 'FOLLOWER' | 'DISCONNECTED';

export type SyncClientState =
  | 'IDLE'
  | 'PULLING'
  | 'PUSHING'
  | 'RECONCILING_410'
  | 'ERROR'
  | 'OFFLINE';

export interface TabLeaderState {
  tabId: string;
  ownerScope: string;
  role: TabRole;
  isLeader: boolean;
  acquiredAt: string | null;
}

export type TabBroadcastMessageType =
  | 'LEADER_ANNOUNCE'
  | 'LEADER_STEPDOWN'
  | 'SYNC_REQUEST'
  | 'SYNC_STATE_CHANGED'
  | 'STORAGE_MUTATED';

export interface TabLeaderBroadcastMessage {
  type: TabBroadcastMessageType;
  senderTabId: string;
  ownerScope: string;
  timestamp: number;
  payload?: Record<string, unknown>;
}

export interface TabLeaderElectionOptions {
  ownerScope: string;
  tabId?: string;
  lockNamePrefix?: string;
  onRoleChange?: (role: TabRole, leaderSignal: AbortSignal | null) => void;
  onMessage?: (message: TabLeaderBroadcastMessage) => void;
}
