import type { Camera, Scene, WebGLRenderer } from 'three';

export interface ViewRenderProfile { drawCalls: number; drawMs: number; shadowMs: number }
let renderProfile: ViewRenderProfile | undefined;
/** Trusted inspector timing only; ordinary gameplay never reads a wall clock.
 * Draw time includes shadow submission, and GPU work can finish asynchronously. */
export function beginViewRenderProfile(enabled: boolean): void {
  renderProfile = enabled ? { drawCalls: 0, drawMs: 0, shadowMs: 0 } : undefined;
}
export function endViewRenderProfile(): ViewRenderProfile | undefined {
  const result = renderProfile; renderProfile = undefined; return result;
}
/** Preserve the actual render calls, camera and shadow settings while exposing
 * CPU submission/wait time. This is not GPU timing or a gameplay FPS metric. */
export function renderProfiledView(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
  const profile = renderProfile;
  if (!profile) { renderer.render(scene, camera); return; }
  const shadows = renderer.shadowMap, original = shadows?.render;
  if (original) shadows.render = function (...args) {
    const started = performance.now();
    try { return original.apply(this, args); }
    finally { profile.shadowMs += performance.now() - started; }
  };
  const started = performance.now(); profile.drawCalls++;
  try { renderer.render(scene, camera); }
  finally {
    profile.drawMs += performance.now() - started;
    if (original) shadows.render = original;
  }
}

/** Inspector-only authored view evidence. These values are not authoritative game state. */
export type ViewDiagnostics =
  | {source: 'game-view'; status: 'complete'; data: Record<string, unknown>}
  | {source: 'game-view'; status: 'truncated' | 'error'; message: string};
export const VIEW_DIAGNOSTICS_MAX_BYTES = 16 * 1024;

class DiagnosticLimit extends Error {}
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a plain JSON record.');
  const seen = new Set<object>();
  let nodes = 0;
  const copy = (input: unknown, depth: number): unknown => {
    if (++nodes > 2048 || depth > 12) throw new DiagnosticLimit('View diagnostics exceed structural limits.');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input === 'string') {
      if (input.length > VIEW_DIAGNOSTICS_MAX_BYTES) throw new DiagnosticLimit('View diagnostics exceed 16 KiB.');
      return input;
    }
    if (typeof input !== 'object' || !input) throw new Error('View diagnostics must contain only finite JSON values.');
    const prototype = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) throw new Error('View diagnostics must use plain objects.');
    if (seen.has(input)) throw new Error('View diagnostics contain a circular reference.');
    if (Array.isArray(input) && input.length > 512) throw new DiagnosticLimit('View diagnostics exceed structural limits.');
    seen.add(input);
    const keys = Object.keys(input);
    if (keys.length > 512) throw new DiagnosticLimit('View diagnostics exceed structural limits.');
    if (Array.isArray(input) && (keys.length !== input.length || keys.some(key => !/^(?:0|[1-9]\d*)$/.test(key))))
      throw new Error('View diagnostics must use dense JSON arrays.');
    const result: Record<string, unknown> | unknown[] = Array.isArray(input) ? [] : Object.create(null);
    for (const key of keys) {
      if (key.length > 256) throw new DiagnosticLimit('View diagnostic keys exceed structural limits.');
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('View diagnostics cannot contain accessors.');
      (result as Record<string, unknown>)[key] = copy(descriptor.value, depth + 1);
    }
    seen.delete(input);
    return result;
  };
  return copy(value, 0) as Record<string, unknown>;
}
function bounded(value: ViewDiagnostics): ViewDiagnostics {
  if (new TextEncoder().encode(JSON.stringify(value)).length > VIEW_DIAGNOSTICS_MAX_BYTES)
    throw new DiagnosticLimit('View diagnostics exceed 16 KiB.');
  return value;
}
function failure(error: unknown): ViewDiagnostics {
  return {source: 'game-view', status: error instanceof DiagnosticLimit ? 'truncated' : 'error',
    message: (error instanceof Error ? error.message : 'View inspection hook failed.').slice(0, 300)};
}

/** Never propagates authored hook failures into normal view rendering. */
export function captureViewDiagnostics(read?: () => unknown): ViewDiagnostics | undefined {
  if (!read) return undefined;
  try { return bounded({source: 'game-view', status: 'complete', data: plain(read())}); }
  catch (error) { return failure(error); }
}

/** Preserve useful evidence when independently authored systems share one capture.
 * Hooks run once. A broken/large addon cannot erase healthy terrain or actor
 * summaries. Large complete sections are replaced explicitly, then excess
 * failure envelopes are omitted only if even their metadata exceeds the budget. */
export function composeViewDiagnostics(base: (() => unknown) | undefined,
  features: readonly { id: string; read: () => unknown }[]): Record<string, unknown> {
  let baseEvidence = captureViewDiagnostics(base);
  const entries = features.map(feature => ({ id: feature.id, ...captureViewDiagnostics(feature.read)! }));
  let omittedFeatureCount = 0;
  const value = (): Record<string, unknown> => ({
    ...(baseEvidence?.status === 'complete' ? baseEvidence.data : baseEvidence ? { inspectionBase: baseEvidence } : {}),
    ...(entries.length ? { features: entries } : {}),
    ...(omittedFeatureCount ? { inspectionComposition: { omittedFeatureCount } } : {}),
  });
  while (true) {
    const result = value();
    if (captureViewDiagnostics(() => result)?.status === 'complete') return result;
    // Preserve the base's world/terrain evidence; trim the largest addon first.
    // Even a full roster of broken addon hooks must not erase a healthy base.
    const sources = entries.flatMap((entry, index) => entry.status === 'complete'
      ? [{ index, size: JSON.stringify(entry.data).length }] : []).sort((a, b) => b.size - a.size);
    if (sources.length) {
      const omitted: ViewDiagnostics = { source: 'game-view', status: 'truncated',
        message: 'This source was omitted to keep combined base and feature diagnostics within 16 KiB and structural limits. Return a smaller inspection summary.' };
      const index = sources[0].index; entries[index] = { id: entries[index].id, ...omitted };
    } else if (entries.length) { entries.pop(); omittedFeatureCount++; }
    else if (baseEvidence?.status === 'complete') baseEvidence = { source: 'game-view', status: 'truncated', message: 'Base diagnostics left no room for composition metadata. Return a smaller inspection summary.' };
    else return { inspectionBase: { source: 'game-view', status: 'truncated', message: 'Combined inspection metadata exceeded its budget.' } };
  }
}

/** Recheck worker data before accepting it into the host report. */
export function acceptViewDiagnostics(input: unknown): ViewDiagnostics | undefined {
  if (input === undefined) return undefined;
  try {
    const value = plain(input);
    if (value.source !== 'game-view' || !['complete', 'truncated', 'error'].includes(String(value.status))
      || Object.keys(value).some(key => !['source', 'status', 'data', 'message'].includes(key))) throw new Error('Invalid view diagnostics envelope.');
    if (value.status === 'complete') {
      if (value.message !== undefined) throw new Error('Invalid completed view diagnostics.');
      return bounded({source: 'game-view', status: 'complete', data: plain(value.data)});
    }
    if (value.data !== undefined || typeof value.message !== 'string' || value.message.length > 300) throw new Error('Invalid view diagnostics failure.');
    return bounded({source: 'game-view', status: value.status as 'truncated' | 'error', message: value.message});
  } catch (error) { return failure(error); }
}
