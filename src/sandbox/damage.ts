// Locked damage rules. The only way to hurt a fighter is a damage entity that
// touches their body: after every step the core asks the game for its bodies,
// damage entities and blockers (GameLogic.entities), finds contacts here, and
// applies the damage itself. A blocker (a shield) stops a strike that reaches
// it before the body. It runs the same way in live rooms, replay checks,
// training and the game's own tests. Contacts use plain arithmetic
// (Math.sqrt only for blockers, never hypot or trigonometry), and the server's
// result is the one that counts.
import type { BlockerEntity, ConfirmedElimination, DamageEntity, DamageHit, EntityVector, HealingEntity, PlayerBody, PlayerList } from '../shared/gameApi.ts';
import { MAX_MATCH_PLAYERS } from '../shared/gameModes.ts';

export const MAX_DAMAGE_ENTITIES = 256;
export const MAX_BLOCKERS = 64;
export const MAX_HEALING_ENTITIES = 32;
/** The most steps a strike's path is checked in against blockers. */
const MAX_PATH_STEPS = 256;
const MAX_COORDINATE = 10_000;
const MAX_DAMAGE = 1_000_000;

/** A game's entities broke the contract: the message says which one and why. */
export class EntityError extends Error {
  constructor(message: string) {
    super(`entities: ${message}`);
    this.name = 'EntityError';
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function number(value: unknown, where: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new EntityError(`${where} must be a number from ${min} to ${max}`);
  }
  return value;
}

function vector(value: unknown, where: string, min = -MAX_COORDINATE, max = MAX_COORDINATE): EntityVector {
  if (!isObject(value)) throw new EntityError(`${where} must be { x, y, z }`);
  return { x: number(value.x, `${where}.x`, min, max), y: number(value.y, `${where}.y`, min, max), z: number(value.z, `${where}.z`, min, max) };
}

function text(value: unknown, where: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.length || value.length > maxLength) throw new EntityError(`${where} must be text of 1 to ${maxLength} characters`);
  return value;
}

function body(value: unknown, where: string): Required<PlayerBody> {
  if (!isObject(value)) throw new EntityError(`${where} must be { at, radius, height, guard? }`);
  return {
    at: vector(value.at, `${where}.at`),
    radius: number(value.radius, `${where}.radius`, 0.01, 50),
    height: number(value.height, `${where}.height`, 0.01, 100),
    guard: value.guard === undefined ? 1 : number(value.guard, `${where}.guard`, 0, 1),
  };
}

function damageEntity(value: unknown, where: string, playerCount: number): DamageEntity {
  if (!isObject(value)) throw new EntityError(`${where} must be a damage entity`);
  const id = text(value.id, `${where}.id`, 64);
  const at = `damage "${id}"`;
  if (value.kind !== 'strike' && value.kind !== 'zone') throw new EntityError(`${at}: kind must be 'strike' or 'zone'`);
  if (value.owner !== null && (typeof value.owner !== 'number' || !Number.isInteger(value.owner) || value.owner < 0 || value.owner >= playerCount)) throw new EntityError(`${at}: owner must be a participant index from 0 to ${playerCount - 1}, or null`);
  if (value.hitsOwner !== undefined && typeof value.hitsOwner !== 'boolean') throw new EntityError(`${at}: hitsOwner must be true or false`);
  if (value.target !== undefined && (typeof value.target !== 'number' || !Number.isInteger(value.target) || value.target < 0 || value.target >= playerCount)) throw new EntityError(`${at}: target must be a participant index from 0 to ${playerCount - 1}`);
  const entity: DamageEntity = {
    id,
    label: text(value.label, `${at}.label`, 32),
    kind: value.kind,
    damage: number(value.damage, `${at}.damage`, 0, MAX_DAMAGE),
    owner: value.owner,
    ...(value.target === undefined ? {} : { target: value.target as number }),
    hitsOwner: value.hitsOwner === true,
    shape: 'sphere',
    at: vector(value.at, `${at}.at`),
  };
  if (value.shape === 'sphere') {
    entity.radius = number(value.radius, `${at}.radius`, 0.001, 100);
    if (value.from !== undefined) entity.from = vector(value.from, `${at}.from`);
  } else if (value.shape === 'box') {
    entity.shape = 'box';
    entity.half = vector(value.half, `${at}.half`, 0.001, 1000);
  } else {
    throw new EntityError(`${at}: shape must be 'sphere' or 'box'`);
  }
  return entity;
}

