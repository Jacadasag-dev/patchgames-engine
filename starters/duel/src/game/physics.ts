import { raycastPhysics, raycastPhysicsBatch, type PhysicsScene, type PhysicsBody, type PhysicsRay } from '../sandbox/physics.ts';
import { characterBody, moveCharacters } from '../sandbox/characters.ts';
import { arenaGeometryKey, DEFAULT_WORLD } from './terrain.ts';
import { sharedTerrain } from './terrainWorld.ts';
import type { FighterState, TerrainWorld } from './shapes.ts';
import type { GameTuning } from './tuning.ts';

// A declarative scene, not a second solver. Rapier owns gravity and collision
// response. Keep the description in plain data so authority and prediction
// can reconstruct the same simulation without hidden native-engine state.
let cachedKey = '';
let cachedScene: PhysicsScene;
export function arenaPhysics(world: TerrainWorld, tuning: GameTuning): PhysicsScene {
  const key = arenaGeometryKey(world, tuning);
  if (key === cachedKey && cachedScene) return cachedScene;
  cachedKey = key;
  return cachedScene = sharedTerrain.read(tuning).scene;
}

export function fighterBody(p: FighterState, tuning: GameTuning): PhysicsBody {
  return characterBody(p, tuning);
}

/** One coordinated world step. Stable IDs preserve body order in prediction/replays.
 * Add future bodies to this batch and write their returned state back here; don't
 * create one disconnected physics world per object. All policies remain editable.
 */
export function moveFighters(fighters: FighterState[], dt: number, tuning: GameTuning, world: TerrainWorld = DEFAULT_WORLD): void {
  moveCharacters(fighters, dt, tuning, arenaPhysics(world, tuning));
}

export function physicsLineClear(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, world: TerrainWorld, tuning: GameTuning): boolean {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance < 1e-6) return true;
  return raycastPhysics({ scene: arenaPhysics(world, tuning), origin: a,
    direction: { x: dx / distance, y: dy / distance, z: dz / distance }, distance }) === null;
}

/** Same scalar line queries, sharing a single arena lookup and sandbox crossing. */
export function physicsLinesClear(lines: readonly { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } }[], world: TerrainWorld, tuning: GameTuning): boolean[] {
  const rays: Omit<PhysicsRay, 'scene'>[] = [], indexes: number[] = [];
  const clear = lines.map(({ start, end }, index) => {
    const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 1e-6) return true;
    indexes.push(index);
    rays.push({ origin: start, direction: { x: dx / distance, y: dy / distance, z: dz / distance }, distance });
    return true;
  });
  if (rays.length) {
    const hits = raycastPhysicsBatch({ scene: arenaPhysics(world, tuning), rays });
    indexes.forEach((index, ray) => { clear[index] = hits[ray] === null; });
  }
  return clear;
}
