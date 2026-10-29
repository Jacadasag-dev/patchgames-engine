import type { GamePlayer } from '../shared/gameApi.ts';
import { raycastPhysicsBatch, type PhysicsScene, type PhysicsVector } from '../sandbox/physics.ts';
import type { PlayerState, WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';

export function aimDirection(state: Pick<PlayerState, 'facing' | 'aimPitch'>): PhysicsVector {
  return { x: Math.sin(state.facing) * Math.cos(state.aimPitch), y: Math.sin(state.aimPitch), z: Math.cos(state.facing) * Math.cos(state.aimPitch) };
}
export function eyePosition(state: Pick<PlayerState, 'x' | 'y' | 'z'>, tuning: GameTuning): PhysicsVector {
  return { x: state.x, y: state.y + tuning.fighterHeight * .9, z: state.z };
}

/** First intersection of a ray with the expanded authoritative vertical capsule. */
function capsuleEntry(origin: PhysicsVector, direction: PhysicsVector, limit: number, state: PlayerState, tuning: GameTuning): number | null {
  const radius = tuning.fighterRadius + .055, low = state.y + tuning.fighterRadius, high = state.y + tuning.fighterHeight - tuning.fighterRadius;
  const x = origin.x - state.x, z = origin.z - state.z;
  let best = Infinity;
  const sphere = (cy: number) => {
    const y = origin.y - cy, b = x * direction.x + y * direction.y + z * direction.z, c = x * x + y * y + z * z - radius * radius;
    if (c <= 0) { best = 0; return; }
    const discriminant = b * b - c;
    if (discriminant >= 0) { const t = -b - Math.sqrt(discriminant); if (t >= 0) best = Math.min(best, t); }
  };
  sphere(low); sphere(high);
  const a = direction.x ** 2 + direction.z ** 2, b = x * direction.x + z * direction.z, c = x * x + z * z - radius * radius;
  if (c <= 0 && origin.y >= low && origin.y <= high) best = 0;
  const discriminant = b * b - a * c;
  if (a > 1e-10 && discriminant >= 0) {
    const t = (-b - Math.sqrt(discriminant)) / a, y = origin.y + direction.y * t;
    if (t >= 0 && y >= low && y <= high) best = Math.min(best, t);
  }
  return best <= limit ? best : null;
}

/** One static-ray batch, then first capsule contact. Only the locked damage core
 * applies health changes; this resolves occlusion and non-piercing arrow travel. */
export function advanceArrows(world: WorldState, players: readonly GamePlayer<PlayerState>[], tuning: GameTuning, scene: PhysicsScene, dtMs: number): void {
  world.arrows = world.arrows.filter(arrow => arrow.lifeMs > 0 && players.some(player => player.index === arrow.owner && player.hp > 0));
  if (!world.arrows.length) return;
  const dt = Math.min(dtMs / 1000, .25);
  const rays = world.arrows.map(arrow => {
    arrow.fromX = arrow.x; arrow.fromY = arrow.y; arrow.fromZ = arrow.z;
    arrow.vy -= tuning.bowGravity * dt;
    const speed = Math.hypot(arrow.vx, arrow.vy, arrow.vz);
    return { origin: { x: arrow.x, y: arrow.y, z: arrow.z }, direction: { x: arrow.vx / speed, y: arrow.vy / speed, z: arrow.vz / speed }, distance: speed * dt };
  });
  const walls = raycastPhysicsBatch({ scene, rays });
  world.arrows.forEach((arrow, index) => {
    const ray = rays[index];
    let distance = Math.min(ray.distance, walls[index]?.distance ?? Infinity), target = -1;
    for (const player of players) {
      if (player.index === arrow.owner || player.hp <= 0) continue;
      const entry = capsuleEntry(ray.origin, ray.direction, distance, player.state, tuning);
      if (entry !== null && entry < distance - 1e-6) { distance = entry; target = player.index; }
    }
    arrow.x += ray.direction.x * distance; arrow.y += ray.direction.y * distance; arrow.z += ray.direction.z * distance;
    arrow.target = target;
    arrow.lifeMs = target >= 0 || walls[index] ? 0 : Math.max(0, arrow.lifeMs - dtMs);
  });
}

/** Server/prediction helper also used by legal practice-bot inputs. */
export function cameraRelativeInput(state: Pick<PlayerState, 'facing'>, x: number, z: number): { moveX: number; moveZ: number } {
  return { moveX: -Math.cos(state.facing) * x + Math.sin(state.facing) * z,
    moveZ: -Math.sin(state.facing) * x - Math.cos(state.facing) * z };
}
/** Public hint and server interaction use the same aim cone and reach. Static
 * obstruction is checked by authority before opening or taking any item. */
export function aimedChest(world: WorldState, state: PlayerState, tuning: GameTuning): WorldState['supplies'][number] | undefined {
  const eye = eyePosition(state, tuning), aim = aimDirection(state);
  return world.supplies.map(chest => {
    const dx = chest.x - eye.x, dy = chest.y + .55 - eye.y, dz = chest.z - eye.z;
    const distance = Math.hypot(dx, dy, dz), dot = distance > .001 ? (dx * aim.x + dy * aim.y + dz * aim.z) / distance : 1;
    // A broad box-sized cone keeps a nearby chest easy to target in first person.
    return { chest, distance, dot };
  }).filter(item => item.distance <= tuning.pickupRadius && item.dot >= .82)
    .sort((a, b) => b.dot - a.dot || a.distance - b.distance || a.chest.id.localeCompare(b.chest.id))[0]?.chest;
}

