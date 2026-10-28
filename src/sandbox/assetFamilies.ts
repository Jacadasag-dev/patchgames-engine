/** Parameterized, deterministic asset families shared by logic and rendering.
 * Generators return bounded plain geometry; they never return Three.js objects.
 * +Y is up, +Z is forward, X/Z are centred and the lowest point is floor Y=0. */
import type { PhysicsCollider, PhysicsVector } from './physics.ts';
import { validateSurfaceMaterialInput, type SurfaceMaterialInput } from './surfaceMaterials.ts';
import { createVariation, type VariationContext } from './variation.ts';

export interface AssetNumberParameter { kind: 'number'; min: number; max: number; step: number; default?: number }
export interface AssetChoiceParameter { kind: 'choice'; values: readonly { value: string; weight?: number }[]; default?: string }
export type AssetParameter = AssetNumberParameter | AssetChoiceParameter;
export type AssetParameterValue = number | string;
export type AssetParameters = Readonly<Record<string, AssetParameterValue>>;
type ParameterValues<P extends Record<string, AssetParameter>> = { readonly [K in keyof P]: P[K] extends AssetNumberParameter ? number : string };
export interface AssetPart {
  id: string;
  shape: 'box' | 'cylinder' | 'sphere';
  position: PhysicsVector;
  /** Full dimensions. Cylinder X/Z may differ; spheres require equal diameters. */
  size: PhysicsVector;
  yaw?: number;
  color: string;
  /** Visible glow only; fixture light sockets supply actual scene illumination. */
  emissive?: string;
  /** Default 1 when emissive is present. Bounded to 0–10. */
  emissiveIntensity?: number;
  /** Optional editable texture recipe or seeded palette, shared with buildings/terrain. */
  material?: SurfaceMaterialInput;
  /** Default true. False keeps this part's authored colour when its host supplies
   * a fallback material; an explicit per-part material still takes precedence. */
  inheritMaterial?: boolean;
  /** Default true. Decorative pieces should explicitly disable collision. */
  collision?: boolean;
}
export interface AssetSocket {
  id: string;
  tags: string[];
  position: PhysicsVector;
  /** Yaw in radians; +Z is forward. Sockets may sit outside visual bounds. */
  yaw?: number;
}
/** Upright rectangular usable area on a named part's actual upward top plane.
 * Position and yaw are asset-local; width/depth follow the surface's own axes.
 * clearHeight is an optional placement ceiling, not a collision exemption. */
export interface AssetSurface {
  id: string; tags: string[]; partId: string; position: PhysicsVector;
  width: number; depth: number; yaw?: number; clearHeight?: number;
}
export interface AssetGeometry { parts: AssetPart[]; sockets?: AssetSocket[]; surfaces?: AssetSurface[] }
export interface AssetGenerationContext {
  seed: number;
  /** Stateless keyed randomness. Repeating a key repeats its value. */
  random(key: string): number;
  /** General scoped choices, repetition and branching. Identity follows the
   * catalog's seed/family/version/resolved parameters, preserving variant reuse. */
  variation: VariationContext;
}
export interface AssetParameterDefinition {
  id: string;
  version: string;
  parameters: Readonly<Record<string, AssetParameter>>;
}
export interface AssetFamily extends AssetParameterDefinition {
  generate(parameters: AssetParameters, context: AssetGenerationContext): AssetGeometry;
}
export interface AssetManifest {
  schemaVersion: 1;
  familyId: string;
  version: string;
  /** Stable content key including family version, seed and resolved parameters. */
  key: string;
  seed: number;
  parameters: AssetParameters;
  parts: readonly AssetPart[];
  colliders: readonly PhysicsCollider[];
  sockets: readonly AssetSocket[];
  /** Omitted on legacy models; generated support metadata shares model identity. */
  surfaces?: readonly AssetSurface[];
  bounds: { min: PhysicsVector; max: PhysicsVector };
  size: PhysicsVector;
  collisionApproximation: 'exact-primitives' | 'cylinders-use-conservative-boxes';
}
export interface AssetResolveOptions { seed: number; instanceId: string; parameters?: Readonly<Record<string, AssetParameterValue>> }
export interface AssetCatalog {
  resolve(familyId: string, options: AssetResolveOptions): AssetManifest;
  families(): readonly { id: string; version: string; parameters: Readonly<Record<string, AssetParameter>> }[];
  inspection(): { families: number; cachedVariants: number; maxVariants: number; generated: number; hits: number; evicted: number };
  clear(): void;
}
export const ASSET_FAMILY_LIMITS = Object.freeze({ families: 128, parameters: 24, choices: 32, parts: 128,
  colliders: 96, sockets: 32, surfaces: 32, variants: 512, dimension: 128, socketDistance: 256 });
