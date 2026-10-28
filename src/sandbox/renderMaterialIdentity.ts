import {
  Color, Euler, Material, MeshBasicMaterial, MeshLambertMaterial, MeshNormalMaterial, MeshPhongMaterial,
  MeshStandardMaterial, MeshToonMaterial, NoBlending, NormalBlending, Plane, Texture, Vector2, Vector3,
} from 'three';

const MAX_GROUPS = 512;
const MAX_DEFINES = 64;
const MAX_PLANES = 32;
const MAX_STRING = 4096;
const MAX_IDLE_FRAMES = 120;
type Token = number | string | boolean | null;
type Kind = 'scalar' | 'color' | 'vector2' | 'euler' | 'texture' | 'planes' | 'defines';
interface Field { name: string; kind: Kind; scalarType?: string }
interface Schema { id: number; fields: Field[]; names: Map<string, number>; required: number; prototypes: object[]; defines: number }
interface Group { id: number; hash: number; values: Token[]; used: number; active: boolean }
interface MaterialState {
  frame: number; values: Token[]; group?: Group; key?: number; schema?: Schema;
  fields: unknown[]; nested: Token[]; scratch: Token[]; offsets: number[]; valid: boolean; unchanged: boolean; continuousChanges: number;
}
interface PrototypeDefaults { descriptors: PropertyDescriptorMap; names: PropertyKey[]; parent: object | null }
interface PrototypeState extends PrototypeDefaults { frame: number; valid: boolean }

const ignored = new Set(['id', 'uuid', 'name', 'userData', 'version', '_listeners', 'dispose', 'clone', 'copy', 'toJSON', 'constructor']);
const hooks = new Map<string, unknown>([
  ['onBeforeCompile', Material.prototype.onBeforeCompile], ['onBeforeRender', Material.prototype.onBeforeRender],
  ['customProgramCacheKey', Material.prototype.customProgramCacheKey],
]);
const constructors = [MeshBasicMaterial, MeshLambertMaterial, MeshPhongMaterial, MeshStandardMaterial, MeshToonMaterial, MeshNormalMaterial];
const prototypeDefaults = new Map<object, PrototypeDefaults>();
const schemas = new Map<object, Schema>();
const COLOR_COMPONENTS = ['r', 'g', 'b'];
const VECTOR2_COMPONENTS = ['x', 'y'];
const VECTOR3_COMPONENTS = ['x', 'y', 'z'];
const EULER_COMPONENTS = ['_x', '_y', '_z', '_order'];

