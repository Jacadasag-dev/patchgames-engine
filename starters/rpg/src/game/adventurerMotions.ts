import { defineAnimationClip, sampleAnimationClip, quaternionFromEuler, type AnimationClip, type AnimationPose, type AnimationJointTransform } from '../sandbox/animation.ts';
import { solveTwoBone } from '../sandbox/locomotion.ts';

export const ADVENTURER_ATTACK_SECONDS = [0.58, 0.55, 0.7, 0.62, 0.34] as const;
export const ADVENTURER_SKILL_SECONDS = [2.5, 0.6, 0.6, 0.6, 0.28] as const;
export const ADVENTURER_STRIDE_LENGTH = 1.8;
export interface AdventurerMotionContext { time: number; movement: number; attackCount: number }
const TAU = Math.PI * 2;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const rotation = (x = 0, y = 0, z = 0) => ({ rotation: quaternionFromEuler({ x, y, z }) });
const position = (x = 0, y = 0, z = 0) => ({ position: { x, y, z } });

/** One presentation clock drives arm reach, string, nock and arrow visibility.
 * This does not schedule or alter the campaign's authoritative ranged damage. */
export function adventurerBowAction(progress: number) {
  if (!Number.isFinite(progress) || progress < 0 || progress >= 1)
    return { raised: 0, draw: 0, released: false, nocked: false };
  // Ranger damage is already resolved during a 180ms attack window. Release
  // at 121ms of its 550ms presentation clip; the remainder is arm recovery.
  return { raised: smooth(progress / .12) * (1 - smooth((progress - .55) / .45)),
    draw: smooth(progress / .15) * (1 - smooth((progress - .22) / .07)),
    released: progress >= .22, nocked: progress < .22 };
}

/** Campaign actions were authored around the lower torso pivot. Keep that
 * pivot on the richer shared spine instead of rotating only its top segment. */
function campaignTorso(clip: AnimationClip, fullBody = false): AnimationClip {
  return defineAnimationClip({ durationMs: clip.durationMs, loop: clip.loop, sample: context => {
    const pose: Record<string, AnimationJointTransform> = { ...sampleAnimationClip(clip, context.timeMs) };
    if (pose.chest) { pose['spine-1'] = pose.chest; delete pose.chest; }
    if (fullBody) for (const joint of ['spine-2', 'spine-3', 'spine-4', 'chest', 'neck-1', 'neck-2',
      'left-clavicle', 'right-clavicle', 'left-toe', 'right-toe', 'left-hand', 'right-hand']) pose[joint] = rotation();
    return pose;
  } });
}

/** Editable motions use semantic joints and reference-rig deltas, with no scene
 * nodes, game-state fields or class geometry. Compatible avatars can reuse them. */
export function adventurerLocomotionPose(role: number, phase: number, stride: number): AnimationPose {
    const gait = phase * TAU, wave = Math.sin(gait);
    // A running crouch creates enough leg reach for the declared reference
    // stride; the stance half-cycle travels half of that cycle's distance.
    const bob = (-0.15 + Math.abs(Math.cos(gait)) * 0.025) * stride;
    const pose: Record<string, AnimationJointTransform> = {
      hips: { ...position(0, bob), ...rotation(0, wave * 0.045 * stride, -wave * 0.035 * stride) },
      chest: rotation(-stride * (role === 4 ? 0.19 : 0.09), -wave * 0.085 * stride),
      head: rotation(0, 0, wave * 0.025 * stride),
      cloak: rotation(-0.08 - stride * 0.27 + Math.sin(gait + 1) * 0.085 * stride, 0, wave * 0.06 * stride),
      'left-shoulder': rotation(-wave * stride * 0.43 - 0.12, 0, role === 4 ? 0.2 : 0.1),
      'right-shoulder': rotation(wave * stride * 0.43 - 0.12, 0, role === 4 ? -0.2 : -0.1),
      'left-elbow': rotation(-0.22 - stride * 0.23 - (role === 4 ? 0.25 : 0)),
      'right-elbow': rotation(-0.22 - stride * 0.23 - (role === 4 ? 0.25 : 0)),
      'left-hand': rotation(), 'right-hand': rotation(),
    };
    if (role === 0 || role === 1) {
      pose['left-shoulder'] = rotation((role === 0 ? -0.35 : -0.5) - wave * stride * (role === 0 ? 0.2 : 0.15), 0, 0.1);
      pose['left-elbow'] = rotation(role === 0 ? -0.55 : -0.6);
    } else if (role === 2 || role === 3) {
      pose['right-shoulder'] = rotation(-0.25 + wave * stride * 0.16, 0, -0.1);
      pose['right-elbow'] = rotation(-0.48);
    }
    for (const [name, offset, side] of [['left', 0, -1], ['right', 0.5, 1]] as const) {
      const cycle = (phase + offset) % 1, swing = cycle < 0.5;
      const progression = swing ? smooth(cycle * 2) : 1 - (cycle - 0.5) * 2;
      const forward = (progression - 0.5) * ADVENTURER_STRIDE_LENGTH * 0.5 * stride;
      const lift = swing ? Math.sin(cycle * TAU) * 0.16 * stride : 0;
      const angles = solveTwoBone({ target: { forward, up: -0.795 + lift - bob }, upperLength: 0.41, lowerLength: 0.4 });
      pose[`${name}-hip`] = rotation(angles.rootAngle, 0, side * 0.025);
      pose[`${name}-knee`] = rotation(angles.bendAngle);
      pose[`${name}-foot`] = rotation(angles.endAngle + (swing ? Math.sin(cycle * TAU) * 0.13 * stride : 0), 0, -side * 0.025);
    }
    return pose;
}

