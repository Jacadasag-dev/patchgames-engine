import type { MaterialSourcePixels } from '../shared/materialRecipeRenderer.ts';

let transport: ((message: unknown) => void) | undefined;
let sequence = 0, loaded = 0, failed = 0;
const pending = new Map<number, { resolve(value: MaterialSourcePixels): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
const cache = new Map<string, Promise<MaterialSourcePixels>>();
export function configureMediaTransport(send: (message: unknown) => void): void {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Media transport replaced')); }
  pending.clear(); cache.clear(); loaded = 0; failed = 0; transport = send;
}
export function resolveTextureSource(id: string): Promise<MaterialSourcePixels> {
  const hit = cache.get(id); if (hit) return hit;
  if (!transport) return Promise.reject(new Error('Material asset transport unavailable. Provide resolveSource for a standalone preview.'));
  if (pending.size >= 16 || typeof id !== 'string' || id.length > 120) return Promise.reject(new Error('Material source request exceeds its budget'));
  const requestId = ++sequence;
  const promise = new Promise<MaterialSourcePixels>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); failed++; reject(new Error(`Material source timed out: ${id}`)); }, 12_000);
    pending.set(requestId, { resolve, reject, timer });
    transport!({ type: 'media-request', requestId, id });
  });
  cache.set(id, promise);
  while (cache.size > 16) cache.delete(cache.keys().next().value!);
  void promise.catch(() => cache.delete(id));
  return promise;
}
/** Replies arrive only through the locked parent bridge. */
export function receiveMediaSource(message: { requestId: number; source?: MaterialSourcePixels; error?: string }): void {
  const request = pending.get(message.requestId); if (!request) return;
  clearTimeout(request.timer); pending.delete(message.requestId);
  if (message.error || !message.source) { failed++; request.reject(new Error(message.error || 'Material source missing')); }
  else { loaded++; request.resolve(message.source); }
}
export async function settleMediaSources(): Promise<void> {
  // Await current requests and their material-construction continuations before an inspection frame.
  await Promise.allSettled([...cache.values()]);
  await Promise.resolve(); await Promise.resolve();
}
export function mediaSourceInfo(): Record<string, number> { return { mediaPending: pending.size, mediaLoaded: loaded, mediaErrors: failed }; }