const trustedManifests = new WeakSet<AssetManifest>();
const trustedParameterDefinitions = new WeakSet<AssetParameterDefinition>();
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const vector = (value: unknown): value is PhysicsVector => !!value && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.keys(value).length === 3
  && finite((value as PhysicsVector).x) && finite((value as PhysicsVector).y) && finite((value as PhysicsVector).z);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const entry of Object.values(value)) freeze(entry); Object.freeze(value); }
  return value;
}
// Plain loops and the default code-unit key sort: the sandbox interpreter
// pays for every callback and intermediate array, and geometry keys are long.
function canonical(value: unknown): string {
  if (Array.isArray(value)) { let out = '['; for (let i = 0; i < value.length; i++) out += (i ? ',' : '') + canonical(value[i]); return out + ']'; }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>, names = Object.keys(record).sort(); let out = '{';
    for (let i = 0; i < names.length; i++) out += (i ? ',' : '') + JSON.stringify(names[i]) + ':' + canonical(record[names[i]]);
    return out + '}';
  }
  return JSON.stringify(value) ?? 'null';
}
function sameDerived(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Number.isFinite(a) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every(key => Object.hasOwn(b, key) && sameDerived((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
function hash(text: string): number { let n = 2166136261; for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619); n ^= n >>> 16; n = Math.imul(n, 0x7feb352d); return (n ^ n >>> 15) >>> 0; }
// FNV state after the `asset:` prefix of the second key half.
const ASSET_PREFIX_STATE = (() => { let n = 2166136261; for (const c of 'asset:') n = Math.imul(n ^ c.charCodeAt(0), 16777619); return n; })();
const avalanche = (n: number) => { n ^= n >>> 16; n = Math.imul(n, 0x7feb352d); return (n ^ n >>> 15) >>> 0; };
/** Equal to hash(text) and hash(`asset:${text}`), read in one pass: geometry
 * keys are long and the sandbox interpreter pays per character. */
function fingerprint(text: string): string {
  const imul = Math.imul, length = text.length; let a = 2166136261, b = ASSET_PREFIX_STATE;
  for (let i = 0; i < length; i++) { const c = text.charCodeAt(i); a = imul(a ^ c, 16777619); b = imul(b ^ c, 16777619); }
  return avalanche(a).toString(16).padStart(8, '0') + avalanche(b).toString(16).padStart(8, '0');
}
function keyed(seed: string, key: string): number { return hash(`${seed}:${key}`) / 4294967296; }
function plain(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${name} must be plain data.`);
}
function keys(value: Record<string, unknown>, allowed: string[], name: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${name} contains unsupported fields.`);
}
function numberValue(parameter: AssetNumberParameter, value: unknown, name: string): number {
  if (!finite(value) || value < parameter.min - 1e-9 || value > parameter.max + 1e-9) throw new Error(`Asset parameter ${name} is outside its numeric range.`);
  const steps = (value - parameter.min) / parameter.step;
  if (Math.abs(steps - Math.round(steps)) > 1e-6) throw new Error(`Asset parameter ${name} must follow its ${parameter.step} step.`);
  return Number((parameter.min + Math.round(steps) * parameter.step).toPrecision(12));
}
function copyParameter(value: AssetParameter, name: string): AssetParameter {
  plain(value, `Asset parameter ${name}`);
  if (value.kind === 'number') {
    keys(value, ['kind', 'min', 'max', 'step', 'default'], name);
    if (![value.min, value.max, value.step].every(finite) || value.min < -10000 || value.max > 10000 || value.max < value.min || value.step <= 0
      || (value.max - value.min) / value.step > 10000) throw new Error(`Asset parameter ${name} has invalid numeric bounds.`);
    const copy: AssetNumberParameter = { kind: 'number', min: value.min, max: value.max, step: value.step };
    if (value.default !== undefined) copy.default = numberValue(copy, value.default, name);
    return copy;
  }
  if (value.kind !== 'choice') throw new Error(`Asset parameter ${name} needs number or choice kind.`);
  keys(value, ['kind', 'values', 'default'], name);
  if (!Array.isArray(value.values) || !value.values.length || value.values.length > ASSET_FAMILY_LIMITS.choices) throw new Error(`Asset parameter ${name} has an invalid choice count.`);
  const seen = new Set<string>(), values = Array.from(value.values).map(choice => {
    plain(choice, `Asset choice ${name}`); keys(choice, ['value', 'weight'], name);
    if (!id(choice.value) || seen.has(choice.value) || choice.weight !== undefined && (!finite(choice.weight) || choice.weight <= 0 || choice.weight > 1e6)) throw new Error(`Asset parameter ${name} has invalid weighted choices.`);
    seen.add(choice.value); return { value: choice.value, weight: choice.weight ?? 1 };
  });
  if (value.default !== undefined && !seen.has(value.default)) throw new Error(`Asset parameter ${name} has an unknown default.`);
  return { kind: 'choice', values, ...(value.default !== undefined ? { default: value.default } : {}) };
}

/** Shared bounded parameter schema for geometry, area and other authored families. */
export function defineAssetParameters(definition: AssetParameterDefinition): AssetParameterDefinition {
  if (!definition || !id(definition.id) || !id(definition.version)) throw new Error('Asset parameters need stable id and version.');
  plain(definition.parameters, 'Asset parameters');
  if (Object.keys(definition.parameters).length > ASSET_FAMILY_LIMITS.parameters) throw new Error('Too many asset parameters.');
  const parameters = Object.fromEntries(Object.entries(definition.parameters).sort(([a], [b]) => compare(a, b)).map(([name, value]) => {
    if (!id(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) throw new Error('Invalid asset parameter name.');
    return [name, copyParameter(value, name)];
  }));
  const result = Object.freeze({ id: definition.id, version: definition.version, parameters: freeze(parameters) });
  trustedParameterDefinitions.add(result); return result;
}

/** Stateless parameter selection shared by asset and area families. Explicit
 * values win over defaults; remaining parameters use independent keyed rolls. */
export function resolveAssetParameters(definition: AssetParameterDefinition, request: AssetResolveOptions): AssetParameters {
  const family = trustedParameterDefinitions.has(definition) ? definition : defineAssetParameters(definition);
  if (!request || !Number.isInteger(request.seed) || request.seed < 0 || request.seed > 0xffffffff || !id(request.instanceId)) throw new Error('Asset resolve needs an unsigned seed and stable instanceId.');
  const supplied = request.parameters ?? {}; plain(supplied, 'Asset parameter values');
  for (const name of Object.keys(supplied)) if (!Object.hasOwn(family.parameters, name)) throw new Error(`Unknown asset parameter: ${family.id}.${name}`);
  const parameters: Record<string, AssetParameterValue> = {};
  for (const [name, parameter] of Object.entries(family.parameters)) {
    const suppliedValue = Object.hasOwn(supplied, name) ? supplied[name] : parameter.default;
    const roll = keyed(`${request.seed}:${family.id}:${family.version}:${request.instanceId}`, name);
    if (parameter.kind === 'number') {
      parameters[name] = numberValue(parameter, suppliedValue !== undefined ? suppliedValue : parameter.min + Math.floor(roll * (Math.floor((parameter.max - parameter.min) / parameter.step + 1e-9) + 1)) * parameter.step, name);
    } else {
      if (suppliedValue !== undefined) {
        if (typeof suppliedValue !== 'string' || !parameter.values.some(choice => choice.value === suppliedValue)) throw new Error(`Unknown asset choice: ${family.id}.${name}`);
        parameters[name] = suppliedValue;
      } else {
        let remaining = roll * parameter.values.reduce((total, choice) => total + (choice.weight ?? 1), 0);
        parameters[name] = parameter.values.at(-1)!.value;
        for (const choice of parameter.values) { remaining -= choice.weight ?? 1; if (remaining < 0) { parameters[name] = choice.value; break; } }
      }
    }
  }
  return freeze(parameters);
}

/** Parameters omitted at resolve are sampled independently unless a default is
 * declared. Generators can reject cross-parameter combinations with an error.
 * Use only the supplied keyed random source; bump version after generator edits. */
export function defineAssetFamily<const P extends Record<string, AssetParameter>>(definition: {
  id: string; version: string; parameters: P;
  generate(parameters: ParameterValues<P>, context: AssetGenerationContext): AssetGeometry;
}): AssetFamily {
  if (!definition || typeof definition.generate !== 'function') throw new Error('Asset family needs stable id, version and generate function.');
  const schema = defineAssetParameters(definition), generate = definition.generate;
  const family = Object.freeze({ ...schema,
    generate: (values: AssetParameters, context: AssetGenerationContext) => generate(values as ParameterValues<P>, context) });
  trustedParameterDefinitions.add(family); return family;
}

/** Bounds of a validated part, including the exact collision approximation used
 * by asset compilation. Used when assembling/recentring groups of the same parts. */
export function assetPartBounds(part: AssetPart): { min: PhysicsVector; max: PhysicsVector } {
  const yaw = part.yaw ?? 0, c = Math.cos(yaw), s = Math.sin(yaw), collision = part.collision !== false;
  const extent = part.shape === 'sphere' ? { x: part.size.x / 2, y: part.size.y / 2, z: part.size.z / 2 }
    : part.shape === 'cylinder' && !collision ? { x: Math.hypot(part.size.x * c, part.size.z * s) / 2, y: part.size.y / 2, z: Math.hypot(part.size.x * s, part.size.z * c) / 2 }
    : { x: (Math.abs(c) * part.size.x + Math.abs(s) * part.size.z) / 2, y: part.size.y / 2, z: (Math.abs(s) * part.size.x + Math.abs(c) * part.size.z) / 2 };
  return { min: { x: part.position.x - extent.x, y: part.position.y - extent.y, z: part.position.z - extent.z },
    max: { x: part.position.x + extent.x, y: part.position.y + extent.y, z: part.position.z + extent.z } };
}

function compileGeometry(familyId: string, version: string, seed: number, parameters: AssetParameters, input: AssetGeometry): AssetManifest {
  plain(input, 'Asset geometry'); keys(input, ['parts', 'sockets', 'surfaces'], 'Asset geometry');
  if (!Array.isArray(input.parts) || !input.parts.length || input.parts.length > ASSET_FAMILY_LIMITS.parts
    || input.sockets !== undefined && (!Array.isArray(input.sockets) || input.sockets.length > ASSET_FAMILY_LIMITS.sockets)
    || input.surfaces !== undefined && (!Array.isArray(input.surfaces) || input.surfaces.length > ASSET_FAMILY_LIMITS.surfaces)) throw new Error('Asset geometry exceeds part/socket/surface limits.');
  const names = new Set<string>(), colliders: PhysicsCollider[] = [];
  let approximate = false;
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  const parts = [...input.parts].sort((a, b) => compare(String(a?.id), String(b?.id))).map(part => {
    plain(part, 'Asset part'); keys(part, ['id', 'shape', 'position', 'size', 'yaw', 'color', 'emissive', 'emissiveIntensity', 'material', 'inheritMaterial', 'collision'], 'Asset part');
    if (!id(part.id) || names.has(part.id) || !['box', 'cylinder', 'sphere'].includes(part.shape)
      || !vector(part.position) || !vector(part.size) || Object.values(part.position).some(n => Math.abs(n) > 128)
      || Object.values(part.size).some(n => n <= 0 || n > ASSET_FAMILY_LIMITS.dimension)
      || !finite(part.yaw ?? 0) || typeof part.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(part.color)
      || part.emissive !== undefined && (typeof part.emissive !== 'string' || !/^#[0-9a-f]{6}$/i.test(part.emissive))
      || part.emissiveIntensity !== undefined && (part.emissive === undefined || !finite(part.emissiveIntensity) || part.emissiveIntensity < 0 || part.emissiveIntensity > 10)
      || part.collision !== undefined && typeof part.collision !== 'boolean'
      || part.inheritMaterial !== undefined && typeof part.inheritMaterial !== 'boolean') throw new Error(`Malformed asset part: ${String(part.id)}`);
    if (part.shape === 'sphere' && (Math.abs(part.size.x - part.size.y) > 1e-7 || Math.abs(part.size.x - part.size.z) > 1e-7)) throw new Error(`Sphere ${part.id} requires equal diameters.`);
    names.add(part.id);
    const yaw = part.yaw ?? 0, collision = part.collision !== false, bounds = assetPartBounds(part);
    for (const axis of ['x', 'y', 'z'] as const) { min[axis] = Math.min(min[axis], bounds.min[axis]); max[axis] = Math.max(max[axis], bounds.max[axis]); }
    if (collision) {
      if (Object.values(part.size).some(n => n < .04)) throw new Error(`Collision part ${part.id} must be at least .04m thick.`);
      approximate ||= part.shape === 'cylinder';
      colliders.push({ shape: part.shape === 'sphere' ? { kind: 'ball', radius: part.size.x / 2 }
        : { kind: 'box', halfExtents: { x: part.size.x / 2, y: part.size.y / 2, z: part.size.z / 2 } },
      position: { ...part.position }, rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, friction: .8 });
    }
    return { id: part.id, shape: part.shape, position: { ...part.position }, size: { ...part.size }, yaw, color: part.color.toLowerCase(), collision,
      ...(part.emissive === undefined ? {} : { emissive: part.emissive.toLowerCase(), emissiveIntensity: part.emissiveIntensity ?? 1 }),
      ...(part.inheritMaterial === undefined ? {} : { inheritMaterial: part.inheritMaterial }),
      ...(part.material === undefined ? {} : { material: validateSurfaceMaterialInput(part.material) }) };
  }).sort((a, b) => compare(a.id, b.id));
  if (colliders.length > ASSET_FAMILY_LIMITS.colliders) throw new Error('Asset exceeds compound collider budget.');
  const size = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
  if (Math.abs(min.y) > 1e-6 || Math.abs(min.x + max.x) > 1e-6 || Math.abs(min.z + max.z) > 1e-6
    || Object.values(size).some(n => n > ASSET_FAMILY_LIMITS.dimension)) throw new Error('Asset geometry must be centred in X/Z, rest on Y=0 and fit the size budget.');
  const socketNames = new Set<string>();
  const sockets = Array.from(input.sockets ?? []).map(socket => {
    plain(socket, 'Asset socket'); keys(socket, ['id', 'tags', 'position', 'yaw'], 'Asset socket');
    if (!id(socket.id) || socketNames.has(socket.id) || !vector(socket.position) || Object.values(socket.position).some(n => Math.abs(n) > ASSET_FAMILY_LIMITS.socketDistance)
      || !finite(socket.yaw ?? 0) || !Array.isArray(socket.tags) || socket.tags.length > 12 || socket.tags.some(tag => !id(tag))) throw new Error(`Malformed asset socket: ${String(socket.id)}`);
    socketNames.add(socket.id);
    return { id: socket.id, tags: [...new Set(socket.tags)].sort(compare), position: { ...socket.position }, yaw: socket.yaw ?? 0 };
  }).sort((a, b) => compare(a.id, b.id));
  const surfaceNames = new Set<string>();
  const surfaces = input.surfaces === undefined ? undefined : Array.from(input.surfaces, surface => {
    plain(surface, 'Asset surface'); keys(surface, ['id', 'tags', 'partId', 'position', 'width', 'depth', 'yaw', 'clearHeight'], 'Asset surface');
    if (!id(surface.id) || surfaceNames.has(surface.id) || !id(surface.partId) || !vector(surface.position)
      || Object.values(surface.position).some(n => Math.abs(n) > ASSET_FAMILY_LIMITS.dimension)
      || !finite(surface.width) || surface.width <= 0 || surface.width > ASSET_FAMILY_LIMITS.dimension
      || !finite(surface.depth) || surface.depth <= 0 || surface.depth > ASSET_FAMILY_LIMITS.dimension
      || surface.yaw !== undefined && !finite(surface.yaw)
      || surface.clearHeight !== undefined && (!finite(surface.clearHeight) || surface.clearHeight < 0 || surface.clearHeight > ASSET_FAMILY_LIMITS.dimension)
      || !Array.isArray(surface.tags) || surface.tags.length > 12 || Array.from(surface.tags).some(tag => !id(tag))) throw new Error(`Malformed asset surface: ${String(surface.id)}`);
    const part = parts.find(part => part.id === surface.partId);
    if (!part || part.shape === 'sphere' || Math.abs(surface.position.y - part.position.y - part.size.y / 2) > 1e-6) throw new Error(`Surface ${surface.id} must rest on its named box/cylinder top plane.`);
    const yaw = surface.yaw ?? 0, c = Math.cos(yaw), s = Math.sin(yaw), pc = Math.cos(part.yaw), ps = Math.sin(part.yaw);
    for (const x of [-surface.width / 2, surface.width / 2]) for (const z of [-surface.depth / 2, surface.depth / 2]) {
      const dx = surface.position.x + c * x + s * z - part.position.x, dz = surface.position.z - s * x + c * z - part.position.z;
      const px = pc * dx - ps * dz, pz = ps * dx + pc * dz;
      const supported = part.shape === 'box' ? Math.abs(px) <= part.size.x / 2 + 1e-6 && Math.abs(pz) <= part.size.z / 2 + 1e-6
        : (px / (part.size.x / 2)) ** 2 + (pz / (part.size.z / 2)) ** 2 <= 1 + 1e-6;
      if (!supported) throw new Error(`Surface ${surface.id} extends outside its named part's actual top footprint.`);
    }
    surfaceNames.add(surface.id);
    return { id: surface.id, tags: [...new Set(surface.tags)].sort(compare), partId: surface.partId, position: { ...surface.position },
      width: surface.width, depth: surface.depth, yaw, ...(surface.clearHeight === undefined ? {} : { clearHeight: surface.clearHeight }) };
  }).sort((a, b) => compare(a.id, b.id));
  const geometryKey = canonical({ familyId, version, seed, parameters, parts, sockets, ...(surfaces === undefined ? {} : { surfaces }) });
  const manifest: AssetManifest = freeze({ schemaVersion: 1, familyId, version, key: `asset-v1-${fingerprint(geometryKey)}`, seed,
    parameters: { ...parameters }, parts, colliders, sockets, ...(surfaces === undefined ? {} : { surfaces }), bounds: { min, max }, size,
    collisionApproximation: approximate ? 'cylinders-use-conservative-boxes' : 'exact-primitives' });
  trustedManifests.add(manifest); return manifest;
}

/** Revalidate a serialized manifest and derive its collision again. Caller-supplied
 * collider arrays, sizes or keys are never trusted over the shared geometry. */
export function validateAssetManifest(input: AssetManifest): AssetManifest {
  if (trustedManifests.has(input)) return input;
  plain(input, 'Asset manifest');
  keys(input, ['schemaVersion', 'familyId', 'version', 'key', 'seed', 'parameters', 'parts', 'colliders', 'sockets', 'surfaces', 'bounds', 'size', 'collisionApproximation'], 'Asset manifest');
  if (input.schemaVersion !== 1 || !id(input.familyId) || !id(input.version) || !Number.isInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff) throw new Error('Invalid asset manifest identity.');
  plain(input.parameters, 'Asset resolved parameters');
  if (Object.keys(input.parameters).length > ASSET_FAMILY_LIMITS.parameters || Object.entries(input.parameters).some(([name, value]) => !id(name) || !(finite(value) || typeof value === 'string' && value.length <= 96))) throw new Error('Invalid resolved asset parameters.');
  const expected = compileGeometry(input.familyId, input.version, input.seed, input.parameters, { parts: input.parts as AssetPart[], sockets: input.sockets as AssetSocket[],
    ...(input.surfaces === undefined ? {} : { surfaces: input.surfaces as AssetSurface[] }) });
  if (!vector(input.size) || !input.bounds || !vector(input.bounds.min) || !vector(input.bounds.max)
    || !Array.isArray(input.colliders) || input.colliders.length !== expected.colliders.length) throw new Error('Invalid asset manifest bounds or colliders.');
  // Bound and structurally check every supplied collider before serialization.
  for (const collider of input.colliders) {
    plain(collider, 'Asset collider'); keys(collider, ['shape', 'position', 'rotation', 'friction'], 'Asset collider');
    plain(collider.shape, 'Asset collider shape');
    if (collider.shape.kind === 'box') {
      keys(collider.shape, ['kind', 'halfExtents'], 'Asset collider shape');
      if (!vector(collider.shape.halfExtents)) throw new Error('Invalid asset box collider.');
    } else if (collider.shape.kind === 'ball') {
      keys(collider.shape, ['kind', 'radius'], 'Asset collider shape');
      if (!finite(collider.shape.radius)) throw new Error('Invalid asset ball collider.');
    } else throw new Error('Unsupported asset collider shape.');
    if (!vector(collider.position)) throw new Error('Invalid asset collider position.');
    plain(collider.rotation, 'Asset collider rotation'); keys(collider.rotation, ['x', 'y', 'z', 'w'], 'Asset collider rotation');
    if (Object.keys(collider.rotation).length !== 4 || !Object.values(collider.rotation).every(finite) || !finite(collider.friction)) throw new Error('Invalid asset collider rotation or friction.');
  }
  // Engine libm implementations may differ in the last bit of derived trig.
  // Authored geometry/key remain exact; accepted derived fields are regenerated.
  if (input.key !== expected.key || !sameDerived(input.size, expected.size) || !sameDerived({ min: input.bounds.min, max: input.bounds.max }, expected.bounds)
    || !sameDerived(input.colliders, expected.colliders) || input.collisionApproximation !== expected.collisionApproximation) throw new Error('Asset manifest geometry, size, collision or key has been modified.');
  return expected;
}

/** Place the same compound collision used by the model. Position is its floor
 * origin, not the centre of its envelope. Cylinders remain conservative boxes. */
export function transformAssetColliders(input: AssetManifest, position: PhysicsVector, yaw = 0): PhysicsCollider[] {
  const manifest = validateAssetManifest(input);
  if (!vector(position) || !finite(yaw)) throw new Error('Asset placement needs a finite position and yaw.');
  const c = Math.cos(yaw), s = Math.sin(yaw), sy = Math.sin(yaw / 2), cy = Math.cos(yaw / 2);
  return manifest.colliders.map(collider => {
    const p = collider.position!, q = collider.rotation!;
    const transformed = { x: position.x + c * p.x + s * p.z, y: position.y + p.y, z: position.z - s * p.x + c * p.z };
    if (Object.values(transformed).some(n => Math.abs(n) > 10000)) throw new Error('Asset placement exceeds native world bounds.');
    return { shape: collider.shape.kind === 'ball' ? { kind: 'ball', radius: collider.shape.radius }
      : { kind: 'box', halfExtents: { ...(collider.shape as { kind: 'box'; halfExtents: PhysicsVector }).halfExtents } },
    position: transformed, rotation: { x: cy * q.x + sy * q.z, y: cy * q.y + sy * q.w, z: cy * q.z - sy * q.x, w: cy * q.w - sy * q.y }, friction: collider.friction };
  });
}

/** The instance ID chooses parameter variants; geometry generation receives only
 * seed and parameters, so equal variants share cache entries across placements.
 * Cache eviction never changes regenerated output. */
export function createAssetCatalog(families: readonly AssetFamily[], options: { maxVariants?: number } = {}): AssetCatalog {
  const maxVariants = options.maxVariants ?? 128;
  if (!Number.isInteger(maxVariants) || maxVariants < 1 || maxVariants > ASSET_FAMILY_LIMITS.variants || families.length > ASSET_FAMILY_LIMITS.families) throw new Error('Asset catalog exceeds family/variant limits.');
  const definitions = new Map<string, AssetFamily>();
  for (const source of families) {
    const family = defineAssetFamily(source);
    if (definitions.has(family.id)) throw new Error(`Duplicate asset family: ${family.id}`);
    definitions.set(family.id, family);
  }
  const cache = new Map<string, AssetManifest>(); let generated = 0, hits = 0, evicted = 0;
  return {
    resolve(familyId, request) {
      const family = definitions.get(familyId); if (!family) throw new Error(`Unknown asset family: ${familyId}`);
      const parameters = resolveAssetParameters(family, request);
      const cacheKey = canonical([family.id, family.version, request.seed, parameters]);
      const cached = cache.get(cacheKey);
      if (cached) { hits++; cache.delete(cacheKey); cache.set(cacheKey, cached); return cached; }
      const stable = freeze(parameters), randomSeed = `${request.seed}:${family.id}:${family.version}:${canonical(stable)}`;
      let geometry: AssetGeometry;
      try { geometry = family.generate(stable, Object.freeze({ seed: request.seed,
        variation: createVariation({ seed: request.seed, id: family.id, version: family.version, instanceId: canonical(stable) }),
        random: (key: string) => {
        if (!id(key)) throw new Error('Asset random keys must be stable short identifiers.'); return keyed(randomSeed, key);
      } })); } catch (error) { throw new Error(`Asset family ${family.id} rejected parameters: ${error instanceof Error ? error.message : String(error)}`); }
      let result: AssetManifest;
      try { result = compileGeometry(family.id, family.version, request.seed, stable, geometry); }
      catch (error) { throw new Error(`Asset family ${family.id}: ${error instanceof Error ? error.message : String(error)}`); }
      generated++;
      cache.set(cacheKey, result);
      if (cache.size > maxVariants) { cache.delete(cache.keys().next().value!); evicted++; }
      return result;
    },
    families: () => freeze([...definitions.values()].map(({ id, version, parameters }) => ({ id, version, parameters })).sort((a, b) => compare(a.id, b.id))),
    inspection: () => ({ families: definitions.size, cachedVariants: cache.size, maxVariants, generated, hits, evicted }),
    clear: () => cache.clear(),
  };
}