function blockerEntity(value: unknown, where: string, playerCount: number): BlockerEntity {
  if (!isObject(value)) throw new EntityError(`${where} must be a blocker`);
  const id = text(value.id, `${where}.id`, 64);
  const at = `blocker "${id}"`;
  if (value.kind !== 'blocker') throw new EntityError(`${at}: kind must be 'blocker'`);
  if (value.owner !== null && (typeof value.owner !== 'number' || !Number.isInteger(value.owner) || value.owner < 0 || value.owner >= playerCount)) throw new EntityError(`${at}: owner must be a participant index from 0 to ${playerCount - 1}, or null`);
  const blocker: BlockerEntity = { id, label: text(value.label, `${at}.label`, 32), kind: 'blocker', owner: value.owner, shape: 'sphere', at: vector(value.at, `${at}.at`) };
  if (value.shape === 'disc' || value.shape === 'sphere') {
    blocker.shape = value.shape;
    blocker.radius = number(value.radius, `${at}.radius`, 0.001, 100);
    if (value.shape === 'disc') {
      const normal = vector(value.normal, `${at}.normal`, -1000, 1000);
      const length = Math.sqrt(dot(normal, normal));
      if (!(length > 1e-9)) throw new EntityError(`${at}: normal must not be zero`);
      blocker.normal = { x: normal.x / length, y: normal.y / length, z: normal.z / length };
    }
  } else if (value.shape === 'box') {
    blocker.shape = 'box';
    blocker.half = vector(value.half, `${at}.half`, 0.001, 1000);
  } else {
    throw new EntityError(`${at}: shape must be 'disc', 'sphere' or 'box'`);
  }
  return blocker;
}

export interface CheckedEntities {
  bodies: PlayerList<Required<PlayerBody>>;
  damage: DamageEntity[];
  blockers: BlockerEntity[];
  healing?: HealingEntity[];
}

function healingEntity(value: unknown, where: string, playerCount: number): HealingEntity {
  if (!isObject(value)) throw new EntityError(`${where} must be a healing entity`);
  if (!Number.isInteger(value.owner) || (value.owner as number) < 0 || (value.owner as number) >= playerCount)
    throw new EntityError(`${where}: owner must be a participant index`);
  if (value.target !== undefined && (!Number.isInteger(value.target) || (value.target as number) < 0 || (value.target as number) >= playerCount))
    throw new EntityError(`${where}: target must be a participant index`);
  if (value.interruptOnDamage !== undefined && typeof value.interruptOnDamage !== 'boolean')
    throw new EntityError(`${where}: interruptOnDamage must be a boolean`);
  return { id: text(value.id, `${where}.id`, 64), label: text(value.label, `${where}.label`, 32),
    owner: value.owner as number, ...(value.target === undefined ? {} : { target: value.target as number }),
    ...(value.interruptOnDamage === undefined ? {} : { interruptOnDamage: value.interruptOnDamage as boolean }),
    amount: number(value.amount, `${where}.amount`, 0, MAX_DAMAGE), at: vector(value.at, `${where}.at`),
    radius: number(value.radius, `${where}.radius`, 0.001, 100) };
}

