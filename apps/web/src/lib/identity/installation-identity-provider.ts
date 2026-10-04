export const INSTALLATION_ID_KEY = 'omninovel_installation_id';

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 10xx
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class InstallationIdentityProvider {
  private inFlightPromise: Promise<string> | null = null;
  private cachedId: string | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.key === INSTALLATION_ID_KEY && event.newValue) {
          this.cachedId = event.newValue;
        }
      });
    }
  }

  /**
   * Retrieves existing installationId or creates a new stable UUIDv4.
   * Multi-instance & multi-tab race guard ensures all callers converge on the single canonical ID.
   * This ID is NEVER reset or destroyed upon user logout.
   */
  async getOrCreateInstallationId(): Promise<string> {
    if (typeof window === 'undefined') {
      throw new Error('InstallationIdentityProvider is client-only and cannot be executed during SSR.');
    }

    if (this.cachedId) {
      return this.cachedId;
    }

    const existing = localStorage.getItem(INSTALLATION_ID_KEY);
    if (existing) {
      this.cachedId = existing;
      return existing;
    }

    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    this.inFlightPromise = (async () => {
      try {
        if (typeof navigator !== 'undefined' && navigator.locks) {
          return await navigator.locks.request('omninovel_installation_lock', async () => {
            const current = localStorage.getItem(INSTALLATION_ID_KEY);
            if (current) {
              this.cachedId = current;
              return current;
            }
            const newId = generateUUID();
            localStorage.setItem(INSTALLATION_ID_KEY, newId);
            this.cachedId = newId;
            return newId;
          });
        }

        // Fallback for environments without Web Locks API (e.g., jsdom / older browsers):
        // Re-read storage, write candidate, and read-back canonical persisted value.
        const current = localStorage.getItem(INSTALLATION_ID_KEY);
        if (current) {
          this.cachedId = current;
          return current;
        }

        const candidate = generateUUID();
        localStorage.setItem(INSTALLATION_ID_KEY, candidate);
        const canonical = localStorage.getItem(INSTALLATION_ID_KEY) || candidate;
        this.cachedId = canonical;
        return canonical;
      } finally {
        this.inFlightPromise = null;
      }
    })();

    return this.inFlightPromise;
  }
}

export const installationIdentityProvider = new InstallationIdentityProvider();
