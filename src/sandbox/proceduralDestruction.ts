/** Optional destruction preparation during procedural generation. The original
 * generated source stays intact; one prepared artifact owns its replacements,
 * collision, runtime settings, and presentation/query projections. */
import { compileBuilding, type BuildingManifest, type BuildingRecipe } from './building.ts';
import { transformAssetColliders, type AssetCatalog, type AssetManifest, type AssetResolveOptions } from './assetFamilies.ts';
import { compileAssetStructure, compileBuildingStructure, destructionTopologyKey, projectAssetDestruction, projectBuildingDestruction,
  type AssetDestructionProjection, type AssetStructure, type BuildingDestructionProjection, type BuildingStructure, type StructuralBindings } from './buildingDestruction.ts';
import { createDestructionState, destructionTerrainEdits, prepareDestructionScene, stepDestructionWorld, structuralColliderId,
  type DestructionState, type DestructionStep, type DestructionWorldStep, type DestructionWorldStepResult } from './destruction.ts';
import { prepareStructuralFractures, type PreparedStructuralFractures, type StructuralFractureRule } from './structuralFracture.ts';
import type { PhysicsCollider, PhysicsScene, PhysicsVector } from './physics.ts';
import type { TerrainCollisionEdits } from './terrainWorld.ts';
import { spatialAngle, spatialCoordinate } from './spatial.ts';

export interface ProceduralDestructionRuntime {
  contactLoads?: boolean;
  impactDamage?: DestructionStep['impactDamage'];
  impactResponse?: DestructionStep['impactResponse'];
}
export interface ProceduralDestructionConfiguration {
  bindings: StructuralBindings;
  fractures?: StructuralFractureRule[];
  runtime?: ProceduralDestructionRuntime;
}
export type ProceduralDestructionFactory<T> = false | ProceduralDestructionConfiguration
  | ((source: T) => ProceduralDestructionConfiguration | false | undefined);
export const PROCEDURAL_DESTRUCTION_RUNTIME_DEFAULTS = Object.freeze({ contactLoads: true, impactResponse: 'coupled' as const,
  impactDamage: Object.freeze({ minimumImpulse: 40, damagePerImpulse: .018, minimumSpeed: 1, radius: 1.65 }) });

