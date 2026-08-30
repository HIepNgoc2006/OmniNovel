export type AuthStatus = 'initializing' | 'authenticated' | 'anonymous';

interface AuthState {
  accessToken: string | null;
  status: AuthStatus;
}

let authState: AuthState = {
  accessToken: null,
  status: 'initializing',
};

const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

export const memoryAuthStore = {
  getAccessToken: (): string | null => authState.accessToken,

  setAccessToken: (token: string | null) => {
    authState.accessToken = token;
    authState.status = token ? 'authenticated' : 'anonymous';
    notify();
  },

  getStatus: (): AuthStatus => authState.status,

  setStatus: (status: AuthStatus) => {
    authState.status = status;
    if (status === 'anonymous') {
      authState.accessToken = null;
    }
    notify();
  },

  clear: () => {
    authState = {
      accessToken: null,
      status: 'anonymous',
    };
    notify();
  },

  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