/** Checks a game's entities; null or undefined (no entities() at all) means nothing can take damage. */
export function readEntities(raw: unknown, playerCount = 2): CheckedEntities | null {
  if (!Number.isInteger(playerCount) || playerCount < 1 || playerCount > MAX_MATCH_PLAYERS) throw new EntityError(`participant count must be from 1 to ${MAX_MATCH_PLAYERS}`);
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) throw new EntityError('entities() must return { bodies, damage, blockers? }');
  if (!Array.isArray(raw.bodies) || raw.bodies.length !== playerCount) throw new EntityError(playerCount === 2 ? 'bodies must list both fighters' : `bodies must list all ${playerCount} participants`);
  if (!Array.isArray(raw.damage)) throw new EntityError('damage must be a list');
  if (raw.blockers !== undefined && !Array.isArray(raw.blockers)) throw new EntityError('blockers must be a list');
  if (raw.healing !== undefined && (!Array.isArray(raw.healing) || raw.healing.length > MAX_HEALING_ENTITIES)) throw new EntityError(`healing must be a list of at most ${MAX_HEALING_ENTITIES} entities`);
  const rawBlockers = (raw.blockers as unknown[] | undefined) ?? [];
  if (raw.damage.length > MAX_DAMAGE_ENTITIES) throw new EntityError(`at most ${MAX_DAMAGE_ENTITIES} damage entities at a time`);
  if (rawBlockers.length > MAX_BLOCKERS) throw new EntityError(`at most ${MAX_BLOCKERS} blockers at a time`);
  const damage = raw.damage.map((entity, i) => damageEntity(entity, `damage[${i}]`, playerCount));
  const blockers = rawBlockers.map((entity, i) => blockerEntity(entity, `blockers[${i}]`, playerCount));
  const healing = (raw.healing as unknown[] | undefined)?.map((entity, i) => healingEntity(entity, `healing[${i}]`, playerCount));
  const ids = new Set<string>();
  for (const entity of [...damage, ...blockers, ...(healing ?? [])]) {
    if (ids.has(entity.id)) throw new EntityError(`two entities share the id "${entity.id}"`);
    ids.add(entity.id);
  }
  return { bodies: raw.bodies.map((value, index) => body(value, `bodies[${index}]`)) as PlayerList<Required<PlayerBody>>, damage, blockers,
    ...(healing ? { healing } : {}) };
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);
const dot = (a: EntityVector, b: EntityVector) => a.x * b.x + a.y * b.y + a.z * b.z;
const minus = (a: EntityVector, b: EntityVector): EntityVector => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

