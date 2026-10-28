// The locked damage rules (src/sandbox/damage.ts): contacts between damage
// entities and fighter bodies, strikes, zones, guard and owners.
import { describe, expect, it } from 'vitest';
import type { BlockerEntity, DamageEntity } from '../../src/shared/gameApi.ts';
import { readEntities, resolveDamage, retireSessionStrikes, touches } from '../../src/sandbox/damage.ts';

// A 2 m tall, 0.5 m thick fighter standing at the origin: spine from y 0.5 to 1.5.
const body = { at: { x: 0, y: 0, z: 0 }, radius: 0.5, height: 2, guard: 1 };
const sphere = (x: number, y: number, z: number, radius = 0.1, extra: Partial<DamageEntity> = {}): DamageEntity =>
  ({ id: 'e', label: 'test', kind: 'strike', damage: 10, owner: null, shape: 'sphere', at: { x, y, z }, radius, ...extra });
const box = (x: number, y: number, z: number, half: number): DamageEntity =>
  ({ id: 'b', label: 'box', kind: 'zone', damage: 30, owner: null, shape: 'box', at: { x, y, z }, half: { x: half, y: half, z: half } });

describe('contacts', () => {
  it('touches a sphere within reach of the body, and not beyond', () => {
    expect(touches(sphere(0.55, 1, 0), body)).toBe(true);
    expect(touches(sphere(0.65, 1, 0), body)).toBe(false);
    // The capsule is rounded: above the head and below the feet reach less far sideways.
    expect(touches(sphere(0, 2.05, 0), body)).toBe(true);
    expect(touches(sphere(0.4, 2.05, 0), body)).toBe(false);
    expect(touches(sphere(0, -0.15, 0), body)).toBe(false);
  });

  it('sweeps a fast sphere along its path, so it cannot pass through a body', () => {
    const shot = sphere(5, 1, 0, 0.1, { from: { x: -5, y: 1, z: 0 } });
    expect(touches(shot, body)).toBe(true);
    expect(touches(sphere(5, 1, 0), body)).toBe(false);
    expect(touches(sphere(5, 3, 0, 0.1, { from: { x: -5, y: 3, z: 0 } }), body)).toBe(false);
  });

  it('touches a box the body stands in or brushes against', () => {
    expect(touches(box(0, 0, 0, 0.2), body)).toBe(true);
    expect(touches(box(0.95, 1, 0, 0.5), body)).toBe(true);
    expect(touches(box(1.05, 1, 0, 0.5), body)).toBe(false);
    expect(touches(box(0, 3, 0, 0.4), body)).toBe(false);
    expect(touches(box(0, -1, 0, 0.4), body)).toBe(false);
  });
});

