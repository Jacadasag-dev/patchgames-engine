/**
 * Rapier physics API for player-authored game code. Only plain data crosses the
 * sandbox boundary; no host objects, callbacks, files or network are exposed.
 * Positions are collider centers (convert fighter feet in src/game/physics.ts).
 * Every step starts from the supplied state: prediction/replays cannot inherit
 * hidden solver state from another match, bot or prior prediction call.
 */
export const PHYSICS_VERSION = 'rapier-0.20.0-v1';
/** Hard ceilings, not defaults. Streaming keeps only the required active area.
 * 32 separated players can each straddle four 32-cell chunks: 128 chunks,
 * 139392 samples and at most 96 obstacles per chunk. The full scene allowance
 * covers Float32 sample JSON plus those statics; steps/rays stay at 128 KiB.
 * Active geometry is installed during preparation, never silently truncated.
 * Authoring still has to fit its manifests and game state inside the VM heap;
 * the default terrain resolution is deliberately below this collision ceiling.
 */
export const PHYSICS_SCENE_LIMITS = Object.freeze({
  colliders: 96,
  terrainCells: 32,
  terrainSamples: 1089,
  requestChars: 128 * 1024,
  /** Explicit immutable authored architecture; ordinary scenes keep 96. */
  staticMapColliders: 1024,
  staticMapSceneChars: 2 * 1024 * 1024,
  terrainChunks: 128,
  streamedTerrainSamples: 128 * 1089,
  streamedColliders: 128 * 96,
  streamedSceneChars: 8 * 1024 * 1024,
});
/** Separate operation: these ceilings do not change the recorded legacy step. */
export const PHYSICS_COMPOUND_LIMITS = Object.freeze({
  bodies: 64, colliders: 256, collidersPerBody: 32, impacts: 512, contactPairs: 8192,
});
export interface PhysicsVector { x: number; y: number; z: number }
export interface PhysicsRotation extends PhysicsVector { w: number }
export type PhysicsShape = { kind: 'ball'; radius: number }
  | { kind: 'capsule'; radius: number; halfHeight: number }
  | { kind: 'box'; halfExtents: PhysicsVector }
  /** 4..64 local hull points, each coordinate within +/-1000m. Must span 3D. */
  | { kind: 'convex'; vertices: PhysicsVector[] };
