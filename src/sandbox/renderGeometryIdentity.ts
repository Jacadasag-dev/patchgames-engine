import { Box3, BufferAttribute, BufferGeometry, FloatType, Sphere, Vector3 } from 'three';

const MAX_ENTRIES = 4096;
const MAX_RETAINED_BYTES = 32 * 1024 * 1024;
const MAX_GEOMETRY_BYTES = 4 * 1024 * 1024;
const MAX_ATTRIBUTES = 16;
// BufferGeometry inherits these EventDispatcher implementations. Capture them
// once so an authored override installed later cannot intercept our subscription
// cleanup or prevent the remaining cached sources from being released.
const addListener = BufferGeometry.prototype.addEventListener;
const removeListener = BufferGeometry.prototype.removeEventListener;
type NumericArray = Float32Array | Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array;
interface AttributeStamp {
  name: string; attribute: BufferAttribute; array: NumericArray; bytes: Uint8Array;
  version: number; count: number; itemSize: number; normalized: boolean; gpuType: number; usage: number;
}
interface Snapshot {
  attributes: AttributeStamp[]; index: AttributeStamp | null; bytes: number; hash: number; layout: string;
  defaults: readonly number[]; bounds: readonly number[]; groups: readonly number[]; drawStart: number; drawCount: number;
  signature: string;
}
interface IdentityClass { id: number; signature: string; representative?: Entry }
interface Entry {
  geometry: BufferGeometry; snapshot: Snapshot; revision: number; frame: number;
  group?: IdentityClass; release: () => void;
}