export function adventurerClips(role: number, context: () => AdventurerMotionContext) {
  const locomotion = defineAnimationClip({ durationMs: 1000, loop: true,
    sample: ({ phase }) => adventurerLocomotionPose(role, phase, context().movement) });
  const breathing = defineAnimationClip({ durationMs: 1000, loop: true, sample: () => {
    const { time, movement } = context();
    return { chest: position(0, Math.sin(time * 2.6) * 0.008 * (1 - movement)),
      head: rotation(0, Math.sin(time * 0.9) * 0.028 * (1 - movement)), cloak: rotation(0, Math.sin(time * 1.7) * 0.025) };
  } });
  const equipment = defineAnimationClip({ durationMs: 1000, loop: true, sample: (): AnimationPose => {
    const { time, movement } = context();
    const pose: Record<string, AnimationJointTransform> = {
      cloak: rotation(-.08 - movement * .25 + Math.sin(time * 7) * .06 * movement, 0, Math.sin(time * 5) * .035 * movement),
    };
    // Small additive carry offsets retain the recorded arm swing underneath.
    if (role === 0 || role === 1) {
      pose['left-shoulder'] = rotation(role === 0 ? -.18 : -.28, 0, .05);
      pose['left-elbow'] = rotation(role === 0 ? -.2 : -.25);
    } else if (role === 2 || role === 3) {
      pose['right-shoulder'] = rotation(-.12, 0, -.04);
      pose['right-elbow'] = rotation(-.18);
    } else {
      pose['left-elbow'] = pose['right-elbow'] = rotation(-.15);
    }
    return pose;
  } });
  const attack = defineAnimationClip({ durationMs: ADVENTURER_ATTACK_SECONDS[role] * 1000, sample: ({ phase: progress }) => {
    const wind = smooth(progress / 0.25), cut = smooth((progress - 0.25) / 0.24), recovery = smooth((progress - 0.52) / 0.48), energy = 1 - recovery;
    const pose: Record<string, AnimationJointTransform> = {};
    if (role === 0) {
      pose.chest = rotation(0, (-wind * 0.42 + cut * 0.85) * energy);
      pose['right-shoulder'] = rotation((-0.3 - wind * 2 + cut * 2.9) * energy - 0.12 * recovery, -0.35 * wind * energy, (-0.2 - wind * 0.35 + cut * 0.25) * energy);
      pose['right-elbow'] = rotation(-0.35 - wind * (1 - cut) * 0.8);
      pose['left-shoulder'] = rotation(-0.8 * energy, 0, 0.1);
    } else if (role === 1) {
      const bow = adventurerBowAction(progress), release = smooth((progress - 0.22) / 0.07);
      // Bring the bow shoulder forward; both 0.6m arm chains can then reach
      // the grip/nock without stretching through the wide reference torso.
      pose.chest = rotation(0, .65 * bow.raised);
      pose['left-shoulder'] = rotation(-1.3 * bow.raised, 0.18 * bow.raised, 0.12);
      pose['left-elbow'] = rotation(-0.2 - (1 - wind) * 0.5);
      pose['right-shoulder'] = rotation(-1.1 * energy, -0.65 * energy, (-0.6 + wind * 0.2 - release * 0.25) * energy);
      pose['right-elbow'] = rotation(-(0.85 + wind * 0.7 - release * 0.9) * energy);
    } else if (role === 2 || role === 3) {
      pose.chest = rotation(0, -Math.sin(progress * Math.PI) * 0.14);
      pose['right-shoulder'] = rotation((-0.3 - wind * 0.75 + cut * 0.5) * energy, 0, -0.25 * energy);
      pose['right-elbow'] = rotation(-0.7);
      pose['left-shoulder'] = rotation((-0.35 - wind * 0.65 - cut * 0.45) * energy, 0.2 * energy, 0.32 * energy);
      pose['left-elbow'] = rotation((-1.3 + cut * 1.1) * energy);
      pose['left-hand'] = rotation(0, 0, -0.4 * energy);
    } else {
      const side = context().attackCount % 2 ? 1 : -1, hand = side > 0 ? 'right' : 'left';
      pose.chest = rotation(-cut * energy * 0.12, side * (-wind * 0.3 + cut * 0.7) * energy);
      pose[`${hand}-shoulder`] = rotation((-0.4 - wind * 0.25 - cut * 0.95) * energy, -side * 0.2 * energy, -side * 0.2);
      pose[`${hand}-elbow`] = rotation((-1.6 + cut * 1.5) * energy - 0.4 * recovery);
      pose[`${hand}-hand`] = rotation(-0.45 * cut * energy);
    }
    return pose;
  } });
  const skill = defineAnimationClip({ durationMs: ADVENTURER_SKILL_SECONDS[role] * 1000 + 250, sample: (): AnimationPose => {
    if (role === 0) return { 'left-shoulder': rotation(-1.1, -0.35, 0.1), 'left-elbow': rotation(-0.6), chest: rotation(0.1) };
    if (role === 1) return { 'left-shoulder': rotation(-1.8, 0, 0.1), 'left-elbow': rotation(-0.15), 'right-shoulder': rotation(-1.3, -0.6, -0.55), 'right-elbow': rotation(-1.5), head: rotation(-0.2) };
    if (role === 2 || role === 3) return { 'right-shoulder': rotation(-0.95, 0, -0.1), 'left-shoulder': rotation(-1.55, 0.2, 0.65), 'left-elbow': rotation(-0.65), head: rotation(-0.18) };
    return { chest: rotation(-0.48), 'left-shoulder': rotation(0.7, 0, 0.2), 'right-shoulder': rotation(0.7, 0, -0.2), 'left-elbow': rotation(-0.5), 'right-elbow': rotation(-0.5), cloak: rotation(-0.63) };
  } });
  const revive = defineAnimationClip({ durationMs: 1000, loop: true, sample: () => ({
    hips: position(0, -0.32), chest: rotation(0.4), head: rotation(-0.35),
    'left-hip': rotation(-1.37), 'left-knee': rotation(1.43), 'left-foot': rotation(-0.06),
    'right-hip': rotation(-0.2), 'right-knee': rotation(2), 'right-foot': rotation(-0.4),
    'left-shoulder': rotation(-0.9, 0, 0.1), 'right-shoulder': rotation(-0.9, 0, -0.1),
    'left-elbow': rotation(-0.55 + Math.sin(context().time * 5) * 0.08), 'right-elbow': rotation(-0.55 + Math.sin(context().time * 5) * 0.08),
  }) });
  const downed = defineAnimationClip({ durationMs: 1000, loop: true, sample: () => ({
    hips: { ...position(0, -0.68), ...rotation() }, chest: rotation(0.73 + Math.sin(context().time * 2.6) * 0.015, 0, 0.3), head: rotation(0.25),
    'left-hip': rotation(-2.19, 0, -0.18), 'left-knee': rotation(1.7), 'left-foot': rotation(0.49, 0, 0.18),
    'right-hip': rotation(-2.02, 0, 0.18), 'right-knee': rotation(1.26), 'right-foot': rotation(0.76, 0, -0.18),
    'left-shoulder': rotation(role === 0 ? -1.3 : -0.28, 0, 0.3), 'left-elbow': rotation(role === 0 ? -0.65 : -0.2),
    'right-shoulder': rotation(-0.9, -0.3, -0.2), 'right-elbow': rotation(-1.3),
  }) });
  return { locomotion, breathing, equipment, attack: campaignTorso(attack), skill: campaignTorso(skill),
    revive: campaignTorso(revive, true), downed: campaignTorso(downed, true) };
}
