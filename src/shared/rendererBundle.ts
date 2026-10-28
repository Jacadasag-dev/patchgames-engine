/** Renderer packaging is engine-owned. Game source cannot opt itself into an
 * alternate renderer or claim that visual/stability checks have passed. */
export const VIEW_RENDERER_SCHEMA = 2;
export const VIEW_RENDERER_REVISION = 'renderer-catalog-3';
export const VIEW_RENDERER_HEADER = '/* @engine-view-renderer ';
const HEADER_END = ' */\n';
const ALTERNATIVE_HEADER = '\n/* @engine-view-webgpu ';
const MAX_HEADER_LENGTH = 2_048;
export const VIEW_RENDERER_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const VIEW_RENDERER_MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const MAX_PAYLOAD_LENGTH = VIEW_RENDERER_MAX_PAYLOAD_BYTES;
const SHA256 = /^[a-f0-9]{64}$/;

export type ViewRendererBackend = 'webgl' | 'webgpu';
export type ViewRendererEvidenceStatus = 'passed' | 'failed' | 'pending' | 'unsupported';
export interface ViewRendererCandidate {
  readonly backend: ViewRendererBackend;
  readonly available: boolean;
  readonly bundle: 'self' | 'webgpu' | null;
  readonly evidence: {
    readonly revision: string;
    readonly compatibility: ViewRendererEvidenceStatus;
    readonly visualParity: ViewRendererEvidenceStatus;
    readonly stability: ViewRendererEvidenceStatus;
  };
  readonly reason: string;
}
export interface ViewRendererCatalog {
  readonly schema: typeof VIEW_RENDERER_SCHEMA;
  readonly engineRevision: typeof VIEW_RENDERER_REVISION;
  /** Content identities, not authorship signatures. Both are verified by the host. */
  readonly payloadHash: string;
  readonly alternativeHashes: Readonly<Partial<Record<ViewRendererBackend, string>>>;
  readonly baseline: 'webgl';
  readonly candidates: readonly ViewRendererCandidate[];
}
export interface ViewRendererBundle {
  readonly payload: string;
  readonly alternatives: Readonly<Partial<Record<ViewRendererBackend, string>>>;
  readonly catalog: ViewRendererCatalog;
}
export interface ViewRendererAlternative {
  readonly code?: string;
  readonly payloadHash?: string;
  readonly compatibility: 'passed' | 'unsupported';
  readonly reason: string;
}

/** These are engine release qualifications, never accepted from bundle data.
 * The host still verifies per-device startup, replay visuals and frame pacing. */
// Revision 3 qualifies the corrected facade, opaque secure worker transport,
// bounded pipeline retention and submission queue. Older alternate executables
// cannot inherit this qualification. Device replay checks still gate selection.
const WEBGPU_QUALIFICATION = Object.freeze({ visualParity: 'passed' as ViewRendererEvidenceStatus,
  stability: 'passed' as ViewRendererEvidenceStatus });