function arraySupported(array: ArrayLike<number>): array is NumericArray {
  return array instanceof Float32Array || array instanceof Int8Array || array instanceof Uint8Array
    || array instanceof Uint8ClampedArray || array instanceof Int16Array || array instanceof Uint16Array
    || array instanceof Int32Array || array instanceof Uint32Array;
}
function arrayKind(array: NumericArray): string {
  // WebGLAttributes chooses its scalar type by instanceof, not constructor.name.
  // Distinct typed-array subclasses can have the same authored class name.
  if (array instanceof Float32Array) return 'f32';
  if (array instanceof Int8Array) return 'i8';
  if (array instanceof Uint8Array) return 'u8';
  if (array instanceof Uint8ClampedArray) return 'u8c';
  if (array instanceof Int16Array) return 'i16';
  if (array instanceof Uint16Array) return 'u16';
  return array instanceof Int32Array ? 'i32' : 'u32';
}
function ordinaryAttribute(attribute: unknown, index: boolean): attribute is BufferAttribute {
  if (!(attribute instanceof BufferAttribute) || 'isInstancedBufferAttribute' in attribute || 'isFloat16BufferAttribute' in attribute
    || !arraySupported(attribute.array) || !(attribute.array.buffer instanceof ArrayBuffer)
    || attribute.gpuType !== FloatType || !Number.isInteger(attribute.itemSize) || attribute.itemSize < 1 || attribute.itemSize > 4
    || !Number.isInteger(attribute.count) || attribute.count <= 0 || attribute.count * attribute.itemSize !== attribute.array.length
    || attribute.onUploadCallback !== BufferAttribute.prototype.onUploadCallback || attribute.updateRanges.length
    || attribute.getX !== BufferAttribute.prototype.getX || attribute.getY !== BufferAttribute.prototype.getY || attribute.getZ !== BufferAttribute.prototype.getZ) return false;
  return !index || attribute.itemSize === 1 && !attribute.normalized
    && (attribute.array instanceof Uint8Array || attribute.array instanceof Uint16Array || attribute.array instanceof Uint32Array);
}
function ordinaryGeometry(geometry: BufferGeometry): boolean {
  return !('isInstancedBufferGeometry' in geometry) && !geometry.indirect && !Object.keys(geometry.morphAttributes).length
    && (geometry.boundingBox === null || geometry.boundingBox instanceof Box3)
    && (geometry.boundingSphere === null || geometry.boundingSphere instanceof Sphere)
    && geometry.computeBoundingBox === BufferGeometry.prototype.computeBoundingBox
    && geometry.computeBoundingSphere === BufferGeometry.prototype.computeBoundingSphere
    && geometry.addEventListener === addListener && geometry.removeEventListener === removeListener
    && Number.isInteger(geometry.drawRange.start) && geometry.drawRange.start >= 0
    && (geometry.drawRange.count === Infinity || Number.isInteger(geometry.drawRange.count) && geometry.drawRange.count >= 0)
    && geometry.groups.length <= 128;
}
function stamp(name: string, attribute: BufferAttribute): AttributeStamp {
  const array = attribute.array as NumericArray;
  return { name, attribute, array, bytes: new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
    version: attribute.version, count: attribute.count, itemSize: attribute.itemSize, normalized: attribute.normalized,
    gpuType: attribute.gpuType, usage: attribute.usage };
}
function unchanged(stamp: AttributeStamp, attribute: unknown, index: boolean): boolean {
  return attribute === stamp.attribute && ordinaryAttribute(attribute, index) && attribute.array === stamp.array
    && attribute.version === stamp.version && attribute.count === stamp.count && attribute.itemSize === stamp.itemSize
    && attribute.normalized === stamp.normalized && attribute.gpuType === stamp.gpuType && attribute.usage === stamp.usage
    && attribute.array.byteLength === stamp.bytes.byteLength;
}
function dataUnchanged(geometry: BufferGeometry, snapshot: Snapshot): boolean {
  if (Object.keys(geometry.attributes).length !== snapshot.attributes.length) return false;
  if (snapshot.index ? !unchanged(snapshot.index, geometry.index, true) : geometry.index !== null) return false;
  for (const item of snapshot.attributes) if (!unchanged(item, geometry.attributes[item.name], false)) return false;
  return true;
}
function boundsMatch(geometry: BufferGeometry, values: readonly number[], defaults: readonly number[]): boolean {
  const box = geometry.boundingBox, sphere = geometry.boundingSphere;
  return Object.is(box?.min.x ?? defaults[0], values[0]) && Object.is(box?.min.y ?? defaults[1], values[1])
    && Object.is(box?.min.z ?? defaults[2], values[2]) && Object.is(box?.max.x ?? defaults[3], values[3])
    && Object.is(box?.max.y ?? defaults[4], values[4]) && Object.is(box?.max.z ?? defaults[5], values[5])
    && Object.is(sphere?.center.x ?? defaults[6], values[6]) && Object.is(sphere?.center.y ?? defaults[7], values[7])
    && Object.is(sphere?.center.z ?? defaults[8], values[8]) && Object.is(sphere?.radius ?? defaults[9], values[9]);
}
function metadataUnchanged(geometry: BufferGeometry, snapshot: Snapshot): boolean {
  if (geometry.drawRange.start !== snapshot.drawStart || geometry.drawRange.count !== snapshot.drawCount
    || geometry.groups.length * 3 !== snapshot.groups.length || !boundsMatch(geometry, snapshot.bounds, snapshot.defaults)) return false;
  for (let index = 0; index < geometry.groups.length; index++) {
    const group = geometry.groups[index], offset = index * 3;
    if (group.start !== snapshot.groups[offset] || group.count !== snapshot.groups[offset + 1]
      || group.materialIndex !== snapshot.groups[offset + 2]) return false;
  }
  return true;
}
function exact(a: Snapshot, b: Snapshot): boolean {
  if (a.layout !== b.layout || Boolean(a.index) !== Boolean(b.index) || a.drawStart !== b.drawStart || a.drawCount !== b.drawCount || a.groups.length !== b.groups.length) return false;
  for (let i = 0; i < a.groups.length; i++) if (a.groups[i] !== b.groups[i]) return false;
  for (let i = 0; i < a.bounds.length; i++) if (!Object.is(a.bounds[i], b.bounds[i])) return false;
  const compare = (left: AttributeStamp, right: AttributeStamp) => {
    if (left.bytes.byteLength !== right.bytes.byteLength) return false;
    for (let i = 0; i < left.bytes.byteLength; i++) if (left.bytes[i] !== right.bytes[i]) return false;
    return true;
  };
  if (a.index && (!b.index || !compare(a.index, b.index))) return false;
  for (let i = 0; i < a.attributes.length; i++) if (!compare(a.attributes[i], b.attributes[i])) return false;
  return true;
}

