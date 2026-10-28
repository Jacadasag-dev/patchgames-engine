/** Seeded arrangements on verified, upward asset surfaces. Choices are made
 * once; failed placement never changes a selected composition or family. */
import { ASSET_FAMILY_LIMITS, assetPartBounds, createAssetCatalog, defineAssetFamily, validateAssetManifest,
  type AssetManifest, type AssetPart, type AssetSurface } from './assetFamilies.ts';
import type { AssetGroup, AssetGroupCatalog, AssetGroupInstance } from './assetGroups.ts';
import type { PhysicsVector } from './physics.ts';
import { spatialAngle as angle, spatialCoordinate as coordinate, transformSpatialPoint } from './spatial.ts';
import { validateSurfaceMaterialInput, type SurfaceMaterialInput } from './surfaceMaterials.ts';

export interface AssetDressingChoice {
  id: string; weight?: number; family: string; parameters?: Record<string, string | number>; material?: SurfaceMaterialInput;
}
export interface AssetDressingItem {
  id: string; choices: readonly AssetDressingChoice[]; probability?: number; count?: number | [number, number]; required?: number;
  /** Surface-local normalized coordinates: -.5..+.5 spans its width/depth. */
  anchors?: readonly { id: string; x: number; z: number }[];
  zone?: { x: number; z: number; width: number; depth: number };
  /** Normalized maximum displacement from an anchor; defaults to zero. */
  jitter?: { x: number; z: number };
  /** Radians relative to the support surface; an interval samples per item. */
  yaw?: number | [number, number];
  /** Decorations are noncolliding by default. True preserves model collision. */
  collision?: boolean;
}
export interface AssetDressingArrangement {
  id: string; surface: string | { tag: string };
  variants: readonly { id: string; weight?: number; items: readonly AssetDressingItem[] }[];
}
export interface AssetDressingRequest {
  model: AssetManifest; seed: number; instanceId: string; arrangements: readonly AssetDressingArrangement[];
  /** Candidate poses per item, 1..64; defaults to 24. */
  maxAttempts?: number;
}
export interface AssetDressingInstance extends AssetGroupInstance {
  arrangementId?: string; variantId?: string; surfaceId?: string; itemId?: string; choiceId?: string;
  /** Original family identity before collision/material presentation overrides. */
  source?: Pick<AssetManifest, 'familyId' | 'version' | 'key' | 'parameters'>;
}
export interface AssetDressingRecord {
  id: string; surfaceId: string; variantId: string; requested: number; placed: number;
}
export interface AssetDressingIssue {
  code: string; message: string; arrangementId?: string; surfaceId?: string; itemId?: string; instanceId?: string;
}
export interface AssetDressingResult extends AssetGroup {
  instances: readonly AssetDressingInstance[]; arrangements: readonly AssetDressingRecord[];
  diagnostics: { valid: boolean; issues: readonly AssetDressingIssue[]; requested: number; placed: number; attempted: number; omittedOptional: number };
}
export const ASSET_DRESSING_LIMITS = Object.freeze({ arrangements: 8, records: 32, variants: 16, items: 16, choices: 16,
  anchors: 32, instances: 33, parts: ASSET_FAMILY_LIMITS.parts, attempts: 64, totalAttempts: 2048 });
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value);
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function keys(value: unknown, allowed: string[], name: string): asserts value is Record<string, unknown> {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${name} needs supported plain fields.`);
}
function hash(text: string): number {
  let result = 2166136261; for (let i = 0; i < text.length; i++) result = Math.imul(result ^ text.charCodeAt(i), 16777619);
  result ^= result >>> 16; result = Math.imul(result, 0x7feb352d); result ^= result >>> 15; result = Math.imul(result, 0x846ca68b); return (result ^ result >>> 16) >>> 0;
}
const random = (seed: number, key: string) => hash(`${seed}:${key}`) / 4294967296;
const stableId = (value: string) => value.length <= 96 ? value : `${value.slice(0, 80)}:${hash(value).toString(16)}`;
/** Preserve authored IDs and familiar generated names unless they collide.
 * Distinct numbered candidates guarantee bounded resolution even if a parent
 * deliberately occupies the first hashed alternatives. */
function availableId(preferred: string, identity: readonly (string | number)[], used: Set<string>): string {
  const first = stableId(preferred);
  if (!used.has(first)) { used.add(first); return first; }
  const prefix = `${first.slice(0, 64)}:${hash(JSON.stringify(identity)).toString(16)}`;
  for (let attempt = 0; attempt <= used.size; attempt++) {
    const candidate = `${prefix}:${attempt}`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
  throw new Error('Dressing could not allocate a bounded unique identity.');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}` : JSON.stringify(value) ?? 'null';
function list<T>(input: unknown, limit: number, name: string, copy: (entry: unknown) => T & { id: string }, empty = false): T[] {
  if (!Array.isArray(input) || input.length > limit || !empty && !input.length) throw new Error(`${name} has an invalid bounded count.`);
  const seen = new Set<string>();
  return Array.from(input, entry => { const result = copy(entry); if (!id(result.id) || seen.has(result.id)) throw new Error(`${name} needs unique stable IDs.`); seen.add(result.id); return result; })
    .sort((a, b) => compare((a as T & { id: string }).id, (b as T & { id: string }).id));
}
function weight(input: unknown): number {
  if (input !== undefined && (!finite(input) || input <= 0 || input > 1e6)) throw new Error('Dressing weights must be positive and bounded.'); return input === undefined ? 1 : input as number;
}
function range(input: unknown, fallback: number, low: number, high: number, integer = false): [number, number] {
  const pair = input === undefined ? [fallback, fallback] : Array.isArray(input) ? input : [input, input];
  if (pair.length !== 2 || ![pair[0], pair[1]].every(value => finite(value) && value >= low && value <= high && (!integer || Number.isInteger(value))) || pair[0] > pair[1])
    throw new Error('Dressing ranges must contain two ordered finite bounded values.');
  return [pair[0], pair[1]];
}
function point(input: unknown, maximum: number, positive = false): { x: number; z: number } {
  keys(input, ['x', 'z'], 'Dressing point');
  if (![input.x, input.z].every(value => finite(value) && (positive ? value >= 0 : value >= -maximum) && value <= maximum)) throw new Error('Dressing point exceeds normalized surface coordinates.');
  return { x: input.x as number, z: input.z as number };
}
/** Validate all variants, including unselected and explicitly empty states. */
export function validateAssetDressingArrangements(input: readonly AssetDressingArrangement[]): AssetDressingArrangement[] {
  return list(input, ASSET_DRESSING_LIMITS.arrangements, 'Dressing arrangements', value => {
    keys(value, ['id', 'surface', 'variants'], 'Dressing arrangement');
    let surface: AssetDressingArrangement['surface'];
    if (typeof value.surface === 'string' && id(value.surface)) surface = value.surface;
    else { keys(value.surface, ['tag'], 'Dressing surface selector'); if (!id(value.surface.tag)) throw new Error('Dressing surface tag needs a stable ID.'); surface = { tag: value.surface.tag }; }
    return { id: value.id as string, surface, variants: list(value.variants, ASSET_DRESSING_LIMITS.variants, 'Dressing variants', variant => {
      keys(variant, ['id', 'weight', 'items'], 'Dressing variant');
      return { id: variant.id as string, weight: weight(variant.weight), items: list(variant.items, ASSET_DRESSING_LIMITS.items, 'Dressing items', item => {
        keys(item, ['id', 'choices', 'probability', 'count', 'required', 'anchors', 'zone', 'jitter', 'yaw', 'collision'], 'Dressing item');
        const count = range(item.count, 1, 0, 32, true), yaw = range(item.yaw, 0, -Math.PI * 2, Math.PI * 2);
        if (item.probability !== undefined && (!finite(item.probability) || item.probability < 0 || item.probability > 1)
          || item.required !== undefined && (!Number.isInteger(item.required) || (item.required as number) < 0 || (item.required as number) > count[0])
          || item.collision !== undefined && typeof item.collision !== 'boolean') throw new Error('Dressing probability, required count or collision flag is invalid.');
        let zone: AssetDressingItem['zone'];
        if (item.zone !== undefined) {
          keys(item.zone, ['x', 'z', 'width', 'depth'], 'Dressing zone');
          const value = item.zone;
          if (![value.x, value.z, value.width, value.depth].every(finite) || (value.width as number) <= 0 || (value.depth as number) <= 0
            || Math.abs(value.x as number) + (value.width as number) / 2 > .5 + 1e-9 || Math.abs(value.z as number) + (value.depth as number) / 2 > .5 + 1e-9)
            throw new Error('Dressing zone must fit within the normalized surface.');
          zone = { x: value.x as number, z: value.z as number, width: value.width as number, depth: value.depth as number };
        }
        return { id: item.id as string, count, yaw, probability: item.probability === undefined ? 1 : item.probability as number,
          ...(item.required === undefined ? {} : { required: item.required as number }), collision: item.collision === true,
          ...(zone ? { zone } : {}), ...(item.jitter === undefined ? {} : { jitter: point(item.jitter, .5, true) }),
          ...(item.anchors === undefined ? {} : { anchors: list(item.anchors, ASSET_DRESSING_LIMITS.anchors, 'Dressing anchors', anchor => {
            keys(anchor, ['id', 'x', 'z'], 'Dressing anchor'); return { id: anchor.id as string, ...point({ x: anchor.x, z: anchor.z }, .5) };
          }) }),
          choices: list(item.choices, ASSET_DRESSING_LIMITS.choices, 'Dressing choices', choice => {
            keys(choice, ['id', 'weight', 'family', 'parameters', 'material'], 'Dressing choice');
            if (!id(choice.family)) throw new Error('Dressing choices require family IDs.');
            let parameters: Record<string, string | number> | undefined;
            if (choice.parameters !== undefined) {
              if (!plain(choice.parameters) || Object.keys(choice.parameters).length > 24 || Object.entries(choice.parameters).some(([name, value]) => !id(name)
                || ['__proto__', 'prototype', 'constructor'].includes(name) || !(finite(value) || typeof value === 'string' && value.length <= 96))) throw new Error('Dressing parameters must be a bounded dictionary.');
              parameters = { ...choice.parameters } as Record<string, string | number>;
            }
            return { id: choice.id as string, family: choice.family, weight: weight(choice.weight), ...(parameters ? { parameters } : {}),
              ...(choice.material === undefined ? {} : { material: validateSurfaceMaterialInput(choice.material as SurfaceMaterialInput) }) };
          }) };
      }, true) };
    }) };
  }, true);
}

function choose<T extends { weight?: number }>(choices: readonly T[], roll: number): T {
  let left = roll * choices.reduce((sum, item) => sum + (item.weight ?? 1), 0);
  for (const choice of choices) { left -= choice.weight ?? 1; if (left < 0) return choice; } return choices.at(-1)!;
}
function posedPart(instance: AssetGroupInstance, part: AssetPart): AssetPart {
  const position = transformSpatialPoint(part.position, instance.position, instance.yaw);
  return { ...part, position: { ...position, y: coordinate(instance.position.y + part.position.y) }, yaw: angle(instance.yaw + (part.yaw ?? 0)) };
}
/** Primitive-based overlap, including noncolliding visual parts. Cylinders use
 * their conservative oriented boxes, matching family collision approximation. */
function overlaps(a: AssetPart, b: AssetPart): boolean {
  const tolerance = 1e-6;
  if (Math.abs(a.position.y - b.position.y) >= (a.size.y + b.size.y) / 2 - tolerance) return false;
  if (a.shape === 'sphere' || b.shape === 'sphere') {
    const sphere = a.shape === 'sphere' ? a : b, other = sphere === a ? b : a;
    const dx = sphere.position.x - other.position.x, dy = sphere.position.y - other.position.y, dz = sphere.position.z - other.position.z;
    if (other.shape === 'sphere') return dx * dx + dy * dy + dz * dz < ((sphere.size.x + other.size.x) / 2 - tolerance) ** 2;
    const c = Math.cos(other.yaw ?? 0), s = Math.sin(other.yaw ?? 0);
    return Math.max(0, Math.abs(c * dx - s * dz) - other.size.x / 2) ** 2 + Math.max(0, Math.abs(dy) - other.size.y / 2) ** 2
      + Math.max(0, Math.abs(s * dx + c * dz) - other.size.z / 2) ** 2 < (sphere.size.x / 2 - tolerance) ** 2;
  }
  const axes = (part: AssetPart) => [{ x: Math.cos(part.yaw ?? 0), z: -Math.sin(part.yaw ?? 0) }, { x: Math.sin(part.yaw ?? 0), z: Math.cos(part.yaw ?? 0) }];
  const aa = axes(a), bb = axes(b), dot = (u: { x: number; z: number }, v: { x: number; z: number }) => u.x * v.x + u.z * v.z;
  return [...aa, ...bb].every(axis => Math.abs((a.position.x - b.position.x) * axis.x + (a.position.z - b.position.z) * axis.z)
    < Math.abs(dot(aa[0], axis)) * a.size.x / 2 + Math.abs(dot(aa[1], axis)) * a.size.z / 2
      + Math.abs(dot(bb[0], axis)) * b.size.x / 2 + Math.abs(dot(bb[1], axis)) * b.size.z / 2 - tolerance);
}
function supported(instance: AssetGroupInstance, surface: AssetSurface): boolean {
  const yaw = instance.yaw - (surface.yaw ?? 0), c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
  const width = c * instance.model.size.x + s * instance.model.size.z, depth = s * instance.model.size.x + c * instance.model.size.z;
  const dx = instance.position.x - surface.position.x, dz = instance.position.z - surface.position.z;
  const cosine = Math.cos(surface.yaw ?? 0), sine = Math.sin(surface.yaw ?? 0), x = cosine * dx - sine * dz, z = sine * dx + cosine * dz;
  return Math.abs(instance.position.y - surface.position.y) <= 1e-6 && Math.abs(x) + width / 2 <= surface.width / 2 + 1e-6
    && Math.abs(z) + depth / 2 <= surface.depth / 2 + 1e-6 && (surface.clearHeight === undefined || instance.model.size.y <= surface.clearHeight + 1e-6);
}
function groupBounds(instances: readonly AssetGroupInstance[]) {
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const instance of instances) for (const part of instance.model.parts) {
    const bounds = assetPartBounds(posedPart(instance, part));
    for (const axis of ['x', 'y', 'z'] as const) { min[axis] = Math.min(min[axis], bounds.min[axis]); max[axis] = Math.max(max[axis], bounds.max[axis]); }
  }
  for (const axis of ['x', 'y', 'z'] as const) { min[axis] = coordinate(min[axis]); max[axis] = coordinate(max[axis]); }
  return { bounds: { min, max }, size: { x: coordinate(max.x - min.x), y: coordinate(max.y - min.y), z: coordinate(max.z - min.z) } };
}
function decorateModel(model: AssetManifest, collision: boolean, material?: SurfaceMaterialInput): AssetManifest {
  const parts = model.parts.map(part => ({ ...part, collision: collision && part.collision !== false, inheritMaterial: false,
    ...(material !== undefined && part.material === undefined ? { material } : {}) }));
  // Disabling cylinder collision replaces its conservative box bounds with its
  // visual ellipse bounds. Recenter the resulting visual model, including its
  // sockets/surfaces, rather than rejecting a formerly centred asymmetric asset.
  const bounds = parts.map(assetPartBounds), offset = { x: coordinate((Math.min(...bounds.map(value => value.min.x)) + Math.max(...bounds.map(value => value.max.x))) / 2),
    z: coordinate((Math.min(...bounds.map(value => value.min.z)) + Math.max(...bounds.map(value => value.max.z))) / 2) };
  const position = (point: PhysicsVector) => ({ x: coordinate(point.x - offset.x), y: point.y, z: coordinate(point.z - offset.z) });
  for (const part of parts) part.position = position(part.position);
  const family = defineAssetFamily({ id: stableId(`${model.familyId}:dressing`), version: '1', parameters: {},
    generate: () => ({ parts, sockets: model.sockets.map(socket => ({ ...socket, position: position(socket.position), tags: [...socket.tags] })),
      ...(model.surfaces === undefined ? {} : { surfaces: model.surfaces.map(surface => ({ ...surface, position: position(surface.position), tags: [...surface.tags] })) }) }) });
  return createAssetCatalog([family], { maxVariants: 1 }).resolve(family.id, { seed: model.seed, instanceId: 'dressing' });
}

