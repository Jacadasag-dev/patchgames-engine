import { describe, expect, it, vi } from 'vitest';
import { Euler, Quaternion } from 'three';
import {
  AnimationPlayer, AnimationPoseBuffer, AnimationTransformBuffer, blendAnimationPoses, composeAnimationLayers, defineAnimationClip,
  multiplyAnimationQuaternions, quaternionFromEuler, sampleAnimationClip, sampleAnimationClipReadonly, slerpAnimationQuaternions,
  validateAnimationPose, validateAnimationPoseReadonly, type AnimationPose, type AnimationQuaternion,
} from '../../src/sandbox/animation.ts';

const vector = (x: number, y = 0, z = 0) => ({ x, y, z });
const constant = (pose: AnimationPose, durationMs = 1_000) => defineAnimationClip({ durationMs, keyframes: [{ atMs: 0, pose }] });
const rotationClose = (actual: AnimationQuaternion, expected: Quaternion) => {
  // q and -q describe the same orientation.
  const alignment = Math.abs(actual.x * expected.x + actual.y * expected.y + actual.z * expected.z + actual.w * expected.w);
  expect(alignment).toBeCloseTo(1, 10);
};

describe('shared sampling and reusable pose storage', () => {
  it('packs rig channels with exact validator values without aliasing input or unmapped scratch channels', () => {
    const buffer = new AnimationTransformBuffer(['first', 'second']), other = new AnimationTransformBuffer(['first', 'second']);
    const input = { second: { scale: vector(2, -3, .125) }, first: {
      position: vector(-0, 1.23456789012345, -9999), rotation: { x: -0, y: -.43, z: .71, w: .59 },
    }, unmapped: { position: vector(99), rotation: { x: 1, y: 2, z: 3, w: 4 }, scale: vector(8, 9, 10) } };
    const expected = validateAnimationPose(input);
    const report = buffer.read(input);
    expect(report).toEqual({ mapped: 2, unmapped: ['unmapped'] });
    expect([...buffer.channels]).toEqual([3, 4]);
    expect([...buffer.values.slice(0, 7)]).toEqual([
      expected.first.position!.x, expected.first.position!.y, expected.first.position!.z,
      expected.first.rotation!.x, expected.first.rotation!.y, expected.first.rotation!.z, expected.first.rotation!.w,
    ]);
    expect([...buffer.values.slice(17, 20)]).toEqual([2, -3, .125]);
    other.read(input);
    input.first.position.x = 42;
    buffer.read({ first: { position: vector(123) } });
    expect([...buffer.channels]).toEqual([1, 0]);
    expect(Object.is(other.values[0], -0)).toBe(true);
    expect(Object.is(other.values[3], -0)).toBe(true);
    expect(report.unmapped).toEqual(['unmapped']);
    expect(buffer.read({})).toEqual({ mapped: 0, unmapped: [] });
    expect([...buffer.channels]).toEqual([0, 0]);
    expect(() => buffer.read({ unmapped: { rotation: { x: 0, y: 0, z: 0, w: 0 } } })).toThrow('must not be zero');
    expect(() => buffer.read({ second: { scale: vector(NaN) } })).toThrow('finite');
    expect(() => buffer.read({ second: { unknown: 1 } } as unknown as AnimationPose)).toThrow('unknown');
    expect(() => buffer.read(Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`joint${i}`, {}])))).toThrow('128');
    expect(buffer.read({ second: { position: vector(7) } })).toEqual({ mapped: 1, unmapped: [] });
    expect([...buffer.channels]).toEqual([0, 1]);
    expect(buffer.values[10]).toBe(7);
  });

  it('lends exact immutable samples to engine readers without changing public ownership or callback execution', () => {
    const clip = defineAnimationClip({ durationMs: 1000, keyframes: [
      { atMs: 0, pose: { joint: { position: vector(0), rotation: quaternionFromEuler({ y: .17 }) } } },
      { atMs: 1000, pose: { joint: { position: vector(10), rotation: quaternionFromEuler({ y: 1.39 }) } } },
    ] });
    const shared = sampleAnimationClipReadonly(clip, 1000 / 240);
    expect(sampleAnimationClipReadonly(clip, 1000 / 240)).toBe(shared);
    expect(Object.isFrozen(shared)).toBe(true);
    expect(Object.isFrozen(shared.joint)).toBe(true);
    expect(Object.isFrozen(shared.joint.position)).toBe(true);
    expect(Object.isFrozen(shared.joint.rotation)).toBe(true);
    expect(() => { shared.joint.position!.x = 999; }).toThrow();
    const publicPose = sampleAnimationClip(clip, 1000 / 240);
    expect(publicPose).toEqual(shared);
    publicPose.joint.position!.x = 999;
    expect(sampleAnimationClipReadonly(clip, 1000 / 240)).toEqual(shared);
    expect(shared.joint.position!.x).not.toBe(999);
    expect(() => sampleAnimationClipReadonly(clip, 1000 / 240, { parameters: { invalid: NaN } })).toThrow('finite');
    let calls = 0;
    const procedural = defineAnimationClip({ durationMs: 1000, sample: () => ({ joint: { position: vector(++calls) } }) });
    expect(sampleAnimationClipReadonly(procedural, 0).joint.position!.x).toBe(1);
    expect(sampleAnimationClipReadonly(procedural, 0).joint.position!.x).toBe(2);
    expect(sampleAnimationClip(procedural, 0).joint.position!.x).toBe(3);
  });

  it('shares the exact next validation only for private immutable samples', () => {
    const clip = constant({ joint: { rotation: { x: .23, y: -.43, z: .71, w: .59 } } });
    const shared = sampleAnimationClipReadonly(clip, 0);
    const validated = validateAnimationPoseReadonly(shared);
    expect(validated).toEqual(validateAnimationPose(shared));
    expect(validateAnimationPoseReadonly(shared)).toBe(validated);
    expect(Object.isFrozen(validated.joint.rotation)).toBe(true);
    const authored = { joint: { rotation: { x: .23, y: -.43, z: .71, w: .59 } } };
    const first = validateAnimationPoseReadonly(authored);
    expect(Object.isFrozen(first)).toBe(false);
    expect(Object.isFrozen(first.joint.rotation)).toBe(false);
    expect(first.joint.rotation).not.toBe(authored.joint.rotation);
    authored.joint.rotation.w = 1.2;
    expect(validateAnimationPoseReadonly(authored)).toEqual(validateAnimationPose(authored));
    expect(validateAnimationPoseReadonly(authored)).not.toEqual(first);
    // Freezing only an authored dictionary never proves that its channels are immutable.
    Object.freeze(authored);
    const frozenFirst = validateAnimationPoseReadonly(authored);
    authored.joint.rotation.x = .7;
    expect(validateAnimationPoseReadonly(authored)).not.toEqual(frozenFirst);
    expect(validateAnimationPoseReadonly(validated)).toEqual(validateAnimationPose(validated));
    expect(validateAnimationPoseReadonly(validated)).not.toBe(validated);
  });
  it('shares exact keyframe interpolation across actors with bounded storage and detached results', () => {
    const clip = defineAnimationClip({ durationMs: 1000, loop: true, keyframes: [
      { atMs: 0, pose: { joint: { position: vector(0), rotation: quaternionFromEuler({ y: 0 }) } } },
      { atMs: 1000, pose: { joint: { position: vector(10), rotation: quaternionFromEuler({ y: 1 }) } } },
    ] });
    expect(defineAnimationClip(clip)).toBe(clip);
    const acos = vi.spyOn(Math, 'acos');
    try {
      const first = sampleAnimationClip(clip, 123.25);
      const calculations = acos.mock.calls.length;
      expect(calculations).toBeGreaterThan(0);
      for (let actor = 0; actor < 32; actor++) {
        const pose = sampleAnimationClip(clip, 123.25);
        expect(pose).toEqual(first);
        expect(pose.joint.position).not.toBe(first.joint.position);
        pose.joint.position!.x = 99;
      }
      expect(acos.mock.calls.length).toBe(calculations);
      expect(sampleAnimationClip(clip, 123.25).joint.position!.x).toBe(1.2325);
      expect(() => sampleAnimationClip(clip, 123.25, { parameters: { bad: NaN } })).toThrow('finite');
      for (let frame = 0; frame < 200; frame++) sampleAnimationClip(clip, frame);
      const before = acos.mock.calls.length;
      expect(sampleAnimationClip(clip, 123.25)).toEqual(first);
      expect(acos.mock.calls.length).toBeGreaterThan(before);
    } finally { acos.mockRestore(); }
  });

  it('keeps authored definitions and procedural samplers live instead of caching mutable state', () => {
    const frames = [{ atMs: 0, pose: { joint: { position: vector(1) } } }];
    const definition = { durationMs: 1000, keyframes: frames };
    expect(sampleAnimationClip(definition, 10).joint.position!.x).toBe(1);
    frames[0].pose.joint.position.x = 2;
    expect(sampleAnimationClip(definition, 10).joint.position!.x).toBe(2);
    let current = 0;
    const procedural = defineAnimationClip({ durationMs: 1000, loop: true,
      sample: context => ({ joint: { position: vector(++current + context.cycle) } }) });
    expect(sampleAnimationClip(procedural, 10).joint.position!.x).toBe(1);
    expect(sampleAnimationClip(procedural, 10).joint.position!.x).toBe(2);
    expect(sampleAnimationClip(procedural, 1010).joint.position!.x).toBe(4);
  });

  it('reuses bounded joint/channel buffers without aliasing actors, retaining removed channels, or skipping validation', () => {
    const buffer = new AnimationPoseBuffer(), other = new AnimationPoseBuffer();
    const input = { joint: { position: vector(3), rotation: { x: 0, y: 0, z: 0, w: 2 } } };
    const first = buffer.read(input), position = first.joint.position, rotation = first.joint.rotation;
    expect(first.joint.position).not.toBe(input.joint.position);
    expect(other.read(input).joint.position).not.toBe(position);
    expect(rotation?.w).toBe(1);
    buffer.read({ replacement: { scale: vector(2, 2, 2) } });
    const again = buffer.read(input);
    expect(again.joint.position).toBe(position);
    expect(again.joint.rotation).toBe(rotation);
    expect(Object.keys(again)).toEqual(['joint']);
    expect(again.joint.scale).toBeUndefined();
    expect(() => buffer.read({ joint: { position: vector(Infinity) } })).toThrow('finite');
    expect(buffer.read(input)).toEqual(validateAnimationPose(input));
    expect(buffer.read(buffer.read(input))).toEqual(validateAnimationPose(input));
    for (let index = 0; index < 300; index++) buffer.read({ ['joint-' + index]: { position: vector(index) } });
    expect(Object.keys(buffer.read({}))).toEqual([]);
  });
});

