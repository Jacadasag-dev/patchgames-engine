import type { GamePlayer } from '../shared/gameApi.ts';

/** Pure, deterministic building blocks. Health and elimination remain core rules. */
export interface PlanarPosition { x: number; z: number }
export interface SafeZone extends PlanarPosition { radius: number; closed: boolean }
export interface SafeZoneSchedule {
  initialRadius: number;
  delayMs: number;
  shrinkMs: number;
  centerX?: number;
  centerZ?: number;
}

/** Equally spaced starts around a central supply area, in player-index order. */
export function ringSpawns(count: number, radius: number, rotation = 0): PlanarPosition[] {
  if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error('Ring spawns require 1–32 players.');
  if (!Number.isFinite(radius) || radius < 0 || !Number.isFinite(rotation)) throw new Error('Ring spawns require a finite radius and rotation.');
  return Array.from({ length: count }, (_, index) => {
    const angle = rotation + index * Math.PI * 2 / count;
    return { x: Math.sin(angle) * radius, z: Math.cos(angle) * radius };
  });
}

/** Linear shrink after a grace period. A closed zone is unsafe even at its center. */
export function safeZoneAt(elapsedMs: number, schedule: SafeZoneSchedule): SafeZone {
  const { initialRadius, delayMs, shrinkMs, centerX = 0, centerZ = 0 } = schedule;
  if (![elapsedMs, initialRadius, delayMs, shrinkMs, centerX, centerZ].every(Number.isFinite)
    || initialRadius < 0 || delayMs < 0 || shrinkMs <= 0) throw new Error('Invalid safe-zone schedule.');
  const progress = Math.max(0, Math.min(1, (elapsedMs - delayMs) / shrinkMs));
  return { x: centerX, z: centerZ, radius: initialRadius * (1 - progress), closed: progress >= 1 || initialRadius === 0 };
}

/** Positive padding requires the entire body, rather than only its center, to fit. */
export function isInsideSafeZone(zone: SafeZone, position: PlanarPosition, padding = 0): boolean {
  if (zone.closed || zone.radius < padding) return false;
  const dx = position.x - zone.x, dz = position.z - zone.z;
  return dx * dx + dz * dz <= (zone.radius - padding) ** 2;
}

/** A stable nearest-living-player query; ties go to the lower player index. */
export function nearestLivingOpponent<P extends PlanarPosition>(players: readonly GamePlayer<P>[], selfIndex: number): GamePlayer<P> | undefined {
  const self = players.find(player => player.index === selfIndex);
  if (!self || self.hp <= 0) return undefined;
  let nearest: GamePlayer<P> | undefined, distance = Infinity;
  for (const player of players) {
    if (player.index === selfIndex || player.hp <= 0) continue;
    const dx = player.state.x - self.state.x, dz = player.state.z - self.state.z;
    const candidate = dx * dx + dz * dz;
    if (candidate < distance || (candidate === distance && nearest && player.index < nearest.index)) {
      nearest = player;
      distance = candidate;
    }
  }
  return nearest;
}
