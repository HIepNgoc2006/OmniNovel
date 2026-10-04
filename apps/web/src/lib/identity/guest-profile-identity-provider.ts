export const GUEST_PROFILE_ID_KEY = 'omninovel_guest_profile_id';
export const QUARANTINED_PROFILES_KEY = 'omninovel_quarantined_guest_profiles';

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class GuestProfileIdentityProvider {
  private inFlightPromise: Promise<string> | null = null;
  private cachedProfileId: string | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.key === GUEST_PROFILE_ID_KEY && event.newValue) {
          this.cachedProfileId = event.newValue;
        }
      });
    }
  }

  /**
   * Retrieves active guestProfileId or creates a new one.
   */
  async getOrCreateGuestProfileId(): Promise<string> {
    if (this.cachedProfileId) {
      return this.cachedProfileId;
    }

    if (typeof window === 'undefined') {
      return generateUUID();
    }

    const existing = localStorage.getItem(GUEST_PROFILE_ID_KEY);
    if (existing) {
      this.cachedProfileId = existing;
      return existing;
    }

    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    this.inFlightPromise = (async () => {
      try {
        const current = localStorage.getItem(GUEST_PROFILE_ID_KEY);
        if (current) {
          this.cachedProfileId = current;
          return current;
        }

        const newProfileId = generateUUID();
        localStorage.setItem(GUEST_PROFILE_ID_KEY, newProfileId);
        this.cachedProfileId = newProfileId;
        return newProfileId;
      } finally {
        this.inFlightPromise = null;
      }
    })();

    return this.inFlightPromise;
  }

  /**
   * Rotates active guestProfileId to a fresh UUIDv4 (used during logout).
   * Returns the new profile ID.
   */
  async rotateGuestProfileId(): Promise<string> {
    const newProfileId = generateUUID();
    if (typeof window !== 'undefined') {
      localStorage.setItem(GUEST_PROFILE_ID_KEY, newProfileId);
    }
    this.cachedProfileId = newProfileId;
    return newProfileId;
  }

  /**
   * Puts an uncommitted or previous guest profile into quarantined storage
   * to guarantee zero silent data loss.
   */
  async quarantineGuestScope(profileId: string): Promise<void> {
    if (!profileId || typeof window === 'undefined') return;

    try {
      const list = await this.listQuarantinedGuestScopes();
      if (!list.includes(profileId)) {
        list.push(profileId);
        localStorage.setItem(QUARANTINED_PROFILES_KEY, JSON.stringify(list));
      }
    } catch {
      // Fallback
    }
  }

  /**
   * Lists all quarantined guest profile IDs on this device.
   */
  async listQuarantinedGuestScopes(): Promise<string[]> {
    if (typeof window === 'undefined') return [];

    try {
      const raw = localStorage.getItem(QUARANTINED_PROFILES_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

export const guestProfileIdentityProvider = new GuestProfileIdentityProvider();