/** Squared distance between segments p1-q1 and p2-q2 (Ericson, Real-Time Collision Detection 5.1.9). */
function segmentDistanceSq(p1: EntityVector, q1: EntityVector, p2: EntityVector, q2: EntityVector): number {
  const d1 = minus(q1, p1), d2 = minus(q2, p2), r = minus(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s = 0, t = 0;
  if (a <= 1e-12 && e <= 1e-12) {
    s = 0; t = 0;
  } else if (a <= 1e-12) {
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-12) {
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2), denom = a * e - b * b;
      s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  const dx = p1.x + d1.x * s - (p2.x + d2.x * t);
  const dy = p1.y + d1.y * s - (p2.y + d2.y * t);
  const dz = p1.z + d1.z * s - (p2.z + d2.z * t);
  return dx * dx + dy * dy + dz * dz;
}

/** The body's spine: a vertical segment the capsule's radius wraps around. */
function spine(body: Required<PlayerBody>): [EntityVector, EntityVector] {
  const bottom = Math.min(body.radius, body.height / 2), top = Math.max(bottom, body.height - body.radius);
  return [{ x: body.at.x, y: body.at.y + bottom, z: body.at.z }, { x: body.at.x, y: body.at.y + top, z: body.at.z }];
}

/** True when a damage entity touches a fighter's body. */
export function touches(entity: DamageEntity, body: Required<PlayerBody>): boolean {
  if (entity.shape === 'sphere') {
    const reach = body.radius + entity.radius!;
    const start = entity.from ?? entity.at, end = entity.at;
    // Most shots are far from most players. Reject disjoint swept bounds before
    // allocating spine/segment vectors. The slack exceeds rounding at the
    // validated coordinate limits; near-contact cases use the unchanged solver.
    const bound = reach + 1e-7, at = body.at;
    if ((start.x < at.x - bound && end.x < at.x - bound)
      || (start.x > at.x + bound && end.x > at.x + bound)
      || (start.z < at.z - bound && end.z < at.z - bound)
      || (start.z > at.z + bound && end.z > at.z + bound)) return false;
    const bottom = Math.min(body.radius, body.height / 2), top = Math.max(bottom, body.height - body.radius);
    if ((start.y < at.y + bottom - bound && end.y < at.y + bottom - bound)
      || (start.y > at.y + top + bound && end.y > at.y + top + bound)) return false;
    const [low, high] = spine(body);
    return segmentDistanceSq(start, end, low, high) <= reach * reach;
  }
  const [low, high] = spine(body);
  // A vertical segment against an axis-aligned box: the gaps along each axis are independent.
  const half = entity.half!;
  const gap = (value: number, center: number, size: number) => Math.max(0, Math.abs(value - center) - size);
  const gx = gap(body.at.x, entity.at.x, half.x), gz = gap(body.at.z, entity.at.z, half.z);
  const gy = Math.max(0, entity.at.y - half.y - high.y, low.y - (entity.at.y + half.y));
  return gx * gx + gy * gy + gz * gz <= body.radius * body.radius;
}

/** Squared distance from a point to a blocker's surface (0 inside it). */
function blockerDistanceSq(point: EntityVector, blocker: BlockerEntity): number {
  if (blocker.shape === 'box') {
    const half = blocker.half!;
    const gap = (value: number, center: number, size: number) => Math.max(0, Math.abs(value - center) - size);
    const gx = gap(point.x, blocker.at.x, half.x), gy = gap(point.y, blocker.at.y, half.y), gz = gap(point.z, blocker.at.z, half.z);
    return gx * gx + gy * gy + gz * gz;
  }
  const offset = minus(point, blocker.at);
  if (blocker.shape === 'sphere') {
    const outside = Math.max(0, Math.sqrt(dot(offset, offset)) - blocker.radius!);
    return outside * outside;
  }
  // A disc: the distance off its plane, and how far past its rim the point is.
  const normal = blocker.normal!, height = dot(offset, normal);
  const inPlane = { x: offset.x - normal.x * height, y: offset.y - normal.y * height, z: offset.z - normal.z * height };
  const beyondRim = Math.max(0, Math.sqrt(dot(inPlane, inPlane)) - blocker.radius!);
  return height * height + beyondRim * beyondRim;
}

/** Squared distance from a point to a body's spine. */
function spineDistanceSq(point: EntityVector, body: Required<PlayerBody>): number {
  const [low, high] = spine(body);
  return segmentDistanceSq(point, point, low, high);
}

/** Where along the path (0..1) it passes closest to a point. */
function closestAlong(start: EntityVector, path: EntityVector, point: EntityVector): number {
  const lengthSq = dot(path, path);
  return lengthSq > 1e-12 ? clamp01(dot(minus(point, start), path) / lengthSq) : 0;
}

/**
 * Follows a sphere strike's path from `from` to `at` and reports what it reaches
 * first: a blocker (its id) or the body ('body'), or null for neither. A blocker
 * wins a tie. The path is checked at even steps of at most half the sphere's
 * radius (up to MAX_PATH_STEPS) and, exactly, where it crosses each disc and
 * passes closest to each blocker and to the body, so a thin shield can't be
 * skipped however far the strike moves in one step.
 */
function firstContact(entity: DamageEntity, body: Required<PlayerBody>, blockers: BlockerEntity[], checkpoint?: () => void): string | null {
  const start = entity.from ?? entity.at, radius = entity.radius!;
  const path = minus(entity.at, start), length = Math.sqrt(dot(path, path));
  const steps = Math.min(MAX_PATH_STEPS, Math.max(1, Math.ceil(length / Math.max(radius / 2, 0.01))));
  const along = new Set<number>();
  for (let i = 0; i <= steps; i++) along.add(i / steps);
  const [low, high] = spine(body);
  along.add(closestAlong(start, path, { x: low.x, y: Math.max(low.y, Math.min(high.y, start.y + path.y * closestAlong(start, path, low))), z: low.z }));
  for (const blocker of blockers) {
    along.add(closestAlong(start, path, blocker.at));
    if (blocker.shape === 'disc') {
      const heightStart = dot(minus(start, blocker.at), blocker.normal!), heightChange = dot(path, blocker.normal!);
      if (Math.abs(heightChange) > 1e-12) along.add(clamp01(-heightStart / heightChange));
    }
  }
  const reach = body.radius + radius;
  for (const t of [...along].sort((a, b) => a - b)) {
    // Each sample checks at most MAX_BLOCKERS bounded shapes before yielding
    // to the trusted host's execution guard. No clock enters the contact math.
    checkpoint?.();
    const point = { x: start.x + path.x * t, y: start.y + path.y * t, z: start.z + path.z * t };
    const blocker = blockers.find((b) => blockerDistanceSq(point, b) <= radius * radius);
    if (blocker) return blocker.id;
    if (spineDistanceSq(point, body) <= reach * reach) return 'body';
  }
  return null;
}

/**
 * Which damage entities touch which fighters this step, and how much health
 * each loses. `struck` remembers strikes that already landed (by player and id)
 * for the rest of the match, so a strike hits each fighter once. A sphere strike
 * whose path reaches a blocker (not its owner's) before the body is stopped: no
 * damage, and it is spent for that fighter. Zones and box strikes aren't blocked.
 */
export function resolveDamage(entities: CheckedEntities | null, struck: Set<string>, dtMs: number, alive?: readonly boolean[], checkpoint?: () => void, teams?: readonly number[]): { damage: PlayerList<number>; hits: DamageHit[] } {
  checkpoint?.();
  const damage = Array.from({ length: entities?.bodies.length ?? alive?.length ?? 2 }, () => 0) as PlayerList<number>;
  const hits: DamageHit[] = [];
  if (!entities) { checkpoint?.(); return { damage, hits }; }
  // An interrupted guarded pass must not spend some strikes and then be
  // retried as if those strikes had successfully reached the authoritative state.
  const pending = checkpoint ? new Set<string>() : struck;
  for (const entity of entities.damage) {
    checkpoint?.();
    if (entity.owner !== null && alive?.[entity.owner] === false) continue;
    const blockable = entity.kind === 'strike' && entity.shape === 'sphere';
    // Team games: a teammate's shield never stops this strike, and the strike never hurts a teammate.
    const teammate = (other: number) => teams !== undefined && entity.owner !== null && other !== entity.owner && teams[other] === teams[entity.owner];
    const blockers = blockable ? entities.blockers.filter((b) => b.owner === null || (b.owner !== entity.owner && alive?.[b.owner] !== false && !teammate(b.owner))) : [];
    for (let player = 0; player < entities.bodies.length; player++) {
      checkpoint?.();
      if (alive?.[player] === false) continue;
      if (entity.target !== undefined && entity.target !== player) continue;
      if (entity.owner === player && !entity.hitsOwner) continue;
      if (teammate(player)) continue;
      const key = `${player}|${entity.id}`;
      if (entity.kind === 'strike' && (struck.has(key) || pending.has(key))) continue;
      const body = entities.bodies[player];
      const reached = blockers.length ? firstContact(entity, body, blockers, checkpoint) : touches(entity, body) ? 'body' : null;
      if (reached === null) continue;
      if (entity.kind === 'strike') pending.add(key);
      const fullDamage = entity.kind === 'strike' ? entity.damage : entity.damage * Math.max(0, dtMs) / 1000;
      const hit: DamageHit = { entity: entity.id, label: entity.label, kind: entity.kind, owner: entity.owner, player, damage: 0, fullDamage };
      if (reached === 'body') {
        hit.damage = fullDamage * body.guard;
        damage[player] += hit.damage;
      } else hit.blockedBy = reached;
      hits.push(hit);
    }
  }
  checkpoint?.();
  if (checkpoint) for (const key of pending) struck.add(key);
  return { damage, hits };
}

/** Attribute each confirmed knockout to the contact that exhausted health,
 * rather than the first contact against a player who ended the tick at zero. */
export function confirmedEliminations(before: readonly { hp: number }[], after: readonly { hp: number }[], hits: readonly DamageHit[]): ConfirmedElimination[] {
  const pending = before.map((player, index) => player.hp > 0 && after[index]?.hp === 0);
  const damage = before.map(() => 0);
  const result: ConfirmedElimination[] = [];
  for (const hit of hits) {
    const player = hit.player;
    if (!pending[player] || !(hit.damage > 0) || hit.blockedBy) continue;
    // Match resolveDamage's addition order exactly. Repeated subtraction can
    // leave a tiny positive remainder for a fractional-health knockout.
    damage[player] += hit.damage;
    if (damage[player] >= before[player].hp) { pending[player] = false; result.push({ player, hit: { ...hit } }); }
  }
  return result;
}

/** Open sessions can last indefinitely. Unique entity IDs let their completed
 * strikes retire; keep only current strikes so hit bookkeeping remains bounded. */
export function retireSessionStrikes(entities: CheckedEntities | null, struck: Set<string>): void {
  const current = new Set(entities?.damage.filter(entity => entity.kind === 'strike').map(entity => entity.id));
  for (const key of struck) if (!current.has(key.slice(key.indexOf('|') + 1))) struck.delete(key);
}
