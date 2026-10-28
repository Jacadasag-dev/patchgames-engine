/** Renderer-neutral carry inertia. Equipment slows selected local rotations;
 * gameplay movement, authored attack/contact layers and the rest of the body
 * remain independent. These are presentation profiles, not physical masses. */
import { AnimationPoseBuffer, slerpAnimationQuaternions, validateAnimationPose,
  type AnimationPose, type AnimationQuaternion, type AnimationJointTransform } from './animation.ts';

export type EquipmentWeight = 'medium' | 'heavy' | 'xheavy';
export interface EquipmentMotionLoad {
  id: string;
  weight: EquipmentWeight;
  /** Reference-pose joint names. A rig adapter supplies the holding arm chain. */
  joints: readonly string[];
  /** 0 disables this item's influence; 1 uses its full carry profile. */
  influence?: number;
}
export interface EquipmentMotionDiagnostics {
  /** Bounded observations, never a judgment about intended movement. */
  loads: { id: string; weight: EquipmentWeight; influence: number; joints: string[] }[];
  loadCount: number;
  joints: { joint: string; responseMs: number; lagRadians: number }[];
  jointCount: number;
}
export interface EquipmentMotionFrame {
  loads: readonly EquipmentMotionLoad[];
  deltaMs: number;
  reset?: boolean;
}
export interface EquipmentMotionResult {
  pose: AnimationPose;
  diagnostics: EquipmentMotionDiagnostics;
  /** Allows callers to skip redundant reference-pose composition at rest. */
  modified: boolean;
}
type EquipmentCompositionResult = EquipmentMotionResult | {
  pose?: never;
  diagnostics: EquipmentMotionDiagnostics;
  modified: false;
};

const RESPONSE_MS: Readonly<Record<EquipmentWeight, number>> = Object.freeze({ medium: 65, heavy: 135, xheavy: 240 });
const TRANSITION_MS = 100;
const MAX_LOADS = 16, MAX_LOAD_JOINTS = 32, MAX_JOINTS = 64;
interface JointState { rotation: AnimationQuaternion; responseMs: number }
function fail(message: string): never { throw new Error(`Equipment motion: ${message}`); }
function name(value: string, label: string, max = 96): void {
  if (typeof value !== 'string' || !value.trim().length || value.length > max) fail(`${label} must be 1..${max} characters`);
}
function validatedLoads(loads: readonly EquipmentMotionLoad[]): EquipmentMotionDiagnostics['loads'] {
  if (!Array.isArray(loads) || loads.length > MAX_LOADS) fail(`at most ${MAX_LOADS} loads`);
  const ids = new Set<string>(), joints = new Set<string>();
  return loads.map(load => {
    if (!load || typeof load !== 'object') fail('each load needs an id, weight and joints');
    name(load.id, 'load id', 128);
    if (ids.has(load.id)) fail(`duplicate load id: ${load.id}`);
    ids.add(load.id);
    if (typeof load.weight !== 'string' || !Object.prototype.hasOwnProperty.call(RESPONSE_MS, load.weight))
      fail('weight must be medium, heavy or xheavy');
    if (!Array.isArray(load.joints) || load.joints.length > MAX_LOAD_JOINTS) fail(`at most ${MAX_LOAD_JOINTS} joints per load`);
    const unique = new Set<string>();
    for (const joint of load.joints) { name(joint, 'joint'); unique.add(joint); joints.add(joint); }
    if (joints.size > MAX_JOINTS) fail(`at most ${MAX_JOINTS} loaded joints`);
    const influence = load.influence ?? 1;
    if (!Number.isFinite(influence) || influence < 0 || influence > 1) fail('influence must be within 0..1');
    return { id: load.id, weight: load.weight, joints: [...unique], influence };
  });
}
function angle(a: AnimationQuaternion, b: AnimationQuaternion): number {
  return 2 * Math.acos(Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)));
}

