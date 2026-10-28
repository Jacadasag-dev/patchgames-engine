/**
 * Drawing things a fighter spawns: shots, thrown items, effects (view only; locked).
 *
 * The world a view gets (ViewFrame.world) is the server's latest, out of step with
 * the fighters it draws: the local fighter is predicted ahead of it, the others
 * drawn 100 ms behind. Drawn as sent, a new shot appears away from the weapon that
 * fired it, most visibly while moving, and steps at the server's update rate.
 * SpawnSmoother draws each one leaving its owner's weapon as drawn, eases it onto
 * its sent path and moves it on between updates. Only the drawing changes: where
 * it flies and what it hits stay the server's.
 *
 *     private readonly shotSmoother = new SpawnSmoother();
 *     // in update(frame): frame.players is in game index order
 *     const drawn = this.shotSmoother.update(world.projectiles, (owner) =>
 *       muzzleOf(frame.players[owner]), frame.now);
 *     world.projectiles.forEach((shot, i) => meshes[i].position.set(drawn[i].x, drawn[i].y, drawn[i].z));
 *
 * Every item needs x/y/z, a velocity vx/vy/vz (units per second, constant while it
 * flies; use 0 for something that doesn't move) and its owner's game index.
 */
export interface SpawnVector { x: number; y: number; z: number }
export interface SpawnedItem extends SpawnVector { vx: number; vy: number; vz: number; owner: number }
export interface SpawnSmoothing {
  /** How long a new item takes to ease from its owner's weapon onto its sent path (ms). Default 200. */
  convergeMs?: number;
  /** Between server updates it moves on at its velocity, for at most this long (ms). Default 100. */
  extrapolateMs?: number;
}

interface Tracked {
  owner: number;
  velocity: SpawnVector;
  /** Its latest sent position, and when that arrived. */
  at: SpawnVector;
  atTime: number;
  bornAt: number;
  /** Drawn minus sent, when first seen: eases to zero. */
  offset: SpawnVector;
}

export class SpawnSmoother {
  private tracked: Tracked[] = [];
  private readonly convergeMs: number;
  private readonly extrapolateMs: number;

  constructor(options: SpawnSmoothing = {}) {
    this.convergeMs = finiteAtLeast(options.convergeMs ?? 200, 1, 'convergeMs');
    this.extrapolateMs = finiteAtLeast(options.extrapolateMs ?? 100, 0, 'extrapolateMs');
  }

  /**
   * Where to draw each item, in the order given. `origin(owner)` is where that
   * fighter's weapon (muzzle, hand) is drawn now; null draws a new item as sent.
   * `now` is frame.now. Call once per frame with every item still in the world.
   */
  update(items: readonly SpawnedItem[], origin: (owner: number) => SpawnVector | null, now: number): SpawnVector[] {
    const unmatched = [...this.tracked];
    const next: Tracked[] = [];
    const drawn = items.map((item) => {
      const at = { x: item.x, y: item.y, z: item.z };
      const velocity = { x: item.vx, y: item.vy, z: item.vz };
      let track = claim(unmatched, item.owner, at, velocity, now);
      if (!track) {
        const from = origin(item.owner);
        const valid = from && [from.x, from.y, from.z].every(Number.isFinite);
        track = { owner: item.owner, velocity, at, atTime: now, bornAt: now,
          offset: valid ? { x: from.x - at.x, y: from.y - at.y, z: from.z - at.z } : { x: 0, y: 0, z: 0 } };
      } else if (!same(track.at, at)) {
        track.at = at;
        track.atTime = now;
      }
      next.push(track);
      const ahead = Math.min(Math.max(0, now - track.atTime), this.extrapolateMs) / 1000;
      const ease = Math.max(0, 1 - (now - track.bornAt) / this.convergeMs) ** 2;
      return {
        x: at.x + velocity.x * ahead + track.offset.x * ease,
        y: at.y + velocity.y * ahead + track.offset.y * ease,
        z: at.z + velocity.z * ahead + track.offset.z * ease,
      };
    });
    this.tracked = next;
    return drawn;
  }
}

/** The tracked item this one continues: same owner and velocity, reached by moving forward along it since last seen. */
function claim(unmatched: Tracked[], owner: number, at: SpawnVector, velocity: SpawnVector, now: number): Tracked | undefined {
  let best = -1, bestGap = Infinity;
  const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
  unmatched.forEach((track, i) => {
    if (track.owner !== owner || !same(track.velocity, velocity)) return;
    const dx = at.x - track.at.x, dy = at.y - track.at.y, dz = at.z - track.at.z, gap = Math.hypot(dx, dy, dz);
    // A new item fired along the same line starts behind an older one: never mistake it for that one.
    const forward = dx * velocity.x + dy * velocity.y + dz * velocity.z >= -1e-6;
    const reach = speed * (Math.max(0, now - track.atTime) / 1000 + 0.25) + 1e-6;
    if (forward && gap <= reach && gap < bestGap) { best = i; bestGap = gap; }
  });
  return best < 0 ? undefined : unmatched.splice(best, 1)[0];
}

const same = (a: SpawnVector, b: SpawnVector) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;

function finiteAtLeast(value: number, min: number, name: string): number {
  if (!Number.isFinite(value) || value < min) throw new Error(`SpawnSmoother: ${name} must be a number of at least ${min}`);
  return value;
}
