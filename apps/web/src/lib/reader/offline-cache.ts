/**
 * Offline Cache Layer for OmniNovel Multimodal Reader
 * Uses IndexedDB to store raw media assets & HTML blobs safely
 * Cache key: asset:{assetId}:version:{chapterVersionId}
 */

const DB_NAME = 'omninovel_offline_reader';
const DB_VERSION = 1;
const STORE_NAME = 'cached_assets';

interface CachedAssetRecord {
  key: string; // asset:{assetId}:version:{versionId}
  assetId: string;
  versionId: string;
  content: ArrayBuffer | string;
  contentType: string;
  cachedAt: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      return reject(new Error('IndexedDB is not available'));
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function buildAssetCacheKey(assetId: string, versionId: string): string {
  return `asset:${assetId}:version:${versionId}`;
}

export async function getCachedAsset(
  assetId: string,
  versionId: string,
): Promise<CachedAssetRecord | null> {
  try {
    const db = await openDatabase();
    const key = buildAssetCacheKey(assetId, versionId);

    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);

      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function setCachedAsset(
  assetId: string,
  versionId: string,
  content: ArrayBuffer | string,
  contentType: string,
): Promise<void> {
  try {
    const db = await openDatabase();
    const key = buildAssetCacheKey(assetId, versionId);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put({
        key,
        assetId,
        versionId,
        content,
        contentType,
        cachedAt: Date.now(),
      });

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Fail silently in private/incognito mode
  }
}

export async function purgeOfflineCache(): Promise<void> {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {}
}