describe('quaternion animation math', () => {
  it('matches Three XYZ radians with rotations on all three axes', () => {
    const angles = vector(0.37, -1.42, 2.5);
    rotationClose(quaternionFromEuler(angles), new Quaternion().setFromEuler(new Euler(angles.x, angles.y, angles.z, 'XYZ')));
  });

  it('takes the short arc through 180 degrees instead of reversing around the long way', () => {
    const from = quaternionFromEuler({ y: 170 * Math.PI / 180 });
    const to = quaternionFromEuler({ y: -170 * Math.PI / 180 });
    rotationClose(slerpAnimationQuaternions(from, to, 0.5), new Quaternion().setFromEuler(new Euler(0, Math.PI, 0)));
    rotationClose(slerpAnimationQuaternions(from, { x: -from.x, y: -from.y, z: -from.z, w: -from.w }, 0.4),
      new Quaternion(from.x, from.y, from.z, from.w));
  });

  it('composes noncommuting additive rotations as base times local delta', () => {
    const x = quaternionFromEuler({ x: Math.PI / 2 }), y = quaternionFromEuler({ y: Math.PI / 2 });
    const actual = multiplyAnimationQuaternions(x, y);
    rotationClose(actual, new Quaternion(x.x, x.y, x.z, x.w).multiply(new Quaternion(y.x, y.y, y.z, y.w)));
    expect(actual.z).toBeGreaterThan(0.4);
  });
});