/** Exact render identities for independently constructed ordinary geometries.
 * Keys identify content, never replace or mutate an authored geometry. Buffer
 * writes follow Three's needsUpdate/version contract. A frame is one synchronous
 * render preparation: authored callbacks must run outside that preparation.
 * Only changed buffers are hashed; collisions always receive a full byte check.
 * Source references/listeners are bounded and owned by this renderer helper. */
export class RenderGeometryIdentity {
  readonly stats = { entries: 0, retainedBytes: 0, hashedBytes: 0, comparisons: 0 };
  private readonly entries = new Map<BufferGeometry, Entry>();
  private readonly classes = new Map<string, Set<IdentityClass>>();
  private nextId = -1;
  private disposed = false;

  /** Negative IDs represent exact content classes. Unsupported/over-budget
   * geometry uses its original nonnegative Three ID, retaining normal sharing. */
  key(geometry: BufferGeometry, revision: number, frame: number): number {
    if (this.disposed) return geometry.id;
    const entry = this.refresh(geometry, revision, frame);
    if (!entry) return geometry.id;
    if (entry.group?.representative) {
      const representative = entry.group.representative;
      this.refresh(representative.geometry, representative.revision, frame);
      if (entry.group?.representative) return entry.group.id;
    }
    const candidates = this.classes.get(entry.snapshot.signature);
    if (candidates) for (const candidate of candidates) {
      const representative = candidate.representative;
      if (!representative) continue;
      this.refresh(representative.geometry, representative.revision, frame);
      if (!candidate.representative || representative.snapshot.signature !== entry.snapshot.signature) continue;
      this.stats.comparisons++;
      if (exact(entry.snapshot, representative.snapshot)) { entry.group = candidate; return candidate.id; }
    }
    const group: IdentityClass = { id: this.nextId--, signature: entry.snapshot.signature, representative: entry };
    let matches = this.classes.get(group.signature);
    if (!matches) { matches = new Set(); this.classes.set(group.signature, matches); }
    matches.add(group); entry.group = group;
    return group.id;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) this.release(entry);
    this.entries.clear(); this.classes.clear(); this.stats.entries = this.stats.retainedBytes = 0;
  }

  private invalidate(group: IdentityClass): void {
    group.representative = undefined;
    const bucket = this.classes.get(group.signature);
    bucket?.delete(group);
    if (!bucket?.size) this.classes.delete(group.signature);
  }
  private release(entry: Entry): void {
    if (this.entries.get(entry.geometry) !== entry) return;
    this.entries.delete(entry.geometry); this.stats.retainedBytes -= entry.snapshot.bytes;
    this.stats.entries = this.entries.size;
    if (entry.group?.representative === entry) this.invalidate(entry.group);
    entry.group = undefined;
    removeListener.call(entry.geometry, 'dispose', entry.release);
  }
  private refresh(geometry: BufferGeometry, revision: number, frame: number): Entry | undefined {
    let entry = this.entries.get(geometry);
    if (entry?.frame === frame && entry.revision === revision) return entry;
    if (!ordinaryGeometry(geometry)) { if (entry) this.release(entry); return; }
    const sameData = entry !== undefined && dataUnchanged(geometry, entry.snapshot);
    if (entry && sameData && metadataUnchanged(geometry, entry.snapshot)) {
      entry.frame = frame; entry.revision = revision;
      this.entries.delete(geometry); this.entries.set(geometry, entry);
      return entry;
    }
    const snapshot = this.snapshot(geometry, sameData ? entry!.snapshot : undefined);
    if (!snapshot) { if (entry) this.release(entry); return; }
    if (entry) this.release(entry);
    while (this.entries.size >= MAX_ENTRIES || this.stats.retainedBytes + snapshot.bytes > MAX_RETAINED_BYTES) {
      const oldest = this.entries.values().next().value;
      if (!oldest) return;
      this.release(oldest);
    }
    entry = { geometry, snapshot, revision, frame, release: () => this.release(entry!) };
    this.entries.set(geometry, entry); addListener.call(geometry, 'dispose', entry.release);
    this.stats.entries = this.entries.size; this.stats.retainedBytes += snapshot.bytes;
    return entry;
  }

  private snapshot(geometry: BufferGeometry, previous?: Snapshot): Snapshot | undefined {
    let attributes: AttributeStamp[], index: AttributeStamp | null, bytes: number, hash: number, layout: string, defaults: readonly number[];
    if (previous) ({ attributes, index, bytes, hash, layout, defaults } = previous);
    else {
      const names = Object.keys(geometry.attributes).sort(), position = geometry.attributes.position;
      if (!names.length || names.length > MAX_ATTRIBUTES || !ordinaryAttribute(position, false) || position.itemSize !== 3) return;
      attributes = []; index = null; bytes = 0;
      for (const name of names) {
        const attribute = geometry.attributes[name];
        if (name.length > 128 || !ordinaryAttribute(attribute, false) || attribute.count !== position.count) return;
        bytes += attribute.array.byteLength;
        if (bytes > MAX_GEOMETRY_BYTES) return;
        attributes.push(stamp(name, attribute));
      }
      if (geometry.index) {
        if (!ordinaryAttribute(geometry.index, true)) return;
        index = stamp('', geometry.index); bytes += index.array.byteLength;
      }
      if (bytes > MAX_GEOMETRY_BYTES) return;
      const all = index ? [...attributes, index] : attributes;
      layout = JSON.stringify(all.map(item => [item.name, arrayKind(item.array), item.count, item.itemSize, item.normalized, item.gpuType, item.usage]));
      hash = 2166136261;
      for (const item of all) for (let i = 0; i < item.bytes.byteLength; i++) hash = Math.imul(hash ^ item.bytes[i], 16777619) >>> 0;
      this.stats.hashedBytes += bytes;
      // Match Three's default bounds without filling source boundingBox/Sphere.
      // Null and ordinarily computed bounds therefore share the same identity.
      const box = new Box3().setFromBufferAttribute(position), center = box.getCenter(new Vector3()), point = new Vector3();
      let radiusSquared = 0;
      for (let i = 0; i < position.count; i++) radiusSquared = Math.max(radiusSquared, center.distanceToSquared(point.fromBufferAttribute(position, i)));
      defaults = [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z, center.x, center.y, center.z, Math.sqrt(radiusSquared)];
    }
    const box = geometry.boundingBox, sphere = geometry.boundingSphere;
    if (box !== null && !(box instanceof Box3) || sphere !== null && !(sphere instanceof Sphere)) return;
    const bounds = [box?.min.x ?? defaults[0], box?.min.y ?? defaults[1], box?.min.z ?? defaults[2],
      box?.max.x ?? defaults[3], box?.max.y ?? defaults[4], box?.max.z ?? defaults[5], sphere?.center.x ?? defaults[6],
      sphere?.center.y ?? defaults[7], sphere?.center.z ?? defaults[8], sphere?.radius ?? defaults[9]];
    if (!bounds.every(Number.isFinite) || bounds[0] > bounds[3] || bounds[1] > bounds[4] || bounds[2] > bounds[5] || bounds[9] < 0) return;
    const groups: number[] = [];
    for (const group of geometry.groups) {
      if (!Number.isInteger(group.start) || group.start < 0 || !Number.isInteger(group.count) || group.count < 0
        || !Number.isInteger(group.materialIndex) || group.materialIndex! < 0) return;
      groups.push(group.start, group.count, group.materialIndex!);
    }
    const drawStart = geometry.drawRange.start, drawCount = geometry.drawRange.count;
    return { attributes, index, bytes, hash, layout, defaults, bounds, groups, drawStart, drawCount,
      signature: `${layout}|${hash}|${drawStart},${drawCount}|${groups.join(',')}|${bounds.join(',')}` };
  }
}