function candidates(alternative: ViewRendererAlternative | undefined): readonly ViewRendererCandidate[] {
  const available = !!alternative?.code;
  return Object.freeze([
    Object.freeze({ backend: 'webgl' as const, available: true, bundle: 'self' as const,
      evidence: Object.freeze({ revision: VIEW_RENDERER_REVISION, compatibility: 'passed' as const,
        visualParity: 'passed' as const, stability: 'passed' as const }),
      reason: 'The existing production renderer and visual baseline.' }),
    Object.freeze({ backend: 'webgpu' as const, available, bundle: available ? 'webgpu' as const : null,
      evidence: Object.freeze({ revision: VIEW_RENDERER_REVISION,
        compatibility: alternative?.compatibility ?? 'unsupported', ...WEBGPU_QUALIFICATION }),
      reason: alternative?.reason ?? 'This bundle does not contain a compatible WebGPU alternative.' }),
  ]);
}
function encode(code: string): string {
  const bytes = new TextEncoder().encode(code), chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32_768)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
  return btoa(chunks.join(''));
}
function decode(code: string): string {
  const binary = atob(code), bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** An inert sidecar preserves the executable-JavaScript contract of live games,
 * archives and old replay consumers: executing this whole string runs WebGL.
 * The normal host extracts and verifies the alternative before considering it. */
export function packageViewRendererBundle(payload: string, payloadHash: string, alternative?: ViewRendererAlternative): string {
  if (!SHA256.test(payloadHash)) throw new Error('A view bundle requires a SHA-256 payload identity.');
  if (alternative?.code && (!alternative.payloadHash || !SHA256.test(alternative.payloadHash)))
    throw new Error('An alternate view bundle requires a SHA-256 payload identity.');
  const sidecar = alternative?.code ? encode(alternative.code) : '';
  const webgpu = alternative ? { compatibility: alternative.compatibility, reason: alternative.reason.slice(0, 400),
    ...(sidecar ? { payloadHash: alternative.payloadHash, length: sidecar.length } : {}) } : undefined;
  const header = JSON.stringify({ schema: VIEW_RENDERER_SCHEMA, engineRevision: VIEW_RENDERER_REVISION,
    payloadHash, baseline: 'webgl', ...(webgpu ? { webgpu } : {}) }).replaceAll('*/', '*\\/');
  return VIEW_RENDERER_HEADER + header + HEADER_END + payload
    + (sidecar ? ALTERNATIVE_HEADER + sidecar + HEADER_END : '');
}

/** Only bounded, known metadata is read. The two executable strings stay inside
 * their existing sandbox. A bundle cannot provide qualification evidence, URLs,
 * a worker bootstrap or any extra renderer implementation. */
export function readViewRendererBundle(code: string): ViewRendererBundle | null {
  if (!code.startsWith(VIEW_RENDERER_HEADER)) return null;
  const end = code.slice(0, MAX_HEADER_LENGTH).indexOf(HEADER_END, VIEW_RENDERER_HEADER.length);
  if (end < 0) return null;
  let header: unknown;
  try { header = JSON.parse(code.slice(VIEW_RENDERER_HEADER.length, end)); } catch { return null; }
  if (!header || typeof header !== 'object' || Array.isArray(header)) return null;
  const data = header as Record<string, unknown>;
  if (Object.keys(data).some(key => !['schema','engineRevision','payloadHash','baseline','webgpu'].includes(key))
    || data.schema !== VIEW_RENDERER_SCHEMA || data.engineRevision !== VIEW_RENDERER_REVISION || data.baseline !== 'webgl'
    || typeof data.payloadHash !== 'string' || !SHA256.test(data.payloadHash)) return null;
  let payload = code.slice(end + HEADER_END.length), alternative: ViewRendererAlternative | undefined;
  if (data.webgpu !== undefined) {
    if (!data.webgpu || typeof data.webgpu !== 'object' || Array.isArray(data.webgpu)) return null;
    const gpu = data.webgpu as Record<string, unknown>;
    if (Object.keys(gpu).some(key => !['compatibility','reason','payloadHash','length'].includes(key))
      || !['passed','unsupported'].includes(String(gpu.compatibility))
      || typeof gpu.reason !== 'string' || gpu.reason.length > 400) return null;
    alternative = { compatibility: gpu.compatibility as 'passed' | 'unsupported', reason: gpu.reason };
    if (gpu.length !== undefined || gpu.payloadHash !== undefined) {
      if (typeof gpu.payloadHash !== 'string' || !SHA256.test(gpu.payloadHash)
        || typeof gpu.length !== 'number' || !Number.isInteger(gpu.length) || gpu.length <= 0 || gpu.length > MAX_PAYLOAD_LENGTH * 4 / 3 + 4
        || !payload.endsWith(HEADER_END)) return null;
      const sidecarStart = payload.length - HEADER_END.length - gpu.length - ALTERNATIVE_HEADER.length;
      if (sidecarStart <= 0 || payload.slice(sidecarStart, sidecarStart + ALTERNATIVE_HEADER.length) !== ALTERNATIVE_HEADER) return null;
      let alternateCode: string;
      try { alternateCode = decode(payload.slice(sidecarStart + ALTERNATIVE_HEADER.length, -HEADER_END.length)); }
      catch { return null; }
      if (!alternateCode || new TextEncoder().encode(alternateCode).length > MAX_PAYLOAD_LENGTH) return null;
      alternative = { ...alternative, code: alternateCode, payloadHash: gpu.payloadHash };
      payload = payload.slice(0, sidecarStart);
    }
  }
  if (!payload || new TextEncoder().encode(payload).length > MAX_PAYLOAD_LENGTH) return null;
  return { payload, alternatives: Object.freeze(alternative?.code ? { webgpu: alternative.code } : {}),
    catalog: Object.freeze({ schema: VIEW_RENDERER_SCHEMA, engineRevision: VIEW_RENDERER_REVISION,
      payloadHash: data.payloadHash, alternativeHashes: Object.freeze(alternative?.payloadHash ? { webgpu: alternative.payloadHash } : {}),
      baseline: 'webgl', candidates: candidates(alternative) }) };
}

/** Storage accepts old single-renderer bundles up to their original limit.
 * Larger packages must be a valid engine envelope, with each decoded executable
 * independently bounded. Current malformed envelopes are never treated as raw
 * legacy JavaScript merely because their combined size happens to be small. */
export function viewRendererBundleWithinLimits(code: string): boolean {
  const bytes = new TextEncoder().encode(code).length;
  if (bytes > VIEW_RENDERER_MAX_PACKAGE_BYTES) return false;
  if (!code.startsWith(VIEW_RENDERER_HEADER)) return bytes <= VIEW_RENDERER_MAX_PAYLOAD_BYTES;
  // Schema 1 was an executable baseline preceded by this bounded identity
  // comment, before alternate sidecars existed. Preserve archived packages.
  if (code.startsWith(VIEW_RENDERER_HEADER + '{"schema":1,'))
    return bytes <= VIEW_RENDERER_MAX_PAYLOAD_BYTES && !code.includes(ALTERNATIVE_HEADER);
  return readViewRendererBundle(code) !== null;
}
