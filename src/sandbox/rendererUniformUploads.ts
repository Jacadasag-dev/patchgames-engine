const MAX_ENTRIES = 2_048;
const MAX_RETAINED_BYTES = 4 * 1024 * 1024;
const MAX_BUFFER_BYTES = 64 * 1024;
const MAX_GROUP_RANGES = 64;
const MAX_COALESCED_BYTES = 4 * 1024;
const MAX_ADDED_BYTES = 64;

type Words = Float32Array | Int32Array | Uint32Array;
interface UpdateRange { start: number; count: number }
interface UniformBinding {
  isNodeUniformBuffer?: boolean;
  isNodeUniformsGroup?: boolean;
  isStorageBuffer?: boolean;
  buffer: unknown;
  updateRanges?: UpdateRange[];
}
export interface UniformUploadBackend {
  get(binding: object): { buffer?: object };
  updateBinding(binding: UniformBinding): void;
  destroyUniformBuffer(binding: UniformBinding): void;
}
export interface UniformUploadStats {
  requests: number;
  skippedUploads: number;
  skippedBytes: number;
  comparedBytes: number;
  entries: number;
  retainedBytes: number;
  coalescedUploads: number;
  /** Native queue.writeBuffer calls avoided by merging generated group ranges. */
  coalescedWrites: number;
  coalescedExtraBytes: number;
}
interface Entry { resource: object; source: Words; words: Uint32Array; uploaded: Uint32Array }
interface ReuseHandle { stats: UniformUploadStats; dispose(): void }
const installed = new WeakMap<object, ReuseHandle>();

/** Native node uniform buffers otherwise upload on every draw, including when
 * an instance is unchanged. Compare the exact uploaded bits rather than a
 * version flag: authors can write these CPU arrays directly between passes.
 * GPU-written storage buffers, authored ranged updates and shared memory retain
 * the native path. Generated uniform groups can merge small dirty gaps without
 * changing their authoritative CPU data. Per-binding GPU and source-view identity
 * prevent reuse after resource recreation or source replacement. */
