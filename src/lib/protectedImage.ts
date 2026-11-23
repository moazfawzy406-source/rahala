import { fetchAssetAccessUrl, registerSessionCacheCleanup } from './api';

// Memory only. Never persist private image bytes or access URLs to disk storage.
const images = new Map<string, { url: string; expires: number }>();
const pending = new Map<string, Promise<string>>();
let generation = 0;
registerSessionCacheCleanup(() => {
  generation++;
  for (const item of images.values()) URL.revokeObjectURL(item.url);
  images.clear();
  pending.clear();
});
export function peekProtectedImage(assetId: string): string | null {
  const hit = images.get(assetId);
  return hit && hit.expires > Date.now() ? hit.url : null;
}
export function loadProtectedImage(assetId: string): Promise<string> {
  const cached = peekProtectedImage(assetId);
  if (cached) return Promise.resolve(cached);
  const current = pending.get(assetId);
  if (current) return current;
  const epoch = generation;
  const promise = (async () => {
    const access = await fetchAssetAccessUrl(assetId);
    const response = await fetch(access, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) throw new Error('Image unavailable');
    const blob = await response.blob();
    if (epoch !== generation) throw new Error('Session changed');
    const old = images.get(assetId);
    if (old) URL.revokeObjectURL(old.url);
    const url = URL.createObjectURL(blob);
    images.set(assetId, { url, expires: Date.now() + 240_000 });
    if (images.size > 50) {
      const key = images.keys().next().value!;
      URL.revokeObjectURL(images.get(key)!.url);
      images.delete(key);
    }
    return url;
  })().finally(() => { if (epoch === generation) pending.delete(assetId); });
  pending.set(assetId, promise);
  return promise;
}