export interface PhysicsCollider {
  /** Optional stable identity for static ray/contact identification. */
  id?: string;
  shape: PhysicsShape;
  position: PhysicsVector;
  rotation?: PhysicsRotation;
  friction?: number;
  restitution?: number;
  /** False keeps collision/displacement but excludes this collider from fixed water placement cuts. */
  waterBoundary?: false;
}
export interface PhysicsBody extends PhysicsCollider {
  velocity: PhysicsVector;
  angularVelocity?: PhysicsVector;
  fixed?: boolean;
  lockRotations?: boolean;
  mass?: number;
}
export interface PhysicsHeightfield {
  /** Rapier column-major samples: heights[column * (rows + 1) + row]. */
  rows: number;
  columns: number;
  heights: number[];
  width: number;
  depth: number;
}
export interface PhysicsTerrainChunk extends PhysicsHeightfield {
  /** Stable identity within this scene; changing geometry replaces this chunk. */
  id: string;
  /** World-space center of the local heightfield; heights are relative to its Y. */
  position: PhysicsVector;
}
export interface PhysicsScene {
  colliders: PhysicsCollider[];
  /** Exact authored architecture revision. Every collider needs a unique ID.
   * Replace the entire immutable scene outside ticks; scene-edit is unsupported.
   * This bounded allowance is separate from streamed terrain chunks. */
  staticMap?: { revision: string };
  terrain?: PhysicsHeightfield;
  /** Complete active set. Omitted IDs are removed; collisions are never truncated. */
  terrainChunks?: PhysicsTerrainChunk[];
}
export interface PhysicsStep {
  scene: PhysicsScene;
  bodies: PhysicsBody[];
  gravity: PhysicsVector;
  dt: number;
}
export interface PhysicsBodyResult {
  position: PhysicsVector;
  rotation: PhysicsRotation;
  velocity: PhysicsVector;
  angularVelocity: PhysicsVector;
  /** Distance from collider center to ground, plus surface normal, or null. */
  ground: { distance: number; normal: PhysicsVector } | null;
}
export interface PhysicsCompoundCollider extends PhysicsCollider { id: string }
export interface PhysicsCompoundBody {
  id: string;
  position: PhysicsVector;
  rotation?: PhysicsRotation;
  velocity: PhysicsVector;
  angularVelocity?: PhysicsVector;
  /** Total mass, distributed between children by solid volume; .01..1e7. */
  mass?: number;
  fixed?: boolean;
  lockRotations?: boolean;
  /** Child poses are local to the body root. IDs are unique within this body. */
  colliders: PhysicsCompoundCollider[];
}
export interface PhysicsCompoundStep {
  scene: PhysicsScene;
  bodies: PhysicsCompoundBody[];
  gravity: PhysicsVector;
  dt: number;
  /** Omit contact records whose accumulated impulse is below this threshold. */
  impactThreshold?: number;
}
export interface PhysicsCompoundBodyResult extends PhysicsBodyResult { id: string }
export interface PhysicsImpact {
  bodyId: string;
  otherBodyId?: string;
  colliderId: string;
  otherColliderId?: string;
  /** Sum of contact-force magnitudes times substep duration. Includes support forces. */
  impulse: number;
  /** World contact captured during the strongest sampled contact substep. */
  point?: PhysicsVector;
  /** World outward surface normal of the other collider at that contact. */
  normal?: PhysicsVector;
}
export interface PhysicsCompoundResult {
  /** Canonically ordered by body ID, independent of request array order. */
  bodies: PhysicsCompoundBodyResult[];
  /** Directed contacts: a body/body contact produces one record for each body. */
  impacts: PhysicsImpact[];
  /** Only the strongest 512 records are retained when this is true. */
  impactsTruncated: boolean;
}
export interface PhysicsRay {
  scene: PhysicsScene;
  origin: PhysicsVector;
  direction: PhysicsVector;
  distance: number;
}
export interface PhysicsRayResult { distance: number; normal: PhysicsVector; colliderId?: string }
export interface PhysicsRayBatch {
  scene: PhysicsScene;
  rays: Omit<PhysicsRay, 'scene'>[];
}

function call<T>(operation: string, request: unknown): T {
  const bridge = (globalThis as unknown as { __patchduelPhysics?: (json: string) => string }).__patchduelPhysics;
  if (!bridge) throw new Error('Rapier physics is available only in the game logic sandbox');
  const result = JSON.parse(bridge(JSON.stringify({ version: PHYSICS_VERSION, operation, request })));
  if (result.error) throw new Error(result.error);
  return result.value as T;
}

let activeScene: PhysicsScene | undefined;
let sceneGeneration=0;
let activeBoxes:Map<string,PhysicsCollider>|undefined;
let activeBridge:unknown;
const sameTerrain=(a:PhysicsScene,b:PhysicsScene)=>a.staticMap?.revision===b.staticMap?.revision&&a.terrain===b.terrain
  &&a.terrainChunks?.length===b.terrainChunks?.length
  &&(a.terrainChunks??[]).every((t,i)=>{const u=b.terrainChunks![i];return t.id===u.id&&t.heights===u.heights&&t.rows===u.rows&&t.columns===u.columns
    &&t.width===u.width&&t.depth===u.depth&&t.position.x===u.position.x&&t.position.y===u.position.y&&t.position.z===u.position.z;});
const knownImmutableBoxes=new WeakSet<PhysicsCollider>();
const immutableBox=(c:PhysicsCollider)=>{if(knownImmutableBoxes.has(c))return true;
  const valid=c.shape.kind==='box'&&Object.isFrozen(c)&&Object.isFrozen(c.position)
    &&Object.isFrozen(c.shape)&&Object.isFrozen(c.shape.halfExtents)&&(!c.rotation||Object.isFrozen(c.rotation));
  if(valid)knownImmutableBoxes.add(c);return valid;};
