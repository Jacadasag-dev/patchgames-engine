import type { MotionDatabase } from '../sandbox/motionMatching.ts';
import { sharedHumanoidLocomotion, HUMANOID_LOCOMOTION_RIG } from '../sandbox/animationLibrary.ts';
import { HUMANOID_TRAJECTORY_TIMES, sharedHumanoidMotionDatabase } from '../sandbox/actorLocomotion.ts';

/** Shared mocap remains independent of game mode and class equipment. Every
 * adventurer searches the same body-motion index, then layers its own actions. */
export const ADVENTURER_TRAJECTORY_TIMES = HUMANOID_TRAJECTORY_TIMES;
export const ADVENTURER_MOTION_RIG = HUMANOID_LOCOMOTION_RIG;

export function adventurerMotion(id: string) {
  return sharedHumanoidLocomotion().find(source => source.id === id);
}
export function adventurerMotionPhase(id: string, timeMs: number): number {
  const source = adventurerMotion(id);
  if (!source) return 0;
  const phase = timeMs / source.clip.durationMs;
  return source.clip.loop ? ((phase % 1) + 1) % 1 : Math.max(0, Math.min(1, phase));
}
export function adventurerMotionSpeed(id: string, timeMs: number): number {
  return adventurerMotion(id)?.speed(timeMs) ?? 0;
}
export function adventurerMotionDatabase(_role = 0): MotionDatabase {
  return sharedHumanoidMotionDatabase();
}