describe('damage', () => {
  it('bounds open-session strike bookkeeping while retaining active strike hits', () => {
    const struck = new Set<string>();
    for (let step = 0; step < 1000; step++) {
      const entities = readEntities({ bodies: [body], damage: [sphere(0, 1, 0, 1, { id: `strike-${step}` })] }, 1);
      expect(resolveDamage(entities, struck, 33, [true]).damage).toEqual([10]);
      retireSessionStrikes(entities, struck);
      expect(struck.size).toBe(1);
      expect(resolveDamage(entities, struck, 33, [true]).hits).toEqual([]);
    }
    retireSessionStrikes(null, struck); expect(struck.size).toBe(0);
  });

  const both = (damage: DamageEntity[], guard = [1, 1]) => readEntities({
    bodies: [{ ...body, guard: guard[0] }, { ...body, at: { x: 10, y: 0, z: 0 }, guard: guard[1] }], damage });

  it('strikes each fighter once, by id, and zones hurt per second of contact', () => {
    const struck = new Set<string>();
    const punch = sphere(10, 1, 0, 0.2, { id: 'punch', owner: 0 });
    expect(resolveDamage(both([punch]), struck, 33).damage).toEqual([0, 10]);
    expect(resolveDamage(both([punch]), struck, 33).damage).toEqual([0, 0]);
    expect(resolveDamage(both([{ ...punch, id: 'punch-2' }]), struck, 33).damage).toEqual([0, 10]);
    const lava = { ...box(10, 0, 0, 1), id: 'lava' };
    for (let i = 0; i < 2; i++) expect(resolveDamage(both([lava]), struck, 500).damage).toEqual([0, 15]);
  });

  it('applies guard, and hits its owner only when asked', () => {
    const struck = new Set<string>();
    const result = resolveDamage(both([sphere(10, 1, 0, 0.2, { id: 'a', owner: 0 })], [1, 0.2]), struck, 33);
    expect(result.damage).toEqual([0, 2]);
    expect(result.hits).toEqual([{ entity: 'a', label: 'test', kind: 'strike', owner: 0, player: 1, damage: 2, fullDamage: 10 }]);
    expect(resolveDamage(both([sphere(0, 1, 0, 0.2, { id: 'own', owner: 0 })]), struck, 33).damage).toEqual([0, 0]);
    expect(resolveDamage(both([sphere(0, 1, 0, 0.2, { id: 'own', owner: 0, hitsOwner: true })]), struck, 33).damage).toEqual([10, 0]);
    // A hazard (no owner) hurts anyone it touches.
    expect(resolveDamage(both([sphere(0, 1, 0, 0.2, { id: 'spike' })]), struck, 33).damage).toEqual([10, 0]);
  });

  it('stops a strike at a blocker it reaches before the body, and only then', () => {
    // Fighter 1 at x = 10 holds a round shield (a disc) facing -x, half a meter in front.
    const shield = { id: 'shield', label: 'shield', kind: 'blocker' as const, owner: 1 as const, shape: 'disc' as const,
      at: { x: 9.2, y: 1, z: 0 }, normal: { x: -1, y: 0, z: 0 }, radius: 0.6 };
    const withShield = (damage: DamageEntity[], blockers: BlockerEntity[] = [shield]) => readEntities({
      bodies: [body, { ...body, at: { x: 10, y: 0, z: 0 } }], damage, blockers });
    const shotFrom = (fromX: number, toX: number, y = 1, extra: Partial<DamageEntity> = {}) =>
      sphere(toX, y, 0, 0.05, { id: `shot-${fromX}-${toX}-${y}`, owner: 0, from: { x: fromX, y, z: 0 }, ...extra });
    const struck = new Set<string>();
    // From the front: the shield takes it. Reported as blocked, no damage, and the shot is spent for fighter 1.
    const front = resolveDamage(withShield([shotFrom(8, 11)]), struck, 33);
    expect(front.damage).toEqual([0, 0]);
    expect(front.hits).toEqual([{ entity: 'shot-8-11-1', label: 'test', kind: 'strike', owner: 0, player: 1, damage: 0, fullDamage: 10, blockedBy: 'shield' }]);
    expect(resolveDamage(withShield([{ ...shotFrom(8, 11), from: { x: 10, y: 1, z: 0 } }]), struck, 33).damage).toEqual([0, 0]);
    // From behind, over the top, or past the rim: the body is reached first.
    expect(resolveDamage(withShield([shotFrom(12, 9)]), new Set(), 33).damage).toEqual([0, 10]);
    expect(resolveDamage(withShield([shotFrom(8, 11, 1.75)]), new Set(), 33).damage).toEqual([0, 10]);
    // Its owner's own strikes pass through it; hazards (no owner) are blocked like anyone's.
    expect(resolveDamage(withShield([shotFrom(8, 11, 1, { owner: 1, hitsOwner: true })]), new Set(), 33).damage).toEqual([0, 10]);
    expect(resolveDamage(withShield([shotFrom(8, 11, 1, { owner: null })]), new Set(), 33).damage).toEqual([0, 0]);
    // Zones pass through blockers.
    expect(resolveDamage(withShield([{ ...box(10, 0, 0, 1), id: 'lava' }]), new Set(), 500).damage).toEqual([0, 15]);
    // A fast shot can't tunnel through a thin shield between steps.
    expect(resolveDamage(withShield([shotFrom(0, 30)]), new Set(), 33).hits[0]?.blockedBy).toBe('shield');
    // Sphere and box blockers work the same way.
    const ball = { ...shield, id: 'bubble', shape: 'sphere' as const, at: { x: 10, y: 1, z: 0 }, radius: 1.2 };
    expect(resolveDamage(withShield([shotFrom(12, 9)], [ball]), new Set(), 33).damage).toEqual([0, 0]);
    const wall = { ...shield, id: 'wall', owner: null, shape: 'box' as const, at: { x: 5, y: 1, z: 0 }, half: { x: 0.1, y: 2, z: 2 } };
    expect(resolveDamage(withShield([shotFrom(0, 10)], [wall]), new Set(), 33).hits[0]?.blockedBy).toBe('wall');
  });

  it('explains what is wrong with bad entities, and needs none to do nothing', () => {
    expect(() => readEntities({ bodies: [body, body], damage: [], blockers: [{ id: 'b', label: 'shield', kind: 'blocker', owner: 0, shape: 'disc', at: { x: 0, y: 0, z: 0 }, radius: 1, normal: { x: 0, y: 0, z: 0 } }] })).toThrow('normal must not be zero');
    expect(() => readEntities({ bodies: [body, body], damage: [sphere(0, 0, 0)], blockers: [{ id: 'e', label: 'shield', kind: 'blocker', owner: 0, shape: 'sphere', at: { x: 0, y: 0, z: 0 }, radius: 1 }] })).toThrow('share the id "e"');
    expect(() => readEntities({ bodies: [body, body], damage: [], blockers: [{ id: 'b', label: 'shield', kind: 'wall', owner: 0, shape: 'sphere', at: { x: 0, y: 0, z: 0 }, radius: 1 }] })).toThrow("kind must be 'blocker'");
    expect(readEntities(undefined)).toBeNull();
    expect(resolveDamage(null, new Set(), 33).damage).toEqual([0, 0]);
    expect(() => readEntities({ bodies: [body], damage: [] })).toThrow('both fighters');
    expect(() => readEntities({ bodies: [body, { ...body, guard: 2 }], damage: [] })).toThrow('guard');
    expect(() => readEntities({ bodies: [body, body], damage: [sphere(0, 0, 0), sphere(1, 0, 0)] })).toThrow('share the id "e"');
    expect(() => readEntities({ bodies: [body, body], damage: [{ ...sphere(0, 0, 0), damage: -5 }] })).toThrow('damage');
    expect(() => readEntities({ bodies: [body, body], damage: [{ ...sphere(0, 0, 0), kind: 'heal' }] })).toThrow("'strike' or 'zone'");
    expect(() => readEntities({ bodies: [body, body], damage: [{ ...sphere(0, 0, 0), at: { x: Number.NaN, y: 0, z: 0 } }] })).toThrow('at.x');
    expect(() => readEntities({ bodies: [body, body], damage: Array.from({ length: 257 }, (_, i) => ({ ...sphere(0, 0, 0), id: `e${i}` })) })).toThrow('256');
  });
});