export function reuseRendererUniformUploads(backend: UniformUploadBackend): ReuseHandle {
  const previous = installed.get(backend);
  if (previous) return previous;
  const nativeUpdate = backend.updateBinding, nativeDestroy = backend.destroyUniformBuffer;
  const entries = new Map<object, Entry>();
  const stats: UniformUploadStats = { requests: 0, skippedUploads: 0, skippedBytes: 0, comparedBytes: 0, entries: 0, retainedBytes: 0,
    coalescedUploads: 0, coalescedWrites: 0, coalescedExtraBytes: 0 };
  let groupRanges = new WeakMap<object, { original: UpdateRange[]; merged: UpdateRange; active: boolean }>();
  let disposed = false;
  const forget = (binding: object) => {
    const entry = entries.get(binding);
    if (entry) { entries.delete(binding); stats.retainedBytes -= entry.uploaded.byteLength; stats.entries = entries.size; }
  };
  const update = function(this: UniformUploadBackend, binding: UniformBinding): void {
    // Native groups evaluate every uniform into an authoritative CPU buffer.
    // Tiny unchanged gaps (often alignment padding) need not force extra driver
    // calls. Authored BufferNode ranges retain their exact partial-write policy.
    const ranges = binding.updateRanges;
    if (!disposed && binding.isNodeUniformsGroup === true && binding.isStorageBuffer !== true
      && ranges && ranges.length > 1 && ranges.length <= MAX_GROUP_RANGES) {
      const source = binding.buffer;
      if (source instanceof Float32Array && source.buffer instanceof ArrayBuffer) {
        let end = -1, dirty = 0, writes = 0, valid = true;
        const start = ranges[0].start;
        for (const range of ranges) {
          if (!Number.isInteger(range.start) || !Number.isInteger(range.count) || range.start < 0 || range.count <= 0
            || range.start < end || range.start + range.count > source.length) { valid = false; break; }
          if (range.start !== end) writes++;
          end = range.start + range.count; dirty += range.count;
        }
        const spanBytes = (end - start) * 4, addedBytes = spanBytes - dirty * 4;
        if (valid && writes > 1 && spanBytes <= MAX_COALESCED_BYTES && addedBytes <= MAX_ADDED_BYTES && addedBytes <= dirty * 4) {
          let scratch = groupRanges.get(binding);
          if (!scratch) { scratch = { original: [], merged: { start: 0, count: 0 }, active: false }; groupRanges.set(binding, scratch); }
          // A custom/reentrant backend must never overwrite a pending restore.
          if (!scratch.active) {
            scratch.active = true;
            for (let index = 0; index < ranges.length; index++) scratch.original[index] = ranges[index];
            scratch.merged.start = start; scratch.merged.count = end - start;
            ranges.length = 1; ranges[0] = scratch.merged;
            try {
              nativeUpdate.call(this, binding);
              stats.coalescedUploads++; stats.coalescedWrites += writes - 1; stats.coalescedExtraBytes += addedBytes;
            } finally {
              ranges.length = scratch.original.length;
              for (let index = 0; index < ranges.length; index++) ranges[index] = scratch.original[index];
              scratch.original.length = 0; scratch.active = false;
            }
            return;
          }
        }
      }
    }
    if (disposed || binding.isNodeUniformBuffer !== true || binding.isStorageBuffer === true) {
      return nativeUpdate.call(this, binding);
    }
    stats.requests++;
    const source = binding.buffer, resource = this.get(binding).buffer;
    if (!(source instanceof Float32Array || source instanceof Int32Array || source instanceof Uint32Array)
      || !(source.buffer instanceof ArrayBuffer) || source.byteLength === 0 || source.byteLength > MAX_BUFFER_BYTES
      || binding.updateRanges?.length || !resource) {
      forget(binding); return nativeUpdate.call(this, binding);
    }
    let entry = entries.get(binding);
    if (entry && (entry.resource !== resource || entry.source !== source
      || entry.words.buffer !== source.buffer || entry.words.byteOffset !== source.byteOffset || entry.words.byteLength !== source.byteLength)) {
      forget(binding); entry = undefined;
    }
    if (entry) {
      let index = 0;
      for (; index < entry.words.length; index++) if (entry.words[index] !== entry.uploaded[index]) break;
      stats.comparedBytes += Math.min(index + 1, entry.words.length) * 4;
      // Refresh LRU position even when no driver work is necessary.
      entries.delete(binding); entries.set(binding, entry);
      if (index === entry.words.length) {
        stats.skippedUploads++; stats.skippedBytes += source.byteLength; return;
      }
    }
    nativeUpdate.call(this, binding);
    // A native failure never marks data as uploaded. A resource or source view
    // replaced during a custom backend call is conservatively rechecked later.
    if (this.get(binding).buffer !== resource || binding.buffer !== source) { forget(binding); return; }
    if (!entry) {
      while (entries.size >= MAX_ENTRIES || stats.retainedBytes + source.byteLength > MAX_RETAINED_BYTES) {
        const oldest = entries.keys().next().value;
        if (!oldest) break;
        forget(oldest);
      }
      entry = { resource, source, words: new Uint32Array(source.buffer, source.byteOffset, source.length), uploaded: new Uint32Array(source.length) };
      entries.set(binding, entry); stats.entries = entries.size; stats.retainedBytes += source.byteLength;
    }
    entry.uploaded.set(entry.words);
  };
  const destroy = function(this: UniformUploadBackend, binding: UniformBinding): void {
    forget(binding); groupRanges.delete(binding); nativeDestroy.call(this, binding);
  };
  const handle: ReuseHandle = { stats, dispose() {
    if (disposed) return;
    disposed = true; entries.clear(); groupRanges = new WeakMap(); stats.entries = stats.retainedBytes = 0;
    if (backend.updateBinding === update) backend.updateBinding = nativeUpdate;
    if (backend.destroyUniformBuffer === destroy) backend.destroyUniformBuffer = nativeDestroy;
    installed.delete(backend);
  } };
  backend.updateBinding = update; backend.destroyUniformBuffer = destroy;
  installed.set(backend, handle);
  return handle;
}

export function rendererUniformUploadStats(backend: object): UniformUploadStats | undefined {
  return installed.get(backend)?.stats;
}