/** Each tagged surface gets its own seeded composition. Unfit required items
 * invalidate the result; explicitly optional omissions remain inspectable.
 * Parent bounds are never treated as a solid obstacle or inferred support. */
export function resolveAssetDressing(catalog: AssetGroupCatalog, request: AssetDressingRequest): AssetDressingResult {
  keys(request, ['model', 'seed', 'instanceId', 'arrangements', 'maxAttempts'], 'Dressing request');
  if (!id(request.instanceId) || !Number.isInteger(request.seed) || request.seed < 0 || request.seed > 0xffffffff
    || !Number.isInteger(request.maxAttempts ?? 24) || (request.maxAttempts ?? 24) < 1 || (request.maxAttempts ?? 24) > ASSET_DRESSING_LIMITS.attempts) throw new Error('Dressing needs a stable instance ID, uint32 seed and bounded attempts.');
  const rules = validateAssetDressingArrangements(request.arrangements), parent = validateAssetManifest(request.model), maxAttempts = request.maxAttempts ?? 24;
  const instances: AssetDressingInstance[] = [{ id: request.instanceId, model: parent, position: { x: 0, y: 0, z: 0 }, yaw: 0 }];
  const arrangements: AssetDressingRecord[] = [], issues: AssetDressingIssue[] = [], occupied = parent.parts.map(part => ({ ...part }));
  const result: AssetDressingResult = { version: 1, id: request.instanceId, seed: request.seed, instances, arrangements, ...groupBounds(instances),
    diagnostics: { valid: true, issues, requested: 0, placed: 0, attempted: 0, omittedOptional: 0 } };
  const diagnostics = result.diagnostics, seen = new Set([request.instanceId]), models = new Map<string, AssetManifest>();
  let partCount = parent.parts.length, colliderCount = parent.colliders.length;
  const issue = (problem: AssetDressingIssue, invalid = true) => { if (issues.length < 128) issues.push(problem); if (invalid) diagnostics.valid = false; };
  for (const rule of rules) {
    const surfaces = (parent.surfaces ?? []).filter(surface => typeof rule.surface === 'string' ? surface.id === rule.surface : surface.tags.includes(rule.surface.tag)).sort((a, b) => compare(a.id, b.id));
    if (!surfaces.length) { issue({ code: 'surface', message: 'No declared support surface matches this arrangement.', arrangementId: rule.id }); continue; }
    for (const surface of surfaces) {
      if (arrangements.length >= ASSET_DRESSING_LIMITS.records) { issue({ code: 'budget', message: 'Dressing exceeds its matched-surface budget.', arrangementId: rule.id, surfaceId: surface.id }); break; }
      const key = `${request.instanceId}:${rule.id}:${surface.id}`, variant = choose(rule.variants, random(request.seed, `${key}:variant`));
      const record: AssetDressingRecord = { id: rule.id, surfaceId: surface.id, variantId: variant.id, requested: 0, placed: 0 }; arrangements.push(record);
      for (const item of variant.items) {
        const itemKey = `${key}:${variant.id}:${item.id}`;
        if (random(request.seed, `${itemKey}:probability`) >= (item.probability ?? 1)) continue;
        const countRange = item.count as [number, number], count = countRange[0] + Math.floor(random(request.seed, `${itemKey}:count`) * (countRange[1] - countRange[0] + 1));
        const required = item.required ?? count; diagnostics.requested += count; record.requested += count; let placed = 0;
        if (diagnostics.requested > ASSET_DRESSING_LIMITS.instances - 1) {
          issue({ code: 'budget', message: 'Dressing requests more than 32 decoration instances.', arrangementId: rule.id, surfaceId: surface.id, itemId: item.id }); continue;
        }
        for (let index = 0; index < count; index++) {
          const instanceKey = `${itemKey}:${index}`, instanceId = availableId(`${request.instanceId}:dressing:${rule.id}:${surface.id}:${variant.id}:${item.id}:${index}`,
            [request.instanceId, rule.id, surface.id, variant.id, item.id, index], seen);
          const choice = choose(item.choices, random(request.seed, `${instanceKey}:choice`));
          const context = { arrangementId: rule.id, surfaceId: surface.id, itemId: item.id, instanceId };
          let model: AssetManifest, source: AssetManifest;
          try {
            source = validateAssetManifest(catalog.resolve(choice.family, { seed: request.seed, instanceId, parameters: choice.parameters }));
            const cacheKey = `${source.key}:${item.collision === true}:${canonical(choice.material)}`;
            model = models.get(cacheKey) ?? decorateModel(source, item.collision === true, choice.material); models.set(cacheKey, model);
          } catch (error) { issue({ code: 'model', message: error instanceof Error ? error.message : String(error), ...context }); continue; }
          if (instances.length >= ASSET_DRESSING_LIMITS.instances || partCount + model.parts.length > ASSET_DRESSING_LIMITS.parts
            || colliderCount + model.colliders.length > ASSET_FAMILY_LIMITS.colliders) { issue({ code: 'budget', message: 'Dressing exceeds its instance, part, collider or stable-ID budget.', ...context }); continue; }
          const yawRange = item.yaw as [number, number], relativeYaw = angle(yawRange[0] + (yawRange[1] - yawRange[0]) * random(request.seed, `${instanceKey}:yaw`));
          const yaw = angle((surface.yaw ?? 0) + relativeYaw), zone = item.zone ?? { x: 0, z: 0, width: 1, depth: 1 };
          const extentX = (Math.abs(Math.cos(relativeYaw)) * model.size.x + Math.abs(Math.sin(relativeYaw)) * model.size.z) / surface.width;
          const extentZ = (Math.abs(Math.sin(relativeYaw)) * model.size.x + Math.abs(Math.cos(relativeYaw)) * model.size.z) / surface.depth;
          let accepted: AssetDressingInstance | undefined;
          for (let attempt = 0; attempt < maxAttempts && diagnostics.attempted < ASSET_DRESSING_LIMITS.totalAttempts; attempt++) {
            diagnostics.attempted++;
            const anchor = item.anchors?.[(index + attempt) % item.anchors.length];
            const x = anchor ? anchor.x + (random(request.seed, `${instanceKey}:${attempt}:x`) * 2 - 1) * (item.jitter?.x ?? 0)
              : zone.x + (random(request.seed, `${instanceKey}:${attempt}:x`) - .5) * Math.max(0, zone.width - extentX);
            const z = anchor ? anchor.z + (random(request.seed, `${instanceKey}:${attempt}:z`) * 2 - 1) * (item.jitter?.z ?? 0)
              : zone.z + (random(request.seed, `${instanceKey}:${attempt}:z`) - .5) * Math.max(0, zone.depth - extentZ);
            if (Math.abs(x - zone.x) + extentX / 2 > zone.width / 2 + 1e-7 || Math.abs(z - zone.z) + extentZ / 2 > zone.depth / 2 + 1e-7) continue;
            const position = transformSpatialPoint({ x: x * surface.width, z: z * surface.depth }, surface.position, surface.yaw ?? 0);
            const candidate: AssetDressingInstance = { id: instanceId, model, position: { ...position, y: surface.position.y }, yaw,
              parentId: request.instanceId, arrangementId: rule.id, surfaceId: surface.id, variantId: variant.id, itemId: item.id, choiceId: choice.id,
              source: { familyId: source.familyId, version: source.version, key: source.key, parameters: source.parameters } };
            if (!supported(candidate, surface)) continue;
            const posed = model.parts.map(part => posedPart(candidate, part));
            if (posed.some(part => occupied.some(other => overlaps(part, other)))) continue;
            accepted = candidate; occupied.push(...posed); break;
          }
          if (accepted) { instances.push(accepted); partCount += model.parts.length; colliderCount += model.colliders.length; placed++; diagnostics.placed++; record.placed++; }
        }
        const missing = count - placed, requiredMissing = Math.max(0, required - placed);
        diagnostics.omittedOptional += missing - requiredMissing;
        if (missing) issue({ code: diagnostics.attempted >= ASSET_DRESSING_LIMITS.totalAttempts ? 'attempt-budget' : 'unfit',
          message: `${missing} of ${count} selected item(s) could not fit the support, clear height, parent geometry or sibling spacing; ${requiredMissing} required.`,
          arrangementId: rule.id, surfaceId: surface.id, itemId: item.id }, requiredMissing > 0);
      }
    }
  }
  Object.assign(result, groupBounds(instances));
  if (Object.values(result.size).some(value => value > ASSET_FAMILY_LIMITS.dimension)) issue({ code: 'budget', message: 'Dressed model exceeds the asset dimension budget.' });
  return freeze(result);
}