describe('pose composition', () => {
  it('crossfades omitted joints back to rest and honors fractional custom-joint masks', () => {
    const from = { wingLeft: { position: vector(4) }, tailTip: { rotation: quaternionFromEuler({ z: 1 }) } };
    const mixed = blendAnimationPoses(from, {}, 0.5, { wingLeft: 0.5 });
    expect(mixed.wingLeft.position?.x).toBe(3);
    expect(mixed.tailTip.rotation).toEqual(from.tailTip.rotation);
  });

  it('masks upper-body attacks without erasing locomotion or undeclared channels', () => {
    const pose = composeAnimationLayers({ chest: { position: vector(0, 0.25), scale: vector(2, 2, 2) }, leftLeg: { position: vector(1) } }, [
      { pose: { chest: { rotation: quaternionFromEuler({ x: 1 }) }, leftLeg: { position: vector(99) } }, mask: { chest: 0.5 } },
    ]);
    expect(pose.chest.position).toEqual(vector(0, 0.25));
    expect(pose.chest.scale).toEqual(vector(2, 2, 2));
    rotationClose(pose.chest.rotation!, new Quaternion().setFromEuler(new Euler(0.5, 0, 0)));
    expect(pose.leftLeg.position?.x).toBe(1);
  });

  it('adds translation, multiplies scale, and composes weighted quaternion deltas in explicit order', () => {
    const base = { root: { position: vector(3), scale: vector(2, 3, 4), rotation: quaternionFromEuler({ x: 1 }) } };
    const result = composeAnimationLayers(base, [{ mode: 'additive', weight: 0.5,
      pose: { root: { position: vector(2, 4, 6), scale: vector(3, 1, 0.5), rotation: quaternionFromEuler({ y: 1 }) } } }]);
    expect(result.root.position).toEqual(vector(4, 2, 3));
    expect(result.root.scale).toEqual(vector(4, 3, 3));
    rotationClose(result.root.rotation!, new Quaternion().setFromEuler(new Euler(1, 0, 0)).multiply(new Quaternion().setFromEuler(new Euler(0, 0.5, 0))));
    expect(base.root.position).toEqual(vector(3));
  });

  it('validates without mutation and rejects malformed or unbounded output atomically', () => {
    const source = { root: { rotation: { x: 0, y: 0, z: 0, w: 2 } } };
    expect(validateAnimationPose(source).root.rotation?.w).toBe(1);
    expect(source.root.rotation.w).toBe(2);
    expect(() => validateAnimationPose({ root: { rotation: { x: 0, y: 0, z: 0, w: 0 } } })).toThrow(/must not be zero/);
    expect(() => validateAnimationPose({ root: { position: vector(Number.NaN) } })).toThrow(/finite/);
    expect(() => validateAnimationPose({ root: { rotate: { x: 90 } } } as unknown as AnimationPose)).toThrow(/rotate is unknown/);
    expect(() => composeAnimationLayers({}, [{ pose: {}, mask: { root: 2 } }])).toThrow(/finite|weight/);
    expect(() => validateAnimationPose(Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`joint${i}`, {}])))).toThrow(/128 joints/);
    const position = { root: { position: vector(9000) } };
    expect(() => composeAnimationLayers(position, [{ mode: 'additive', pose: { root: { position: vector(2000) } } }])).toThrow('finite');
    expect(position.root.position.x).toBe(9000);
    expect(() => composeAnimationLayers({ root: { scale: vector(100, 100, 100) } }, [
      { mode: 'additive', pose: { root: { scale: vector(200, 200, 200) } } },
    ])).toThrow('finite');
  });
});