/** One instance per actor. A monotone exponential response attenuates fast
 * swings without shrinking static poses toward rest, spring overshoot, or
 * modifying translation/scale. Empty loads smoothly remove existing inertia.
 * Reset after actor replacement, clock seeks or discontinuities. */
export class EquipmentMotionController {
  private states = new Map<string, JointState>();
  private readonly validationBuffer = new AnimationPoseBuffer();

  reset(): void { this.states.clear(); }

  /** @internal The actor only needs a replacement when carry inertia changes
   * its base pose. Validate empty-load frames with reusable private storage;
   * never expose that storage across authored layer callbacks or reentrancy. */
  sampleForComposition(pose: AnimationPose, frame: EquipmentMotionFrame): EquipmentCompositionResult {
    if (!Array.isArray(frame.loads) || frame.loads.length !== 0 || this.states.size !== 0 && !frame.reset)
      return this.sample(pose, frame);
    if (!Number.isFinite(frame.deltaMs) || frame.deltaMs < 0 || frame.deltaMs > 60_000)
      fail('deltaMs must be within 0..60000');
    this.validationBuffer.read(pose);
    if (frame.reset) this.reset();
    return { modified: false, diagnostics: { loads: [], loadCount: 0, joints: [], jointCount: 0 } };
  }

  sample(pose: AnimationPose, frame: EquipmentMotionFrame): EquipmentMotionResult {
    if (!Number.isFinite(frame.deltaMs) || frame.deltaMs < 0 || frame.deltaMs > 60_000)
      fail('deltaMs must be within 0..60000');
    // Validate before mutating continuity, including reset requests.
    const loads = validatedLoads(frame.loads);
    const output = validateAnimationPose(pose) as Record<string, AnimationJointTransform>;
    if (frame.reset) this.reset();
    const targets = new Map<string, number>();
    for (const load of loads) for (const joint of load.joints)
      targets.set(joint, Math.max(targets.get(joint) ?? 0, RESPONSE_MS[load.weight] * load.influence));
    const deltaMs = frame.reset ? 0 : frame.deltaMs;
    const transition = -Math.expm1(-deltaMs / TRANSITION_MS);
    const diagnostics: EquipmentMotionDiagnostics = { loads: loads.slice(0, 8).map(load => ({ ...load, joints: load.joints.slice(0, 8) })),
      loadCount: loads.length, joints: [], jointCount: 0 };
    let modified = false;
    // A sparse pose that stops supplying a channel has returned ownership to
    // the rig; never invent missing joints or keep a removed body part alive.
    for (const joint of this.states.keys()) if (!output[joint]?.rotation) this.states.delete(joint);
    for (const [joint, transform] of Object.entries(output)) {
      const target = transform.rotation;
      if (!target) continue;
      const targetResponse = targets.get(joint) ?? 0;
      let state = this.states.get(joint);
      if (!state && targetResponse === 0) continue;
      if (!state) {
        state = { rotation: { ...target }, responseMs: frame.reset ? targetResponse : 0 };
        this.states.set(joint, state);
      }
      const oldResponse = state.responseMs;
      state.responseMs += (targetResponse - state.responseMs) * transition;
      // Averaging the smoothly changing response avoids an equip/unequip jump.
      // The exponential response is bounded for arbitrarily late valid frames.
      const response = (oldResponse + state.responseMs) / 2;
      if (deltaMs > 0) state.rotation = slerpAnimationQuaternions(state.rotation, target,
        response > .001 ? -Math.expm1(-deltaMs / response) : 1);
      transform.rotation = { ...state.rotation };
      const lagRadians = angle(state.rotation, target);
      if (targetResponse === 0 && state.responseMs < .1 && lagRadians < 1e-5) {
        this.states.delete(joint); transform.rotation = { ...target }; continue;
      }
      if (lagRadians > 1e-7) modified = true;
      diagnostics.jointCount++;
      if (diagnostics.joints.length < 8) diagnostics.joints.push({ joint, responseMs: state.responseMs, lagRadians });
    }
    return { pose: output, diagnostics, modified };
  }
}