// Derive the complete own-field schema from this installed Three revision,
// instead of silently omitting a newly added scalar/texture rendering property.
// Physical's per-instance reflectivity accessor cannot be verified by function
// identity, so it intentionally keeps its ordinary rendering path.
for (const Constructor of constructors) {
  const sample = new Constructor(), fields: Field[] = [], names = new Set(Object.getOwnPropertyNames(sample));
  names.add('_listeners');
  for (const name of ignored) names.add(name);
  for (const name of hooks.keys()) names.add(name);
  // Three accepts defines on every built-in material, although only some
  // constructors create the property themselves.
  names.add('defines');
  for (const name of names) {
    if (ignored.has(name) || hooks.has(name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(sample, name), value = descriptor?.value;
    let kind: Kind = 'scalar';
    if (name === 'defines') kind = 'defines';
    else if (name === 'clippingPlanes') kind = 'planes';
    else if (name === 'map' || name.endsWith('Map')) kind = 'texture';
    else if (value instanceof Color) kind = 'color';
    else if (value instanceof Vector2) kind = 'vector2';
    else if (value instanceof Euler) kind = 'euler';
    else if (!descriptor || !('value' in descriptor) || value !== null && !['number', 'boolean', 'string'].includes(typeof value))
      throw new Error(`Unrecognized built-in material field: ${Constructor.name}.${name}`);
    fields.push({ name, kind, ...(kind === 'scalar' && value !== null ? { scalarType: typeof value } : {}) });
  }
  const prototypes: object[] = [];
  for (let prototype: object | null = Constructor.prototype; prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
    prototypes.push(prototype);
    if (!prototypeDefaults.has(prototype)) prototypeDefaults.set(prototype, {
      descriptors: Object.getOwnPropertyDescriptors(prototype), names: Reflect.ownKeys(prototype), parent: Object.getPrototypeOf(prototype),
    });
  }
  const named = new Map<string, number>();
  for (const name of names) named.set(name, 0);
  let required = 0;
  for (let index = 0; index < fields.length; index++) {
    named.set(fields[index].name, index + 1);
    if (fields[index].kind !== 'defines') required++;
  }
  schemas.set(Constructor.prototype, { id: schemas.size + 1, fields, names: named, required, prototypes, defines: fields.findIndex(field => field.kind === 'defines') });
}
for (const Constructor of [Color, Euler, Vector2, Vector3, Plane, Texture]) prototypeDefaults.set(Constructor.prototype, {
  descriptors: Object.getOwnPropertyDescriptors(Constructor.prototype), names: Reflect.ownKeys(Constructor.prototype), parent: Object.getPrototypeOf(Constructor.prototype),
});

function equal(a: readonly Token[], b: readonly Token[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (!Object.is(a[index], b[index])) return false;
  return true;
}

/** Exact, render-only equivalence for ordinary built-in opaque materials.
 * Call with a new monotonically increasing frame for each synchronous prepare.
 * All mutable state is sampled once per material in that prepare; no authored
 * material, texture, disposal listener, or needsUpdate flag is changed.
 * Keys remain stable while their bounded equivalence group is retained. Evicted
 * keys are never reused, and a group used in this frame is never evicted. */
export class RenderMaterialIdentity {
  private materials = new WeakMap<Material, MaterialState>();
  private references = new WeakMap<object, number>();
  private readonly prototypes = new Map<object, PrototypeState>();
  private readonly groups = new Map<number, Group>();
  private readonly hashes = new Map<number, Group[]>();
  private readonly float = new Float64Array(1);
  private readonly words = new Uint32Array(this.float.buffer);
  private nextReference = 1;
  private nextGroup = 1;
  private frame = -1;
  private snapshots = 0;
  private unchangedReuses = 0;
  private disposed = false;

  get stats() { return { retainedGroups: this.groups.size, snapshots: this.snapshots, unchangedReuses: this.unchangedReuses }; }

  key(material: Material, frame: number): number | undefined {
    if (this.disposed) return undefined;
    if (frame !== this.frame) {
      this.frame = frame;
      // A bounded occasional sweep also releases signatures of abandoned views.
      if (frame % 32 === 0) for (const group of this.groups.values())
        if (frame - group.used > MAX_IDLE_FRAMES) this.remove(group);
    }
    let state = this.materials.get(material);
    if (!state) { state = { frame: -1, values: [], fields: [], nested: [], scratch: [], offsets: [], valid: false, unchanged: false, continuousChanges: 0 }; this.materials.set(material, state); }
    if (state.frame === frame) return state.key;
    state.frame = frame; state.key = undefined;
    const schema = schemas.get(Object.getPrototypeOf(material));
    if (!schema || !this.snapshot(material, schema, state)) { state.valid = false; state.group = undefined; return undefined; }
    if (state.unchanged && state.group?.active) {
      state.group.used = frame; this.unchangedReuses++; return state.key = state.group.id;
    }
    if (state.group?.active && equal(state.values, state.group.values)) {
      state.group.used = frame; return state.key = state.group.id;
    }
    const hash = this.hash(state.values);
    let entries = this.hashes.get(hash);
    const existing = entries?.find(group => equal(group.values, state.values));
    if (existing) { existing.used = frame; state.group = existing; return state.key = existing.id; }
    if (this.groups.size >= MAX_GROUPS) {
      let oldest: Group | undefined;
      for (const group of this.groups.values()) if (group.used !== frame && (!oldest || group.used < oldest.used)) oldest = group;
      // Excess distinct materials retain their original draws, rather than
      // invalidating identities already consumed by this prepare.
      if (!oldest) { state.group = undefined; return undefined; }
      this.remove(oldest); entries = this.hashes.get(hash);
    }
    const group: Group = { id: this.nextGroup++, hash, values: state.values.slice(), used: frame, active: true };
    this.groups.set(group.id, group);
    if (entries) entries.push(group); else this.hashes.set(hash, [group]);
    state.group = group; return state.key = group.id;
  }

  dispose(): void {
    this.disposed = true;
    for (const group of this.groups.values()) group.active = false;
    this.groups.clear(); this.hashes.clear(); this.prototypes.clear();
    this.materials = new WeakMap(); this.references = new WeakMap();
  }

  private remove(group: Group): void {
    group.active = false; this.groups.delete(group.id);
    const entries = this.hashes.get(group.hash)!;
    entries.splice(entries.indexOf(group), 1);
    if (!entries.length) this.hashes.delete(group.hash);
  }

  private prototypeValid(prototype: object): boolean {
    let state = this.prototypes.get(prototype);
    if (!state) {
      const initial = prototypeDefaults.get(prototype)!;
      state = { ...initial, frame: -1, valid: false }; this.prototypes.set(prototype, state);
    }
    if (state.frame === this.frame) return state.valid;
    state.frame = this.frame; state.valid = false;
    const names = Reflect.ownKeys(prototype);
    if (names.length !== state.names.length || Object.getPrototypeOf(prototype) !== state.parent) return false;
    for (const name of names) {
      const actual = Object.getOwnPropertyDescriptor(prototype, name)!, initial = Reflect.get(state.descriptors, name) as PropertyDescriptor | undefined;
      if (!initial || actual.value !== initial.value || actual.get !== initial.get || actual.set !== initial.set) return false;
    }
    return state.valid = true;
  }

  private snapshot(material: Material, schema: Schema, state: MaterialState): boolean {
    for (const prototype of schema.prototypes) if (!this.prototypeValid(prototype)) return false;
    // Frequently animated material properties already need a complete new
    // signature. Use the direct scan until they settle, avoiding maintenance
    // of an incremental cache that cannot be reused in those frames.
    if (state.continuousChanges >= 2) return this.changingSnapshot(material, schema, state);
    // Validate all own names and accessor shapes before reading any values.
    // Counting required names also catches deletions. Short-lived individual
    // descriptor checks avoid the large descriptor map and its escaping
    // objects; they benchmark faster than paired getter/setter lookup calls.
    // The descriptor pass also detects scalar/reference changes. Keeping this
    // on native material objects avoids per-draw Proxy or accessor overhead,
    // while still observing defineProperty/delete and arbitrary direct edits.
    let required = 0, definesSeen = false, changed = !state.valid || state.schema !== schema;
    for (const name of Reflect.ownKeys(material)) {
      if (typeof name !== 'string') return false;
      const slot = schema.names.get(name), descriptor = Object.getOwnPropertyDescriptor(material, name)!;
      if (slot === undefined || !('value' in descriptor)) return false;
      if (slot) {
        const index = slot - 1;
        if (index === schema.defines) definesSeen = true; else required++;
        if (!Object.is(state.fields[index], descriptor.value)) changed = true;
        state.fields[index] = descriptor.value;
      } else if (hooks.has(name) && descriptor.value !== hooks.get(name)) return false;
    }
    if (required !== schema.required) return false;
    if (!definesSeen) {
      if (state.fields[schema.defines] !== undefined) changed = true;
      state.fields[schema.defines] = undefined;
    }
    if (changed && (material.transparent !== false || material.alphaHash !== false || material.visible !== true
      || material.depthWrite !== true || material.depthTest !== true || material.stencilWrite !== false
      || material.blending !== NormalBlending && material.blending !== NoBlending)) return false;
    const nested = state.scratch; nested.length = 0; let nestedIndex = 0;
    for (let index = 0; index < schema.fields.length; index++) {
      const field = schema.fields[index];
      if (field.kind !== 'scalar') {
        if (!this.field(field, state.fields[index], nested)) return false;
        state.offsets[nestedIndex++] = nested.length;
      }
    }
    state.unchanged = !changed && equal(nested, state.nested);
    state.continuousChanges = state.unchanged || !state.valid ? 0 : state.continuousChanges + 1;
    if (!state.unchanged) {
      const values = state.values; values.length = 0; values.push(schema.id);
      nestedIndex = 0; let offset = 0;
      for (let index = 0; index < schema.fields.length; index++) {
        const field = schema.fields[index];
        if (field.kind === 'scalar') { if (!this.field(field, state.fields[index], values)) return false; }
        else { const end = state.offsets[nestedIndex++]; while (offset < end) values.push(nested[offset++]); }
      }
      this.snapshots++;
    }
    state.scratch = state.nested; state.nested = nested; state.valid = true; state.schema = schema;
    return true;
  }

  private changingSnapshot(material: Material, schema: Schema, state: MaterialState): boolean {
    let required = 0;
    for (const name of Reflect.ownKeys(material)) {
      if (typeof name !== 'string') return false;
      const slot = schema.names.get(name), descriptor = Object.getOwnPropertyDescriptor(material, name)!;
      if (slot === undefined || !('value' in descriptor)) return false;
      if (slot && slot - 1 !== schema.defines) required++;
      if (!slot && hooks.has(name) && descriptor.value !== hooks.get(name)) return false;
    }
    if (required !== schema.required || material.transparent !== false || material.alphaHash !== false || material.visible !== true
      || material.depthWrite !== true || material.depthTest !== true || material.stencilWrite !== false
      || material.blending !== NormalBlending && material.blending !== NoBlending) return false;
    const values = state.values, data = material as unknown as Record<string, unknown>;
    values.length = 0; values.push(schema.id);
    for (const field of schema.fields) {
      const value = field.kind === 'defines' && !Object.hasOwn(material, field.name) ? undefined : data[field.name];
      if (!this.field(field, value, values)) return false;
    }
    this.snapshots++;
    state.unchanged = state.group?.active === true && equal(values, state.group.values);
    if (state.unchanged) state.continuousChanges = 0;
    // The incremental slots were not maintained in this path; seed them again
    // after values settle, before allowing any stable-signature reuse.
    state.valid = false;
    return true;
  }

  private field(field: Field, value: unknown, values: Token[]): boolean {
    switch (field.kind) {
        case 'scalar':
          if (field.scalarType && typeof value !== field.scalarType || !this.scalar(value, values)) return false;
          break;
        case 'color': if (!this.components(value, Color.prototype, COLOR_COMPONENTS, values)) return false; break;
        case 'vector2': if (!this.components(value, Vector2.prototype, VECTOR2_COMPONENTS, values)) return false; break;
        case 'euler': if (!this.components(value, Euler.prototype, EULER_COMPONENTS, values)) return false; break;
        case 'texture':
          if (value === null) { values.push(null); break; }
          if (!(value instanceof Texture) || !this.prototypeValid(Texture.prototype)) return false;
          { let owner: object | null = value, descriptor: PropertyDescriptor | undefined;
            while (owner && !descriptor) { descriptor = Object.getOwnPropertyDescriptor(owner, 'updateMatrix'); owner = Object.getPrototypeOf(owner); }
            if (!descriptor || !('value' in descriptor) || descriptor.value !== Texture.prototype.updateMatrix) return false;
          }
          { let reference = this.references.get(value); if (!reference) { reference = this.nextReference++; this.references.set(value, reference); } values.push(reference); }
          break;
        case 'defines': if (!this.defines(value, values)) return false; break;
        case 'planes': if (!this.planes(value, values)) return false; break;
      }
    return true;
  }

  private scalar(value: unknown, values: Token[]): boolean {
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
      || typeof value === 'string' && value.length <= MAX_STRING) { values.push(value); return true; }
    return false;
  }

  private components(value: unknown, prototype: object, names: readonly string[], values: Token[]): boolean {
    if (!value || Object.getPrototypeOf(value) !== prototype || !this.prototypeValid(prototype)) return false;
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !('value' in descriptor) || !this.scalar(descriptor.value, values)) return false;
    }
    // Own overrides of Euler's public accessors change what Three reads.
    if (prototype === Euler.prototype && (Object.hasOwn(value, 'x') || Object.hasOwn(value, 'y') || Object.hasOwn(value, 'z') || Object.hasOwn(value, 'order'))) return false;
    return true;
  }

  private defines(value: unknown, values: Token[]): boolean {
    if (value === undefined) { values.push(null); return true; }
    if (!value || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    const names = Object.getOwnPropertyNames(value);
    if (names.length > MAX_DEFINES || Object.getOwnPropertySymbols(value).length) return false;
    values.push(names.length);
    // Preserve definition order: authored preprocessor text can depend on it.
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
      if (!descriptor.enumerable || !('value' in descriptor) || name.length > MAX_STRING) return false;
      values.push(name); if (!this.scalar(descriptor.value, values)) return false;
    }
    return true;
  }

  private planes(value: unknown, values: Token[]): boolean {
    if (value === null) { values.push(null); return true; }
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_PLANES) return false;
    values.push(value.length);
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index)), plane: unknown = descriptor?.value;
      if (!descriptor || !('value' in descriptor) || !plane || Object.getPrototypeOf(plane) !== Plane.prototype || !this.prototypeValid(Plane.prototype)) return false;
      const normal = Object.getOwnPropertyDescriptor(plane, 'normal'), constant = Object.getOwnPropertyDescriptor(plane, 'constant');
      if (!normal || !('value' in normal) || !constant || !('value' in constant)
        || !this.components(normal.value, Vector3.prototype, VECTOR3_COMPONENTS, values) || !this.scalar(constant.value, values)) return false;
    }
    return true;
  }

  private hash(values: readonly Token[]): number {
    let hash = 2166136261;
    for (const value of values) {
      if (typeof value === 'number') {
        this.float[0] = value; hash = Math.imul(hash ^ this.words[0], 16777619); hash = Math.imul(hash ^ this.words[1], 16777619);
      } else if (typeof value === 'string') {
        hash = Math.imul(hash ^ 1231, 16777619);
        for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
      } else hash = Math.imul(hash ^ (value === null ? 1237 : value ? 1239 : 1249), 16777619);
    }
    return hash >>> 0;
  }
}