interface PreparedDestructionCommon {
  prepared: PreparedStructuralFractures;
  runtime: Readonly<Required<ProceduralDestructionRuntime>>;
  /** Exact original world-space geometry, including pieces replaced by cells. */
  originalColliders: readonly PhysicsCollider[];
}
export interface PreparedBuildingDestruction extends PreparedDestructionCommon {
  kind: 'building'; building: BuildingManifest; baseStructure: BuildingStructure;
}
export interface PreparedAssetDestruction extends PreparedDestructionCommon {
  kind: 'asset'; model: AssetManifest; baseStructure: AssetStructure;
}
export type PreparedProceduralDestruction = PreparedBuildingDestruction | PreparedAssetDestruction;
type AssetPose = { position?: PhysicsVector; yaw?: number };

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fields(value: unknown, allowed: readonly string[], name: string): void {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${name} requires supported plain fields.`);
}
function bounded(value: unknown, name: string, min = 0, max = 1e12): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid destruction ${name}.`);
}
function runtimeSettings(input: ProceduralDestructionRuntime = {}): Readonly<Required<ProceduralDestructionRuntime>> {
  fields(input, ['contactLoads', 'impactDamage', 'impactResponse'], 'Destruction runtime');
  const contactLoads = input.contactLoads === undefined ? true : input.contactLoads;
  const impactResponse = input.impactResponse === undefined ? 'coupled' : input.impactResponse;
  if (typeof contactLoads !== 'boolean' || !['coupled', 'deferred'].includes(impactResponse)) throw new Error('Invalid destruction runtime policy.');
  const value: NonNullable<DestructionStep['impactDamage']> = input.impactDamage === undefined ? PROCEDURAL_DESTRUCTION_RUNTIME_DEFAULTS.impactDamage : input.impactDamage;
  fields(value, ['minimumImpulse', 'damagePerImpulse', 'minimumSpeed', 'radius', 'falloff'], 'Impact damage');
  bounded(value.minimumImpulse, 'minimum impact impulse'); bounded(value.damagePerImpulse, 'impact damage', 0, 1e6);
  bounded(value.minimumSpeed === undefined ? .5 : value.minimumSpeed, 'minimum impact speed', 0, 1000);
  if (value.radius !== undefined) bounded(value.radius, 'impact radius', .000001, 10000);
  if (value.falloff !== undefined) bounded(value.falloff, 'impact falloff', 0, 8);
  return Object.freeze({ contactLoads, impactResponse, impactDamage: Object.freeze({ ...value }) });
}
function configuration(input: ProceduralDestructionConfiguration): void {
  fields(input, ['bindings', 'fractures', 'runtime'], 'Procedural destruction');
  if (!input.bindings) throw new Error('Procedural destruction requires explicit structural bindings.');
  if (input.fractures !== undefined && (!Array.isArray(input.fractures) || input.fractures.length > 64))
    throw new Error('Procedural fracture rules must fit the 64-member budget.');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function snapshotColliders(colliders: readonly PhysicsCollider[]): readonly PhysicsCollider[] {
  const copy = JSON.parse(JSON.stringify(colliders)) as PhysicsCollider[];
  const freeze = (value: unknown): void => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(copy); return copy;
}
function checkFractureSources(source: BuildingManifest | AssetManifest, base: BuildingStructure | AssetStructure,
  rules: readonly {memberId:string}[]): void {
  for (const rule of rules) {
    const member = base.members.find(item => item.id === rule.memberId);
    if (!member) continue; // The shared preparation validator reports the precise missing ID.
    const ids = member.partIds ?? [], part = source.parts.find(item => item.id === ids[0]);
    if (ids.length !== 1 || !part || ('shape' in part ? part.shape !== 'box' || part.collision === false : !!part.geometry || !!part.model || part.kind === 'furniture' || !part.visible || !part.collidable))
      throw new Error(`Fractured or ductile member ${rule.memberId} must own one visible colliding box part; bind attached decorations separately.`);
  }
}

/** Call after final foundations, room levels and world pose are established. */
export function prepareBuildingDestruction(building: BuildingManifest,
  config?: ProceduralDestructionConfiguration | false): PreparedBuildingDestruction | undefined {
  if (config === undefined || config === false) return undefined;
  configuration(config); const runtime = runtimeSettings(config.runtime), baseStructure = compileBuildingStructure(building, config.bindings);
  const rules = config.fractures ?? []; checkFractureSources(building, baseStructure, [...rules,...baseStructure.members.filter(m=>m.deformation).map(m=>({memberId:m.id}))]);
  const prepared = prepareStructuralFractures(baseStructure, rules);
  return Object.freeze({ kind: 'building', building, baseStructure, prepared, runtime, originalColliders: snapshotColliders(building.colliders) });
}
/** Models remain reusable; bindings.id must uniquely identify this world instance.
 * Explicit binding positions retain compileAssetStructure's world-space contract. */
export function prepareAssetDestruction(model: AssetManifest, config?: ProceduralDestructionConfiguration | false,
  pose: AssetPose = {}): PreparedAssetDestruction | undefined {
  if (config === undefined || config === false) return undefined;
  configuration(config); const runtime = runtimeSettings(config.runtime), baseStructure = compileAssetStructure(model, config.bindings, pose);
  const rules = config.fractures ?? []; checkFractureSources(model, baseStructure, [...rules,...baseStructure.members.filter(m=>m.deformation).map(m=>({memberId:m.id}))]);
  const prepared = prepareStructuralFractures(baseStructure, rules);
  return Object.freeze({ kind: 'asset', model, baseStructure, prepared, runtime,
    originalColliders: snapshotColliders(transformAssetColliders(model, baseStructure.source.position, baseStructure.source.yaw)) });
}
/** Generator entry point. A callback can bind the actual compiled IDs, including
 * procedural roof pieces, fixtures and hidden stair geometry. */
export function compileDestructibleBuilding(recipe: BuildingRecipe, config?: ProceduralDestructionFactory<BuildingManifest>) {
  const building = compileBuilding(recipe), resolved = typeof config === 'function' ? config(building) : config;
  const destruction = prepareBuildingDestruction(building, resolved);
  return { building, ...(destruction ? { destruction } : {}) };
}
export function resolveDestructibleAsset(catalog: Pick<AssetCatalog, 'resolve'>, familyId: string, options: AssetResolveOptions,
  config?: ProceduralDestructionFactory<AssetManifest>, pose: AssetPose = {}) {
  const model = catalog.resolve(familyId, options), resolved = typeof config === 'function' ? config(model) : config;
  const destruction = prepareAssetDestruction(model, resolved, pose);
  return { model, ...(destruction ? { destruction } : {}) };
}

/** Terrain family placement canonicalizes coordinates and quaternion components.
 * Match that exact representation as well as the ordinary asset/world transform;
 * never use fuzzy geometry matching that could remove a nearby unrelated part. */
function originalCollisionRepresentations(bundle: PreparedProceduralDestruction): readonly PhysicsCollider[] {
  if (bundle.kind !== 'asset') return bundle.originalColliders;
  const point = (value: PhysicsVector): PhysicsVector => ({ x: spatialCoordinate(value.x), y: spatialCoordinate(value.y), z: spatialCoordinate(value.z) });
  return [...bundle.originalColliders, ...bundle.originalColliders.map(collider => {
    const shape = collider.shape;
    return { ...collider, position: point(collider.position),
      shape: shape.kind === 'box' ? { ...shape, halfExtents: point(shape.halfExtents) }
        : shape.kind === 'ball' ? { ...shape, radius: spatialCoordinate(shape.radius) } : shape,
      ...(collider.rotation ? { rotation: { x: spatialAngle(collider.rotation.x), y: spatialAngle(collider.rotation.y),
        z: spatialAngle(collider.rotation.z), w: spatialAngle(collider.rotation.w) } } : {}) };
  })];
}

/** Both original source geometry and prepared cell geometry must be removable
 * after terrain chunks reload. Static rubble is supplied by the same state. */
export function preparedDestructionTerrainEdits(bundle: PreparedProceduralDestruction, state: DestructionState): TerrainCollisionEdits {
  const edits = destructionTerrainEdits(bundle.prepared.structure, state), remove = new Map<string, PhysicsCollider>();
  for (const collider of [...originalCollisionRepresentations(bundle), ...(edits.remove ?? [])]) remove.set(canonical(collider), collider);
  return { remove: [...remove.values()], add: edits.add ?? [] };
}
const sourceSceneCaches = new WeakMap<PreparedProceduralDestruction, WeakMap<PhysicsScene, PhysicsScene>>();
function stripOriginalCollision(bundle: PreparedProceduralDestruction, scene: PhysicsScene): PhysicsScene {
  let cache = sourceSceneCaches.get(bundle); if (!cache) { cache = new WeakMap(); sourceSceneCaches.set(bundle, cache); }
  const cached = cache.get(scene); if (cached) return cached;
  const originals = new Set(originalCollisionRepresentations(bundle).map(canonical));
  const tagged = new Set(bundle.baseStructure.revision === bundle.prepared.structure.revision ? []
    : bundle.baseStructure.members.flatMap(member => member.colliders.map((_, index) => structuralColliderId(bundle.baseStructure, member.id, index))));
  const colliders = scene.colliders.filter(collider => !originals.has(canonical(collider)) && !(collider.id && tagged.has(collider.id)));
  const result = colliders.length === scene.colliders.length ? scene : { ...scene, colliders };
  cache.set(scene, result); return result;
}
export function prepareDestructibleScene(bundle: PreparedProceduralDestruction, state: DestructionState, scene: PhysicsScene): PhysicsScene {
  return prepareDestructionScene(bundle.prepared.structure, state, stripOriginalCollision(bundle, scene));
}
export interface DestructibleWorldStep extends Omit<DestructionWorldStep, 'structures'> {
  entries: { destruction: PreparedProceduralDestruction; state: DestructionState }[];
  /** Explicit global policy; otherwise every active entry must agree. Top-level
   * contactLoads/impactDamage/impactResponse are also global overrides. */
  runtime?: ProceduralDestructionRuntime;
}
export function stepDestructibleWorld(input: DestructibleWorldStep): DestructionWorldStepResult {
  if (!Array.isArray(input.entries)) throw new Error('Destructible world requires entries.');
  const { entries, runtime: override, ...options } = input;
  const overridden = override !== undefined || options.contactLoads !== undefined || options.impactDamage !== undefined || options.impactResponse !== undefined;
  const runtime = overridden ? runtimeSettings({ ...override,
    ...(options.contactLoads === undefined ? {} : { contactLoads: options.contactLoads }),
    ...(options.impactDamage === undefined ? {} : { impactDamage: options.impactDamage }),
    ...(options.impactResponse === undefined ? {} : { impactResponse: options.impactResponse }) }) : entries[0]?.destruction.runtime ?? runtimeSettings();
  if (!overridden && entries.some(entry => canonical(entry.destruction.runtime) !== canonical(runtime)))
    throw new Error('Destructible entries have different runtime settings; supply an explicit global runtime override.');
  let scene = input.scene;
  for (const entry of entries) scene = stripOriginalCollision(entry.destruction, scene);
  return stepDestructionWorld({ ...options, ...runtime, scene,
    structures: entries.map(entry => ({ structure: entry.destruction.prepared.structure, state: entry.state })) });
}

/** Whole original query surfaces cannot describe a partial fracture. Invalidate
 * one as soon as any owning replacement cell detaches; native collision remains
 * precise, including surviving cells. Navigation always needs revalidation. */
function sourceProjectionState(bundle: PreparedProceduralDestruction, state: DestructionState): DestructionState {
  destructionTopologyKey(bundle.prepared.structure, state);
  const detached = new Set(state.clusters.flatMap(cluster => cluster.memberIds));
  const removed = bundle.baseStructure.members.filter(member =>
    (bundle.prepared.sourceToMembers[member.id] ?? [member.id]).some(id => detached.has(id))).map(member => member.id);
  const source = createDestructionState(bundle.baseStructure);
  return removed.length ? { ...source, clusters: [{ id: 'source-projection', memberIds: removed,
    origin: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
    velocity: { x: 0, y: 0, z: 0 }, angularVelocity: { x: 0, y: 0, z: 0 }, settled: false, quietTime: 0 }] } : source;
}
export function projectDestructibleBuilding(bundle: PreparedBuildingDestruction, state: DestructionState): BuildingDestructionProjection {
  const projected = projectBuildingDestruction(bundle.building, bundle.baseStructure, sourceProjectionState(bundle, state));
  const replaced = new Set([...bundle.prepared.fractures.flatMap(item => item.sourcePartIds),...bundle.prepared.structure.members.filter(m=>m.deformation).flatMap(m=>m.partIds??[])]);
  const parts = projected.parts.filter(part => !replaced.has(part.id));
  const colliders = prepareDestructionScene(bundle.prepared.structure, state, { colliders: [] }).colliders;
  const topologyRevision = destructionTopologyKey(bundle.prepared.structure, state);
  const warpedSurfaces=new Set(bundle.prepared.structure.members.filter(m=>m.deformation&&state.deformations?.[m.id].offsets.some(n=>n!==0)).flatMap(m=>m.surfaceIds??[]));
  return { ...projected, revision: `${bundle.building.revision}:prepared-destruction:${topologyRevision}`, parts, colliders, surfaces:projected.surfaces.filter(s=>!warpedSurfaces.has(s.id)),
    diagnostics: { ...projected.diagnostics, counts: { ...projected.diagnostics.counts,
      parts: parts.reduce((sum, part) => sum + (part.model?.parts.length ?? 1), 0), colliders: colliders.length } },
    destruction: { ...projected.destruction, structureRevision: bundle.prepared.structure.revision, topologyRevision,
      removedMemberIds: state.clusters.flatMap(cluster => cluster.memberIds).sort(),
      removedPartIds: [...new Set([...projected.destruction.removedPartIds, ...replaced])].sort() } };
}
export function projectDestructibleAsset(bundle: PreparedAssetDestruction, state: DestructionState): AssetDestructionProjection {
  const projected = projectAssetDestruction(bundle.model, bundle.baseStructure, sourceProjectionState(bundle, state));
  const replaced = new Set([...bundle.prepared.fractures.flatMap(item => item.sourcePartIds),...bundle.prepared.structure.members.filter(m=>m.deformation).flatMap(m=>m.partIds??[])]);
  const warpedSurfaces=new Set(bundle.prepared.structure.members.filter(m=>m.deformation&&state.deformations?.[m.id].offsets.some(n=>n!==0)).flatMap(m=>m.surfaceIds??[]));
  return { ...projected, revision: destructionTopologyKey(bundle.prepared.structure, state),
    attachedPartIds: projected.attachedPartIds.filter(id => !replaced.has(id)),
    removedPartIds: [...new Set([...projected.removedPartIds, ...replaced])].sort(),
    surfaces:projected.surfaces.filter(s=>!warpedSurfaces.has(s.id)),colliders: prepareDestructionScene(bundle.prepared.structure, state, { colliders: [] }).colliders };
}