describe('owned player composition', () => {
  it('matches two independent composition passes exactly at 240 Hz with and without actions and a reference base', () => {
    const clip = defineAnimationClip({ durationMs: 1000, loop: true, keyframes: [
      { atMs: 0, pose: { root: { position: vector(.2, -.1, .8), rotation: quaternionFromEuler({ x: .37, y: -.22, z: 1.83 }) } } },
      { atMs: 1000, pose: { root: { position: vector(.5, .2, -.3), rotation: quaternionFromEuler({ x: -1.11, y: .73, z: -.62 }) } } },
    ] });
    const attack = constant({ root: { rotation: { x: .3, y: -.4, z: .2, w: .7 }, scale: vector(1.2, .7, 1.1) } });
    const base = { root: { position: vector(.4), rotation: { x: .2, y: .3, z: .4, w: .5 }, scale: vector(1, 2, 3) }, other: { position: vector(2) } };
    const reference = { root: { rotation: { x: -.21, y: .38, z: -.49, w: .62 } } };
    const savedBase = structuredClone(base), savedReference = structuredClone(reference);
    for (const active of [false, true]) {
      const player = new AnimationPlayer({ motion: clip, attack });
      for (let frame = 0; frame < 12; frame++) {
        const timeMs = frame * 1000 / 240;
        const layers = [{ pose: sampleAnimationClip(clip, timeMs), weight: .63, mask: { root: .81 } }];
        const actions = active ? [{ pose: sampleAnimationClip(attack, timeMs), weight: .47, mode: 'additive' as const }] : [];
        const expected = composeAnimationLayers(composeAnimationLayers(base, layers), actions);
        const expectedReference = composeAnimationLayers(composeAnimationLayers(reference, layers), actions);
        const actual = player.sample({ timeMs, base, referenceBase: reference,
          layers: [{ clip: 'motion', weight: .63, mask: { root: .81 } }],
          actions: active ? [{ id: 'strike', clip: 'attack', startedAtMs: 0, weight: .47, mode: 'additive' }] : [],
        });
        expect(actual.pose).toEqual(expected);
        expect(actual.referencePose).toEqual(expectedReference);
        expect(actual.pose.root.rotation).not.toBe(actual.referencePose!.root.rotation);
        actual.pose.root.rotation!.w = 99;
        actual.pose.other.position!.x = 99;
        expect(actual.referencePose).toEqual(expectedReference);
      }
    }
    expect(base).toEqual(savedBase);
    expect(reference).toEqual(savedReference);
  });
});

