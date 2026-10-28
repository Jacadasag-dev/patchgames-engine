import { afterEach, expect, it } from 'vitest';
import { Group, Mesh, MeshBasicMaterial, Object3D, Scene, Vector3 } from 'three';
import { createEquipmentOrientationSampler, getEquipmentMotionDefinition, registerEquipmentOrientation, requireEquipmentOrientation,
  type EquipmentOrientationDefinition } from '../../src/sandbox/equipmentOrientation.ts';
import { attachEquipment, createBowModel, createSwordModel } from '../../src/sandbox/equipmentView.ts';
import { registerInspectionActor, registerInspectionEquipment, setInspectionRenderHidden } from '../../src/sandbox/inspectionGeometry.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); });
function fixture() {
  const scene = new Scene(), actor = new Group(), hand = new Object3D(), model = new Group();
  actor.userData.inspectionActorId = 'player-1'; scene.add(actor); actor.add(hand); hand.add(model);
  const definition: EquipmentOrientationDefinition = { id: 'custom-tool', weight: 'heavy', grip: 'grip', points: [
    { id: 'grip', tags: ['grip'], position: { x: 0, y: 0, z: 0 } },
    { id: 'tip', tags: ['tip'], position: { x: 0, y: 1, z: 0 } },
    { id: 'edge', tags: ['sharp-edge'], position: { x: .04, y: .5, z: 0 } },
    { id: 'center', tags: ['blade'], position: { x: 0, y: .5, z: 0 } },
    { id: 'face', tags: ['flat-face'], position: { x: 0, y: .5, z: .02 } },
  ], directions: [
    { id: 'length', tags: ['tip'], from: 'grip', to: 'tip', motionPoint: 'tip' },
    { id: 'edge', tags: ['sharp-edge'], from: 'center', to: 'edge', motionPoint: 'tip' },
    { id: 'face', tags: ['flat-face'], from: 'center', to: 'face', motionPoint: 'tip' },
  ] };
  const sampler = createEquipmentOrientationSampler();
  return { scene, actor, hand, model, definition, sampler,
    register: () => cleanup.push(registerEquipmentOrientation(model, definition)),
    read: (timeMs: number) => sampler.sample({ timeMs, root: scene }) };
}
it('requires semantic orientation before attachment and does not mutate a rejected model', () => {
  const hand = new Object3D(), item = new Group(); item.name = 'unannotated sword';
  expect(() => attachEquipment(hand, item, {})).toThrow('registerEquipmentOrientation');
  expect(item.parent).toBeNull(); expect(hand.children).toEqual([]);
  const f = fixture(); f.register();
  expect(() => requireEquipmentOrientation(f.model)).not.toThrow();
});
it('rejects missing grip, ambiguous roll, invalid bindings, nonfinite points and excess metadata', () => {
  const f = fixture(), register = (definition: EquipmentOrientationDefinition) => registerEquipmentOrientation(f.model, definition);
  expect(() => register({ ...f.definition, grip: 'missing' })).toThrow('grip');
  expect(() => register({ ...f.definition, directions: [f.definition.directions[0], { id: 'reverse', tags: ['reverse'], from: 'tip', to: 'grip' }] })).toThrow('non-collinear');
  expect(() => register({ ...f.definition, points: f.definition.points.map(point => point.id === 'tip' ? { ...point, node: new Group() } : point) })).toThrow('descendant');
  expect(() => register({ ...f.definition, points: f.definition.points.map(point => point.id === 'tip' ? { ...point, position: { x: NaN, y: 0, z: 0 } } : point) })).toThrow('finite');
  expect(() => register({ ...f.definition, points: Array.from({ length: 17 }, (_, i) => ({ ...f.definition.points[0], id: String(i) })) })).toThrow('3..16');
  expect(() => register({ ...f.definition, directions: [...f.definition.directions, f.definition.directions[0]] })).toThrow('unique');
});
it('requires an explicit weight and bounds creative carry influence without inferring semantics from tags', () => {
  const f = fixture();
  for (const weight of [undefined, 'light', 'HEAVY', 10])
    expect(() => registerEquipmentOrientation(f.model, { ...f.definition, weight } as EquipmentOrientationDefinition)).toThrow('weight');
  for (const motionInfluence of [-.1, 1.1, NaN, Infinity])
    expect(() => registerEquipmentOrientation(f.model, { ...f.definition, motionInfluence })).toThrow('motionInfluence');
  expect(getEquipmentMotionDefinition(f.model)).toBeUndefined();
  f.definition.weight = 'xheavy'; f.definition.motionInfluence = 0; f.register();
  expect(f.read(0).items[0]).toMatchObject({ weight: 'xheavy', motionInfluence: 0, coverage: 'supported', warnings: [] });
  expect(getEquipmentMotionDefinition(f.model)).toEqual({ id: 'custom-tool', weight: 'xheavy', influence: 0 });
});
it('returns copied frozen carry metadata and retains the registered values when the author changes its source object', () => {
  const f = fixture(); f.register();
  const first = getEquipmentMotionDefinition(f.model)!;
  expect(first).toEqual({ id: 'custom-tool', weight: 'heavy', influence: 1 });
  expect(Object.isFrozen(first)).toBe(true); expect(getEquipmentMotionDefinition(f.model)).not.toBe(first);
  f.definition.weight = 'medium'; f.definition.motionInfluence = .25;
  expect(getEquipmentMotionDefinition(f.model)).toEqual(first);
  expect(f.read(0).items[0]).toMatchObject({ weight: 'heavy', motionInfluence: 1 });
});
it('samples actual transformed landmarks and authored directions under translation, rotation and nonuniform scaling', () => {
  const f = fixture(); f.actor.position.set(4, 2, -3); f.actor.rotation.set(.2, -.7, .3); f.actor.scale.set(1.5, 2, .7);
  f.hand.rotation.set(.3, .7, -.4); f.register();
  const sample = f.read(0).items[0]; expect(sample).toMatchObject({ itemId: 'custom-tool', actorId: 'player-1', coverage: 'supported' });
  const tip = sample.points.find(point => point.id === 'tip')!;
  expect(new Vector3(tip.position.x, tip.position.y, tip.position.z).distanceTo(f.model.localToWorld(new Vector3(0, 1, 0)))).toBeLessThan(1e-8);
  const edge = sample.directions.find(direction => direction.id === 'edge')!;
  const expected = f.model.localToWorld(new Vector3(.04, .5, 0)).sub(f.model.localToWorld(new Vector3(0, .5, 0))).normalize();
  expect(new Vector3(edge.direction.x, edge.direction.y, edge.direction.z).distanceTo(expected)).toBeLessThan(1e-8);
  expect(tip.velocity).toBeUndefined(); expect(edge.worldAlignment).toBeUndefined();
});
it('separates locomotion and actor turns from owner-relative weapon movement while preserving a translating slash', () => {
  const f = fixture(); f.register(); f.read(0);
  f.actor.position.x = .5; f.actor.rotation.y = .6;
  const running = f.read(100).items[0], tip = running.points.find(point => point.id === 'tip')!;
  expect(Math.hypot(tip.velocity!.x, tip.velocity!.y, tip.velocity!.z)).toBeGreaterThan(1);
  expect(Math.hypot(tip.ownerRelativeVelocity!.x, tip.ownerRelativeVelocity!.y, tip.ownerRelativeVelocity!.z)).toBeLessThan(1e-8);
  expect(running.directions.find(direction => direction.id === 'edge')!.ownerRelativeAlignment).toBeUndefined();
  f.hand.position.x += .2;
  const slash = f.read(200).items[0], slashTip = slash.points.find(point => point.id === 'tip')!;
  expect(Math.hypot(slashTip.ownerRelativeVelocity!.x, slashTip.ownerRelativeVelocity!.y, slashTip.ownerRelativeVelocity!.z)).toBeCloseTo(2);
  expect(Math.hypot(slashTip.gripRelativeVelocity!.x, slashTip.gripRelativeVelocity!.y, slashTip.gripRelativeVelocity!.z)).toBeLessThan(1e-8);
  expect(slash.directions.find(direction => direction.id === 'edge')!.ownerRelativeAlignment).toBeCloseTo(1);
  expect(slash.directions.find(direction => direction.id === 'face')!.ownerRelativeAlignment).toBeCloseTo(0);
});
it('reports flat-face versus edge leading numerically without inferring attack intent', () => {
  const f = fixture(); f.register(); f.read(0); f.hand.position.z = .1;
  const flat = f.read(100).items[0];
  expect(flat.directions.find(direction => direction.id === 'face')!.ownerRelativeAlignment).toBeCloseTo(1);
  expect(flat.directions.find(direction => direction.id === 'edge')!.ownerRelativeAlignment).toBeCloseTo(0);
  expect(flat.warnings).toEqual([]); expect(flat.coverage).toBe('supported');
});
it('follows dynamic bow nock/arrow nodes and discloses an invisible projectile landmark', () => {
  const scene = new Scene(), actor = new Group(), bow = createBowModel(); actor.userData.inspectionActorId = 'archer';
  cleanup.push(bow.dispose); scene.add(actor); actor.add(bow.root);
  const sampler = createEquipmentOrientationSampler(), initial = sampler.sample({ timeMs: 0, root: scene }).items[0];
  bow.setDraw(1, false);
  const drawn = sampler.sample({ timeMs: 100, root: scene }).items[0];
  const nock = drawn.points.find(point => point.id === 'nock')!, previous = initial.points.find(point => point.id === 'nock')!;
  expect(nock.position.z - previous.position.z).toBeCloseTo(-.38);
  expect(nock.ownerRelativeVelocity!.z).toBeCloseTo(-3.8);
  expect(drawn.points.find(point => point.id === 'arrow-tip')!.visible).toBe(false);
  expect(drawn.points.find(point => point.id === 'arrow-tip')!.velocity).toBeUndefined();
  expect(drawn.directions.find(direction => direction.id === 'shot')!.direction.z).toBeCloseTo(1);
  bow.setDraw(0, true);
  const revealed = sampler.sample({ timeMs: 200, root: scene }).items[0];
  expect(revealed.points.find(point => point.id === 'arrow-tip')!.velocity).toBeUndefined();
});
it('isolates sampler histories and omits velocities after hidden gaps, replacement, duplicate time, and reset', () => {
  const f = fixture(); f.register(); f.read(0); f.hand.position.x = 1;
  expect(createEquipmentOrientationSampler().sample({ timeMs: 100, root: f.scene }).items[0].points[0].velocity).toBeUndefined();
  f.model.visible = false; expect(f.read(100).items).toEqual([]); f.model.visible = true;
  expect(f.read(200).items[0].points[0].velocity).toBeUndefined();
  expect(f.read(200).items[0].points[0].velocity).toBeUndefined();
  f.register(); expect(f.read(220).items[0].points[0].velocity).toBeUndefined();
  expect(f.read(600).items[0].points[0].velocity).toBeUndefined();
  f.sampler.reset(); expect(f.read(700).items[0].points[0].velocity).toBeUndefined();
});
it('reports detached bindings and degenerate transforms as missing coverage instead of fabricated geometry', () => {
  const f = fixture(), child = new Group(); f.model.add(child);
  f.definition.points = f.definition.points.map(point => point.id === 'tip' ? { ...point, node: child } : point);
  f.register(); child.removeFromParent();
  expect(f.read(0).items[0]).toMatchObject({ coverage: 'partial', warnings: expect.arrayContaining(['Landmark tip is no longer attached to the item.']) });
  f.model.position.x = NaN;
  const broken = f.read(100); expect(broken.items).toEqual([]); expect(broken.coverage[0].status).toBe('unsupported');
});
it('supports unclassified custom item tags and cleans up model registration on disposal', () => {
  const f = fixture(); f.definition.directions = f.definition.directions.map(direction => ({ ...direction, tags: ['magic-paint', 'spray-mouth'] })); f.register();
  expect(f.read(0).items[0].directions[0].tags).toEqual(['magic-paint', 'spray-mouth']);
  const sword = createSwordModel(); f.scene.add(sword.root);
  expect(() => requireEquipmentOrientation(sword.root)).not.toThrow(); sword.dispose();
  expect(() => requireEquipmentOrientation(sword.root)).toThrow('requires');
});
it('preserves creator-defined axe surfaces without requiring sword or bow classifications', () => {
  const f = fixture(); f.definition.id = 'woodcutting-axe';
  f.definition.grip = 'handle-center';
  f.definition.points = f.definition.points.map(point => point.id === 'grip' ? { ...point, id: 'handle-center', tags: ['wrapped-handle'] }
    : point.id === 'edge' ? { ...point, tags: ['axe-cutting-edge', 'sharpside'] }
    : point.id === 'face' ? { ...point, tags: ['blunt-back', 'hammer-poll'] } : point);
  f.definition.directions = f.definition.directions.map(direction => ({ ...direction, from: direction.from === 'grip' ? 'handle-center' : direction.from,
    tags: direction.id === 'edge' ? ['axe-cutting-edge'] : direction.id === 'face' ? ['blunt-back'] : direction.tags }));
  f.register(); f.read(0); f.hand.position.z = .1;
  const item = f.read(100).items[0];
  expect(item.coverage).toBe('supported'); expect(item.warnings).toEqual([]);
  expect(item.grip).toBe('handle-center'); expect(item.points.find(point => point.id === 'handle-center')!.tags).toEqual(['wrapped-handle']);
  expect(item.directions.find(direction => direction.tags.includes('blunt-back'))!.ownerRelativeAlignment).toBeCloseTo(1);
  expect(item.points.find(point => point.id === 'face')!.tags).toEqual(['blunt-back', 'hammer-poll']);
});
it('shares overlap ownership and first-person visibility and exposes unannotated held items', () => {
  const f = fixture(); delete f.actor.userData.inspectionActorId;
  registerInspectionActor(f.actor, [], { id: 'stable-actor' });
  registerInspectionEquipment(f.model, []); f.register();
  f.actor.visible = false; setInspectionRenderHidden(f.actor, true);
  expect(f.read(0).items[0]).toMatchObject({ actorId: 'stable-actor', coverage: 'supported' });
  const missing = new Group(); missing.name = 'unknown-hammer'; f.hand.add(missing); registerInspectionEquipment(missing, []);
  expect(f.read(100).coverage).toContainEqual(expect.objectContaining({ actorId: 'stable-actor', status: 'unsupported', reason: expect.stringContaining('unknown-hammer') }));
  const coveredChild = new Group(); f.model.add(coveredChild); registerInspectionEquipment(coveredChild, []);
  expect(f.read(200).coverage.filter(value => value.status === 'unsupported')).toHaveLength(1);
});
it('renders optional semantic colors and follows moving debug landmarks without adding gameplay markers by default', () => {
  const plain = createSwordModel(), sword = createSwordModel({ markers: true }), bow = createBowModel({ markers: true });
  cleanup.push(plain.dispose, sword.dispose, bow.dispose);
  expect(plain.root.getObjectByName('equipment-orientation-markers')).toBeUndefined();
  const edge = sword.root.getObjectByName('orientation-point:edge-left')! as Mesh;
  const face = sword.root.getObjectByName('orientation-point:face-front')! as Mesh;
  expect(edge.userData.orientationTags).toContain('sharp-edge'); expect(face.userData.orientationTags).toContain('flat-face');
  expect((edge.material as MeshBasicMaterial).color.getHex()).not.toEqual((face.material as MeshBasicMaterial).color.getHex());
  const nock = bow.root.getObjectByName('orientation-point:nock')!, previous = nock.position.clone();
  bow.setDraw(1);
  expect(nock.position.z - previous.z).toBeCloseTo(-.38);
  expect(bow.root.getObjectByName('orientation-direction:shot')!.userData.orientationTags).toContain('aim');
});
it('retains distinct evidence and reports incomplete coverage for duplicate item IDs on one actor', () => {
  const scene = new Scene(), actor = new Group(); scene.add(actor); actor.userData.inspectionActorId = 'dual-wielder';
  const left = createSwordModel(), right = createSwordModel(), third = createSwordModel({ orientationId: 'sword#duplicate-2' });
  cleanup.push(left.dispose, right.dispose, third.dispose); actor.add(left.root, right.root, third.root); left.root.position.x = -.4; right.root.position.x = .4;
  const read = createEquipmentOrientationSampler().sample({ timeMs: 0, root: scene });
  expect(read.items).toHaveLength(3); expect(new Set(read.items.map(item => item.itemId)).size).toBe(3);
  expect(read.items.filter(item => item.warnings.some(warning => warning.startsWith('Duplicate item ID')))).toHaveLength(2);
  expect(read.coverage).toContainEqual(expect.objectContaining({ actorId: 'dual-wielder', status: 'partial', reason: expect.stringContaining('unique authored orientationId') }));
  expect(read.items.find(item => item.itemId === 'sword#duplicate-3')!.points.find(point => point.id === 'grip')!.position.x).toBeCloseTo(.4);
});
it('samples an annotated outer item once when its nested reference model also has metadata', () => {
  const f = fixture(), sword = createSwordModel(); cleanup.push(sword.dispose); f.model.add(sword.root); f.register();
  const read = f.read(0); expect(read.items.map(item => item.itemId)).toEqual(['custom-tool']);
  expect(read.coverage.some(value => value.status === 'unsupported')).toBe(false);
});