/** Flatten only a valid arrangement. Root sockets/surfaces keep their original
 * IDs; child sockets/surfaces remain in instances, avoiding implicit stacking.
 * Add rotated originOffset to preserve an existing root anchor after flattening. */
export function assetDressingModel(input: AssetDressingResult, options: { id: string; version: string }): { model: AssetManifest; originOffset: PhysicsVector } {
  if (!input || input.version !== 1 || !id(input.id) || !Number.isInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff || !input.diagnostics?.valid
    || !Array.isArray(input.instances) || !input.instances.length || input.instances.length > ASSET_DRESSING_LIMITS.instances) throw new Error('Only a valid bounded dressing result can become a model.');
  const seen = new Set<string>();
  const instances = Array.from(input.instances as readonly AssetDressingInstance[], instance => {
    if (!instance || !id(instance.id) || seen.has(instance.id) || !plain(instance.position) || Object.keys(instance.position).length !== 3
      || ![instance.position.x, instance.position.y, instance.position.z].every(value => finite(value) && Math.abs(value) <= 256) || !finite(instance.yaw)) throw new Error('Dressing instance transform or identity is invalid.');
    seen.add(instance.id); return { ...instance, model: validateAssetManifest(instance.model) };
  });
  const root = instances[0];
  if (root.id !== input.id || root.yaw !== 0 || Object.values(root.position).some(value => value !== 0)) throw new Error('Dressing root must retain the original model origin.');
  const occupied = root.model.parts.map(part => ({ ...part }));
  for (const instance of instances.slice(1)) {
    const surface = root.model.surfaces?.find(surface => surface.id === instance.surfaceId), posed = instance.model.parts.map(part => posedPart(instance, part));
    if (instance.parentId !== root.id || !surface || !supported(instance, surface) || posed.some(part => occupied.some(other => overlaps(part, other)))) throw new Error('Dressing instance no longer fits its declared support or overlaps geometry.');
    occupied.push(...posed);
  }
  if (occupied.length > ASSET_DRESSING_LIMITS.parts) throw new Error('Dressing exceeds the flattened part budget.');
  const { bounds } = groupBounds(instances), originOffset = { x: coordinate((bounds.min.x + bounds.max.x) / 2), y: bounds.min.y, z: coordinate((bounds.min.z + bounds.max.z) / 2) };
  const partIds = new Set(root.model.parts.map(part => part.id));
  const parts = [root, ...instances.slice(1).sort((a, b) => compare(a.id, b.id))].flatMap((instance, index) => instance.model.parts.map(part => {
    const posed = posedPart(instance, part);
    return { ...posed, id: index ? availableId(`dressing:${instance.id}:${part.id}`, [instance.id, part.id], partIds) : part.id,
      position: { x: coordinate(posed.position.x - originOffset.x), y: coordinate(posed.position.y - originOffset.y), z: coordinate(posed.position.z - originOffset.z) } };
  }));
  const offset = (position: PhysicsVector) => ({ x: coordinate(position.x - originOffset.x), y: coordinate(position.y - originOffset.y), z: coordinate(position.z - originOffset.z) });
  const family = defineAssetFamily({ id: options.id, version: options.version, parameters: {}, generate: () => ({ parts,
    sockets: root.model.sockets.map(socket => ({ ...socket, position: offset(socket.position), tags: [...socket.tags] })),
    ...(root.model.surfaces === undefined ? {} : { surfaces: root.model.surfaces.map(surface => ({ ...surface, position: offset(surface.position), tags: [...surface.tags] })) }) }) });
  return freeze({ model: createAssetCatalog([family], { maxVariants: 1 }).resolve(family.id, { seed: input.seed, instanceId: input.id }), originOffset });
}