describe('explicit clip time and synchronized phase', () => {
  const keys = [{ atMs: 0, pose: { tail: { position: vector(0) } } },
    { atMs: 1_000, pose: { tail: { position: vector(10) } } }];

  it('samples real elapsed time, holds one-shot endpoints and wraps looping clips', () => {
    const once = defineAnimationClip({ durationMs: 1_000, keyframes: keys });
    const loop = defineAnimationClip({ durationMs: 1_000, keyframes: keys, loop: true });
    expect(sampleAnimationClip(once, 250).tail.position?.x).toBe(2.5);
    expect(sampleAnimationClip(once, 1_500).tail.position?.x).toBe(10);
    expect(sampleAnimationClip(once, -100).tail.position?.x).toBe(0);
    expect(sampleAnimationClip(loop, 1_250).tail.position?.x).toBe(2.5);
    expect(sampleAnimationClip(loop, 1_000).tail.position?.x).toBe(0);
  });

  it('uses one gait phase across clips of different durations and deterministic procedural samplers', () => {
    const sample = ({ phase, cycle, parameters }: { phase: number; cycle: number; parameters: Readonly<Record<string, number | boolean>> }) =>
      ({ leg: { position: vector(phase, cycle, Number(parameters.stride ?? 1)) } });
    const fast = defineAnimationClip({ durationMs: 300, loop: true, sample });
    const slow = defineAnimationClip({ durationMs: 900, loop: true, sample });
    const options = { phase: 2.75, parameters: { stride: 3 } };
    expect(sampleAnimationClip(fast, 42, options)).toEqual(sampleAnimationClip(slow, 12_345, options));
    expect(sampleAnimationClip(slow, 0, options).leg.position).toEqual(vector(0.75, 2, 3));
  });

  it('owns immutable data clips and catches invalid procedural results on sampling', () => {
    const mutable = [{ atMs: 0, pose: { root: { position: vector(1) } } }];
    const clip = defineAnimationClip({ durationMs: 1_000, keyframes: mutable });
    mutable[0].pose.root.position.x = 50;
    expect(sampleAnimationClip(clip, 0).root.position?.x).toBe(1);
    expect(Object.isFrozen(clip.keyframes?.[0].pose.root.position)).toBe(true);
    expect(() => defineAnimationClip({ durationMs: 1_000, keyframes: [{ atMs: 20, pose: {} }] })).toThrow(/span time 0/);
    expect(() => sampleAnimationClip(defineAnimationClip({ durationMs: 1, sample: () => ({ bad: { scale: vector(Infinity) } }) }), 0)).toThrow(/finite/);
  });
});