export function preparePhysics(scene: PhysicsScene): void {
  const bridge=(globalThis as unknown as {__patchduelPhysics?:unknown}).__patchduelPhysics;
  if(bridge!==activeBridge){activeBridge=bridge;activeScene=undefined;activeBoxes=undefined;sceneGeneration=0;}
  if (activeScene === scene) return;
  let patched=false;
  const nextBoxes=!scene.staticMap&&!scene.terrain&&scene.terrainChunks?.length&&scene.terrainChunks.every(t=>Object.isFrozen(t)&&Object.isFrozen(t.heights)&&Object.isFrozen(t.position))
    &&scene.colliders.length&&scene.colliders.every(c=>c.id&&immutableBox(c))?new Map(scene.colliders.map(c=>[c.id!,c])):undefined;
  if(activeScene&&activeBoxes&&nextBoxes&&sameTerrain(activeScene,scene)){
    const order=scene.colliders.map(c=>c.id!),changed=scene.colliders.filter(c=>activeBoxes!.get(c.id!)!==c);
    if(new Set(order).size===order.length&&changed.length<=512){
      const request={base:sceneGeneration,order,colliders:changed};
      if(JSON.stringify(request).length<PHYSICS_SCENE_LIMITS.requestChars-256){sceneGeneration=call<number>('scene-edit',request);patched=true;}
    }
  }
  // Obtain the accepted generation from native code: an interrupted prior
  // call may have installed its scene without returning to this VM.
  if(!patched){
    if(nextBoxes)sceneGeneration=call<number>('scene-bind',scene);
    else{call('scene',scene);sceneGeneration=0;}
  }
  activeBoxes=nextBoxes;
  activeScene = scene;
}
/** Up to 32 bodies and 0.25 seconds. Small scenes retain the 96-collider limit;
 * explicit static maps and streamed scenes use their separate PHYSICS_SCENE_LIMITS. Prepare changed geometry outside a
 * live tick. Keep the immutable scene object while its loaded revision is unchanged
 * so ticks and rays do not serialize or rebuild the active terrain.
 */
export function stepPhysics({ scene, ...request }: PhysicsStep): PhysicsBodyResult[] {
  preparePhysics(scene);
  return call('step', request);
}
/** Replay-safe compound rigid bodies. Put characters and debris in the same call
 * when they must interact. No solver/sleep state survives between calls. The
 * static scene is shared with legacy queries; dynamic bodies are not ray targets.
 * Contact impulses include resting support and are not automatically damage.
 */
export function stepCompoundPhysics({ scene, ...request }: PhysicsCompoundStep): PhysicsCompoundResult {
  preparePhysics(scene);
  return call('step-compound', request);
}
/** Rapier's TGS solver splits each fixed native step into this many
 * symplectic Euler substeps (its default solver iteration count). */
export const PHYSICS_SOLVER_SUBSTEPS = 4;
/** Fraction of g·dt² a free body falls during one native step of dt: the
 * host runs ceil(60·dt) fixed steps of PHYSICS_SOLVER_SUBSTEPS substeps each,
 * and K substeps fall (K+1)/(2K)·g·dt². A coupled solver that predicts a
 * body's next pose uses this so its prediction matches native integration;
 * an impulse applied before the step moves the body by its full dt·J/m. */
export function physicsGravityDisplacement(dt: number): number {
  const substeps = Math.ceil(dt * 60) * PHYSICS_SOLVER_SUBSTEPS;
  return (substeps + 1) / (2 * substeps);
}
/** Ray against arena/static geometry, for weapon occlusion and other game queries. */
export function raycastPhysics({ scene, ...request }: PhysicsRay): PhysicsRayResult | null {
  preparePhysics(scene);
  return call('ray', request);
}
/** Up to 256 independent static rays, returned in order, using one sandbox crossing. */
export function raycastPhysicsBatch({ scene, rays }: PhysicsRayBatch): (PhysicsRayResult | null)[] {
  preparePhysics(scene);
  return call('rays', rays);
}