describe('actor-local action playback', () => {
  const ramp = defineAnimationClip({ durationMs: 1_000, keyframes: [
    { atMs: 0, pose: { arm: { position: vector(0) } } }, { atMs: 1_000, pose: { arm: { position: vector(10) } } },
  ] });
  const action = { id: 'swing-1', clip: 'attack', startedAtMs: 100 };

  it('joins active actions at their current phase, ignores completed history, and never restarts repeated IDs', () => {
    const player = new AnimationPlayer({ attack: ramp });
    expect(player.sample({ timeMs: 600, actions: [action] }).pose.arm.position?.x).toBe(5);
    expect(player.sample({ timeMs: 800, actions: [action] }).pose.arm.position?.x).toBe(7);
    expect(player.sample({ timeMs: 900 }).pose.arm.position?.x).toBe(8);
    const completed = player.sample({ timeMs: 1_200, actions: [action] });
    expect(completed.pose).toEqual({});
    expect(completed.diagnostics.actions.every(item => item.status === 'completed')).toBe(true);
    const late = new AnimationPlayer({ attack: ramp }).sample({ timeMs: 5_000, actions: [action] });
    expect(late.pose).toEqual({});
  });

  it('plays genuinely new repeated attacks as new instances', () => {
    const player = new AnimationPlayer({ attack: ramp });
    player.sample({ timeMs: 700, actions: [action] });
    const next = player.sample({ timeMs: 800, actions: [{ ...action, id: 'swing-2', startedAtMs: 750 }] });
    expect(next.pose.arm.position?.x).toBe(0.5);
    expect(next.diagnostics.actions.find(item => item.id === 'swing-1')?.status).toBe('suppressed');
  });

  it('rejects rewriting an instance start or clip both during and after its original playback', () => {
    const player = new AnimationPlayer({ attack: ramp, other: ramp });
    player.sample({ timeMs: 100, actions: [action] });
    const rewritten = player.sample({ timeMs: 800, actions: [{ ...action, startedAtMs: 700 }] });
    expect(rewritten.pose.arm.position?.x).toBe(7);
    expect(rewritten.diagnostics.warnings).toEqual([`Action ${action.id} changed its start or clip; use a new instance ID`]);
    expect(player.sample({ timeMs: 2_000, actions: [{ ...action, startedAtMs: 1_900 }] }).pose).toEqual({});
    expect(player.sample({ timeMs: 2_100, actions: [{ ...action, clip: 'other', startedAtMs: 2_000 }] }).pose).toEqual({});
  });

  it('does not resurrect an interrupted long action when joining after the interrupt has completed', () => {
    const player = new AnimationPlayer({ attack: constant({ arm: { position: vector(1) } }, 2_000), hit: constant({ arm: { position: vector(9) } }, 300) });
    const attack = { ...action, startedAtMs: 0, priority: 1 };
    const hit = { id: 'hit-1', clip: 'hit', startedAtMs: 100, priority: 2 };
    const joined = player.sample({ timeMs: 500, actions: [hit, attack] });
    expect(joined.pose).toEqual({});
    expect(joined.diagnostics.actions.some(item => item.id === attack.id && item.status === 'suppressed')).toBe(true);
    expect(player.sample({ timeMs: 600, actions: [attack] }).pose).toEqual({});
  });

  it('does not let delayed older instances override newer actions or completed history interrupt later actions', () => {
    const player = new AnimationPlayer({ attack: ramp });
    const newer = { ...action, id: 'newer', startedAtMs: 500 };
    player.sample({ timeMs: 600, actions: [newer] });
    const delayed = player.sample({ timeMs: 700, actions: [action] });
    expect(delayed.pose.arm.position?.x).toBe(2);
    const old = { id: 'expired', clip: 'attack', startedAtMs: -600, priority: 10 };
    expect(player.sample({ timeMs: 800, actions: [old] }).pose.arm.position?.x).toBe(3);
  });

  it('honors channel ownership, priority and interruption without resurrecting interrupted actions', () => {
    const player = new AnimationPlayer({ attack: constant({ arm: { position: vector(1) } }, 2_000), hit: constant({ arm: { position: vector(9) } }, 300) });
    const attack = { ...action, startedAtMs: 0, priority: 1 };
    const hit = { id: 'hit-1', clip: 'hit', startedAtMs: 100, priority: 2 };
    player.sample({ timeMs: 0, actions: [attack] });
    expect(player.sample({ timeMs: 100, actions: [attack, hit] }).pose.arm.position?.x).toBe(9);
    const end = player.sample({ timeMs: 500, actions: [attack, hit] });
    expect(end.pose).toEqual({});
    expect(end.diagnostics.actions.some(item => item.id === attack.id && item.status === 'suppressed')).toBe(true);
    const locked = new AnimationPlayer({ attack: ramp, hit: ramp });
    locked.sample({ timeMs: 100, actions: [{ ...action, interruption: 'never' }] });
    expect(locked.sample({ timeMs: 200, actions: [hit] }).diagnostics.actions.find(item => item.id === hit.id)?.status).toBe('suppressed');
  });

  it('treats equal-priority interruption rules explicitly', () => {
    const player = new AnimationPlayer({ attack: ramp });
    player.sample({ timeMs: 100, actions: [{ ...action, interruption: 'higher' }] });
    const result = player.sample({ timeMs: 300, actions: [{ ...action, id: 'new', startedAtMs: 200 }] });
    expect(result.pose.arm.position?.x).toBe(2);
    expect(result.diagnostics.actions.find(item => item.id === 'new')?.status).toBe('suppressed');
  });

  it('fades action influence back to locomotion while retaining undeclared channels', () => {
    const player = new AnimationPlayer({ move: constant({ arm: { position: vector(2) }, leg: { position: vector(3) } }), attack: constant({ arm: { position: vector(10) } }) });
    const result = player.sample({ timeMs: 900, layers: [{ clip: 'move' }], actions: [{ ...action, startedAtMs: 0, fadeOutMs: 200, mask: { arm: 1 } }] });
    expect(result.pose.arm.position?.x).toBe(6);
    expect(result.pose.leg.position?.x).toBe(3);
    expect(result.diagnostics.actions[0].weight).toBe(0.5);
    expect(player.sample({ timeMs: 1_000, layers: [{ clip: 'move' }] }).pose.arm.position?.x).toBe(2);
  });

  it('resets actor/session state without starting stale actions at zero or carrying previous channels', () => {
    const player = new AnimationPlayer({ attack: ramp });
    player.sample({ timeMs: 600, epoch: 'session-a', actions: [action] });
    const replaced = player.sample({ timeMs: 2_000, epoch: 'session-b', actions: [action] });
    expect(replaced.diagnostics.reset).toBe(true);
    expect(replaced.pose).toEqual({});
    const rewind = player.sample({ timeMs: 50, epoch: 'session-b', actions: [action] });
    expect(rewind.diagnostics.reset).toBe(true);
    expect(rewind.pose).toEqual({});
    expect(rewind.diagnostics.actions[0].status).toBe('future');
  });

  it('keeps a custom mechanical rig independent of humanoid names and reports missing clips', () => {
    const player = new AnimationPlayer({ open: constant({ 'door.hinge': { rotation: quaternionFromEuler({ y: 1 }) }, 'piston:inner': { position: vector(0, 1) } }) });
    const result = player.sample({ timeMs: 20, layers: [{ clip: 'absent' }, { id: 'mechanism', clip: 'open' }] });
    expect(result.pose['piston:inner'].position?.y).toBe(1);
    expect(result.diagnostics.layers.map(item => item.id)).toEqual(['mechanism']);
    expect(result.diagnostics.warnings).toEqual(['Missing animation clip: absent']);
  });

  it('produces identical results for identical explicit timelines and rejects runaway frame lists', () => {
    const run = () => {
      const player = new AnimationPlayer({ attack: ramp });
      return [100, 150, 300, 900, 1_200].map(timeMs => player.sample({ timeMs, actions: [action] }));
    };
    expect(run()).toEqual(run());
    expect(() => new AnimationPlayer({ attack: ramp }).sample({ timeMs: 0, layers: Array.from({ length: 33 }, () => ({ clip: 'attack' })) })).toThrow(/at most 32/);
  });

  it('handles 32 actor-local timelines without shared action state and at a stationary explicit time', () => {
    const walk = defineAnimationClip({ durationMs: 500, loop: true, sample: ({ phase }) => ({ leg: { position: vector(phase) } }) });
    const actors = Array.from({ length: 32 }, () => new AnimationPlayer({ walk, attack: ramp }));
    const snapshots = actors.map((player, i) => player.sample({ timeMs: 300, phase: 0.25, layers: [{ clip: 'walk' }],
      actions: i % 2 === 0 ? [action] : [] }));
    for (let i = 0; i < actors.length; i++) {
      expect(snapshots[i].pose.leg.position?.x).toBe(0.25);
      expect(snapshots[i].pose.arm?.position?.x).toBe(i % 2 === 0 ? 2 : undefined);
      expect(actors[i].sample({ timeMs: 300, phase: 0.25, layers: [{ clip: 'walk' }] }).pose).toEqual(snapshots[i].pose);
    }
  });
});
