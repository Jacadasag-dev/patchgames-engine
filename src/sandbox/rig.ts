/**
 * Character rigs for player-authored game code: a skeleton of named joints,
 * named attach points ("sockets") on those joints, and poses that turn the
 * joints. Plain data only, identical in logic, prediction, tests and the view
 * (src/sandbox/rigView.ts builds the three.js nodes from the same math), so
 * whatever hangs from a socket follows every pose, knockdown and animation.
 *
 * Frame: +X right, +Y up, +Z forward, origin at the feet, in metres at scale 1.
 * Joint angles are degrees about the joint's own axes, in three.js Euler
 * order 'XYZ'. A pose only lists the joints it moves; the rest stay at rest.
 */
export const RIG_VERSION = 'rig-v1';

export interface RigVector { x: number; y: number; z: number }
/** Degrees about the joint's own X (pitch forward/back), Y (turn) and Z (roll) axes. */
export interface RigAngles { x?: number; y?: number; z?: number }
export interface RigJoint {
  name: string;
  /** Omitted for the root joint(s). Parents must be listed before their children. */
  parent?: string;
  /** Rest position, relative to the parent joint (or the rig origin). */
  position: RigVector;
}
export interface RigSocket {
  name: string;
  joint: string;
  /** Offset from the joint, in the joint's frame. */
  position?: RigVector;
  /** The socket's +Z (e.g. where a held item points). Defaults to the joint's +Z. */
  forward?: RigVector;
  /** The socket's +Y hint. Defaults to the joint's +Y; must not be parallel to forward. */
  up?: RigVector;
}
export interface RigDefinition { joints: RigJoint[]; sockets: RigSocket[] }
export interface JointPose {
  rotate?: RigAngles;
  /** Added to the joint's rest position (e.g. hips dropping when knocked down). */
  move?: RigVector;
}
/** Joint name -> how it's turned/moved in this pose. */
export type RigPose = Readonly<Record<string, JointPose>>;
/** Affine frame: local +X/+Y/+Z expressed in the parent frame (same shape as game attachments). */
export interface RigTransform { position: RigVector; xAxis: RigVector; yAxis: RigVector; zAxis: RigVector }
export interface RigPoint { position: RigVector; direction: RigVector }
export interface Rig {
  readonly version: string;
  readonly joints: readonly Readonly<Required<Pick<RigJoint, 'name' | 'position'>> & { parent: string | null }>[];
  readonly sockets: readonly Readonly<{ name: string; joint: string; transform: RigTransform }>[];
}
export interface RigFrame {
  /** Every joint's frame, in the root frame passed to solveRig. */
  joints: Readonly<Record<string, RigTransform>>;
  /** Every socket's frame, in the same root frame. */
  sockets: Readonly<Record<string, RigTransform>>;
}

type Joint = Rig['joints'][number];
type Socket = Rig['sockets'][number];
// Only defineRig's deeply frozen definitions are indexed. Structurally supplied
// rigs remain uncached so edits to their arrays cannot leave stale transforms.
const rigIndexes = new WeakMap<Rig, { joints: ReadonlyMap<string, Joint>; sockets: ReadonlyMap<string, Socket>; chains: ReadonlyMap<string, readonly Joint[]> }>();
type LocalPose = { x: number; y: number; z: number; dx: number; dy: number; dz: number; transform: RigTransform };
const localPoses = new WeakMap<Joint, LocalPose>();

/** The attach points every character rig in the game should offer. */
export const STANDARD_SOCKETS = ['head', 'back', 'hips', 'leftHand', 'rightHand'] as const;

const MAX_JOINTS = 48;
const MAX_SOCKETS = 48;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const DEG = Math.PI / 180;

export const IDENTITY: RigTransform = Object.freeze({
  position: Object.freeze({ x: 0, y: 0, z: 0 }),
  xAxis: Object.freeze({ x: 1, y: 0, z: 0 }),
  yAxis: Object.freeze({ x: 0, y: 1, z: 0 }),
  zAxis: Object.freeze({ x: 0, y: 0, z: 1 }),
});

function fail(message: string): never {
  throw new Error(`Rig: ${message}`);
}
function finite(v: unknown, what: string, limit = 1e4): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > limit) fail(`${what} must be a finite number within ±${limit}`);
  return v;
}
function vector(v: unknown, what: string, limit = 100): RigVector {
  if (!v || typeof v !== 'object') fail(`${what} must be {x, y, z}`);
  const { x, y, z } = v as RigVector;
  return { x: finite(x, `${what}.x`, limit), y: finite(y, `${what}.y`, limit), z: finite(z, `${what}.z`, limit) };
}
function name(v: unknown, what: string): string {
  if (typeof v !== 'string' || !NAME.test(v)) fail(`${what} "${String(v)}" must start with a letter and use only letters, digits and _ (max 32)`);
  return v;
}
function unit(v: RigVector, what: string): RigVector {
  const length = Math.hypot(v.x, v.y, v.z);
  if (length < 1e-9) fail(`${what} must not be zero`);
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}
function cross(a: RigVector, b: RigVector): RigVector {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function freezeTransform(t: RigTransform): RigTransform {
  return Object.freeze({
    position: Object.freeze({ ...t.position }), xAxis: Object.freeze({ ...t.xAxis }),
    yAxis: Object.freeze({ ...t.yAxis }), zAxis: Object.freeze({ ...t.zAxis }),
  });
}

/** Checks a skeleton and its sockets once, and returns an immutable rig. Errors say what to fix. */
export function defineRig(definition: RigDefinition): Rig {
  if (!definition || !Array.isArray(definition.joints) || !Array.isArray(definition.sockets)) fail('defineRig needs { joints: [...], sockets: [...] }');
  if (!definition.joints.length || definition.joints.length > MAX_JOINTS) fail(`a rig needs 1 to ${MAX_JOINTS} joints`);
  if (definition.sockets.length > MAX_SOCKETS) fail(`a rig can have at most ${MAX_SOCKETS} sockets`);
  const seen = new Set<string>();
  const joints = definition.joints.map((joint, i) => {
    const jointName = name(joint?.name, `joints[${i}].name`);
    if (seen.has(jointName)) fail(`joint "${jointName}" is listed twice`);
    const parent = joint.parent === undefined ? null : name(joint.parent, `joint "${jointName}".parent`);
    if (parent !== null && !seen.has(parent)) fail(`joint "${jointName}" has parent "${parent}", which must be listed before it`);
    seen.add(jointName);
    return Object.freeze({ name: jointName, parent, position: Object.freeze(vector(joint.position, `joint "${jointName}".position`)) });
  });
  const socketNames = new Set<string>();
  const sockets = definition.sockets.map((socket, i) => {
    const socketName = name(socket?.name, `sockets[${i}].name`);
    // A socket may share its joint's name (the "head" socket on the "head" joint); names are unique among sockets.
    if (socketNames.has(socketName)) fail(`socket "${socketName}" is listed twice`);
    socketNames.add(socketName);
    const joint = name(socket.joint, `socket "${socketName}".joint`);
    if (!seen.has(joint)) fail(`socket "${socketName}" is on joint "${joint}", which the rig doesn't have`);
    const position = socket.position ? vector(socket.position, `socket "${socketName}".position`) : { x: 0, y: 0, z: 0 };
    const zAxis = unit(socket.forward ? vector(socket.forward, `socket "${socketName}".forward`) : { x: 0, y: 0, z: 1 }, `socket "${socketName}".forward`);
    const upHint = socket.up ? vector(socket.up, `socket "${socketName}".up`) : { x: 0, y: 1, z: 0 };
    const side = cross(upHint, zAxis);
    if (Math.hypot(side.x, side.y, side.z) < 1e-6) fail(`socket "${socketName}".up must not point along its forward`);
    const xAxis = unit(side, `socket "${socketName}" side`);
    return Object.freeze({ name: socketName, joint, transform: freezeTransform({ position, xAxis, yAxis: cross(zAxis, xAxis), zAxis }) });
  });
  const rig = Object.freeze({ version: RIG_VERSION, joints: Object.freeze(joints), sockets: Object.freeze(sockets) });
  const indexedJoints = new Map(joints.map(joint => [joint.name, joint]));
  const chains = new Map(sockets.map(socket => {
    const chain: Joint[] = [];
    for (let joint: Joint | undefined = indexedJoints.get(socket.joint); joint; joint = joint.parent === null ? undefined : indexedJoints.get(joint.parent)) chain.push(joint);
    return [socket.name, chain.reverse()] as const;
  }));
  rigIndexes.set(rig, { joints: indexedJoints, sockets: new Map(sockets.map(socket => [socket.name, socket])), chains });
  return rig;
}

/** Checks a pose against a rig: every joint it names exists and every number is finite. */
export function validatePose(rig: Rig, pose: RigPose): void {
  if (!pose || typeof pose !== 'object') fail('a pose must be an object of { jointName: { rotate?, move? } }');
  const indexedJoints = rigIndexes.get(rig)?.joints;
  for (const [jointName, joint] of Object.entries(pose)) {
    if (!(indexedJoints?.has(jointName) ?? rig.joints.some((j) => j.name === jointName))) fail(`the pose moves joint "${jointName}", which the rig doesn't have`);
    if (!joint || typeof joint !== 'object') fail(`pose joint "${jointName}" must be { rotate?, move? }`);
    if (joint.rotate) for (const axis of ['x', 'y', 'z'] as const) {
      const value = joint.rotate[axis];
      // Successful hot-path validation needs no diagnostic string allocation.
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 720)) {
        finite(value, `pose "${jointName}".rotate.${axis}`, 720);
      }
    }
    if (joint.move) vector(joint.move, `pose "${jointName}".move`, 10);
  }
}

/** Rotation columns for degrees in three.js Euler order 'XYZ' (same formula as Matrix4.makeRotationFromEuler). */
function rotation(angles: RigAngles | undefined): Pick<RigTransform, 'xAxis' | 'yAxis' | 'zAxis'> {
  const x = (angles?.x ?? 0) * DEG, y = (angles?.y ?? 0) * DEG, z = (angles?.z ?? 0) * DEG;
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  return {
    xAxis: { x: c * e, y: af + be * d, z: bf - ae * d },
    yAxis: { x: -c * f, y: ae - bf * d, z: be + af * d },
    zAxis: { x: d, y: -b * c, z: a * c },
  };
}

/** A joint's frame relative to its parent, for a pose (the view sets its nodes from this). */
export function jointLocalTransform(rig: Rig, jointName: string, pose: RigPose = {}): RigTransform {
  const joint = rigIndexes.get(rig)?.joints.get(jointName) ?? rig.joints.find((j) => j.name === jointName) ?? fail(`unknown joint "${jointName}"`);
  return localTransform(joint, pose);
}

function localTransform(joint: Joint, pose: RigPose): RigTransform {
  const posed = pose[joint.name];
  const move = posed?.move;
  return {
    position: { x: joint.position.x + (move?.x ?? 0), y: joint.position.y + (move?.y ?? 0), z: joint.position.z + (move?.z ?? 0) },
    ...rotation(posed?.rotate),
  };
}

/** Cache only the immutable joint's last numeric pose; mutated pose objects
 * must be observed, and callers never receive this internal transform.
 */
function posedTransform(joint: Joint, pose: RigPose, immutable: boolean): RigTransform {
  if (!immutable) return localTransform(joint, pose);
  const p = pose[joint.name], x = p?.rotate?.x ?? 0, y = p?.rotate?.y ?? 0, z = p?.rotate?.z ?? 0;
  const dx = p?.move?.x ?? 0, dy = p?.move?.y ?? 0, dz = p?.move?.z ?? 0;
  const last = localPoses.get(joint);
  if (last && Object.is(last.x, x) && Object.is(last.y, y) && Object.is(last.z, z)
    && Object.is(last.dx, dx) && Object.is(last.dy, dy) && Object.is(last.dz, dz)) return last.transform;
  const transform = localTransform(joint, pose);
  localPoses.set(joint, { x, y, z, dx, dy, dz, transform });
  return transform;
}

/** A socket's fixed frame on its joint. */
export function socketLocalTransform(rig: Rig, socketName: string): RigTransform {
  return (rigIndexes.get(rig)?.sockets.get(socketName) ?? rig.sockets.find((s) => s.name === socketName) ?? fail(`unknown socket "${socketName}"`)).transform;
}

function apply(t: RigTransform, v: RigVector): RigVector {
  return {
    x: t.xAxis.x * v.x + t.yAxis.x * v.y + t.zAxis.x * v.z,
    y: t.xAxis.y * v.x + t.yAxis.y * v.y + t.zAxis.y * v.z,
    z: t.xAxis.z * v.x + t.yAxis.z * v.y + t.zAxis.z * v.z,
  };
}
/** parent ∘ child: the child's frame expressed in the parent's parent frame. */
export function composeRigTransforms(parent: RigTransform, child: RigTransform): RigTransform {
  const offset = apply(parent, child.position);
  return {
    position: { x: parent.position.x + offset.x, y: parent.position.y + offset.y, z: parent.position.z + offset.z },
    xAxis: apply(parent, child.xAxis), yAxis: apply(parent, child.yAxis), zAxis: apply(parent, child.zAxis),
  };
}

/** Compose into a private scratch frame without allocating four new vectors
 * at every joint. Keep the exact multiply/add order of composeRigTransforms;
 * no regrouping of the ancestry's matrices or cached world-space results.
 */
function composeInto(frame: RigTransform, child: RigTransform): void {
  const xx = frame.xAxis.x, xy = frame.xAxis.y, xz = frame.xAxis.z;
  const yx = frame.yAxis.x, yy = frame.yAxis.y, yz = frame.yAxis.z;
  const zx = frame.zAxis.x, zy = frame.zAxis.y, zz = frame.zAxis.z;
  const p = child.position, x = child.xAxis, y = child.yAxis, z = child.zAxis;
  frame.position.x = frame.position.x + (xx * p.x + yx * p.y + zx * p.z);
  frame.position.y = frame.position.y + (xy * p.x + yy * p.y + zy * p.z);
  frame.position.z = frame.position.z + (xz * p.x + yz * p.y + zz * p.z);
  frame.xAxis.x = xx * x.x + yx * x.y + zx * x.z;
  frame.xAxis.y = xy * x.x + yy * x.y + zy * x.z;
  frame.xAxis.z = xz * x.x + yz * x.y + zz * x.z;
  frame.yAxis.x = xx * y.x + yx * y.y + zx * y.z;
  frame.yAxis.y = xy * y.x + yy * y.y + zy * y.z;
  frame.yAxis.z = xz * y.x + yz * y.y + zz * y.z;
  frame.zAxis.x = xx * z.x + yx * z.y + zx * z.z;
  frame.zAxis.y = xy * z.x + yy * z.y + zy * z.z;
  frame.zAxis.z = xz * z.x + yz * z.y + zz * z.z;
}

/**
 * Every joint and socket for a pose, in `root`'s frame (default: the rig's own
 * frame). Pass the character's placement (feet, facing, slope, scale) as root
 * to get world positions, e.g. where a held item's muzzle is for gameplay.
 */
export function solveRig(rig: Rig, pose: RigPose = {}, root: RigTransform = IDENTITY): RigFrame {
  validatePose(rig, pose);
  const immutable = rigIndexes.has(rig);
  const joints: Record<string, RigTransform> = {};
  for (const joint of rig.joints) {
    joints[joint.name] = composeRigTransforms(joint.parent === null ? root : joints[joint.parent], posedTransform(joint, pose, immutable));
  }
  const sockets: Record<string, RigTransform> = {};
  for (const socket of rig.sockets) sockets[socket.name] = composeRigTransforms(joints[socket.joint], socket.transform);
  return { joints, sockets };
}

/** A single socket, using the identical parent-to-child math as solveRig.
 * Gameplay attachment queries need only this joint's ancestry, not every limb
 * and socket of every participant. The entire pose is still validated.
 */
export function solveRigSocket(rig: Rig, socketName: string, pose: RigPose = {}, root: RigTransform = IDENTITY): RigTransform {
  validatePose(rig, pose);
  const index = rigIndexes.get(rig);
  const socket = index?.sockets.get(socketName) ?? rig.sockets.find(s => s.name === socketName) ?? fail(`unknown socket "${socketName}"`);
  let chain = index?.chains.get(socketName);
  if (!chain) {
    const ancestors: Joint[] = [];
    let jointName: string | null = socket.joint;
    while (jointName !== null) {
      const joint: Joint = rig.joints.find(j => j.name === jointName) ?? fail(`unknown joint "${jointName}"`);
      ancestors.push(joint);
      if (ancestors.length > MAX_JOINTS) fail('joint ancestry exceeds the rig limit');
      jointName = joint.parent;
    }
    chain = ancestors.reverse();
  }
  const frame = { position: { ...root.position }, xAxis: { ...root.xAxis }, yAxis: { ...root.yAxis }, zAxis: { ...root.zAxis } };
  for (const joint of chain) composeInto(frame, posedTransform(joint, pose, !!index));
  composeInto(frame, socket.transform);
  return frame;
}

/** A socket's position and forward (+Z) direction, optionally at an offset in the socket's own frame. */
export function rigPoint(frame: RigFrame, socketName: string, offset: RigVector = { x: 0, y: 0, z: 0 }): RigPoint {
  const t = frame.sockets[socketName] ?? fail(`unknown socket "${socketName}"`);
  const d = apply(t, offset);
  return {
    position: { x: t.position.x + d.x, y: t.position.y + d.y, z: t.position.z + d.z },
    direction: unit(t.zAxis, `socket "${socketName}" forward`),
  };
}

function blendAngles(a: RigAngles | undefined, b: RigAngles | undefined, t: number): RigAngles | undefined {
  if (!a && !b) return undefined;
  const mix = (p = 0, q = 0) => p + (q - p) * t;
  return { x: mix(a?.x, b?.x), y: mix(a?.y, b?.y), z: mix(a?.z, b?.z) };
}
function blendMove(a: RigVector | undefined, b: RigVector | undefined, t: number): RigVector | undefined {
  if (!a && !b) return undefined;
  const mix = (p = 0, q = 0) => p + (q - p) * t;
  return { x: mix(a?.x, b?.x), y: mix(a?.y, b?.y), z: mix(a?.z, b?.z) };
}

/** From `from` (amount 0) to `to` (amount 1); joints missing from one side count as at rest. */
export function mixPoses(from: RigPose, to: RigPose, amount: number): RigPose {
  const t = Math.min(1, Math.max(0, finite(amount, 'mix amount')));
  const out: Record<string, JointPose> = {};
  for (const joint of new Set([...Object.keys(from), ...Object.keys(to)])) {
    const rotate = blendAngles(from[joint]?.rotate, to[joint]?.rotate, t);
    const move = blendMove(from[joint]?.move, to[joint]?.move, t);
    out[joint] = { ...(rotate ? { rotate } : {}), ...(move ? { move } : {}) };
  }
  return out;
}

/** Stacks poses: angles and moves add up (e.g. a lean on top of a run). */
export function addPoses(...poses: RigPose[]): RigPose {
  const out: Record<string, JointPose> = {};
  for (const pose of poses) {
    for (const [joint, p] of Object.entries(pose)) {
      const prev = out[joint] ?? {};
      const rotate = p.rotate || prev.rotate ? { x: (prev.rotate?.x ?? 0) + (p.rotate?.x ?? 0), y: (prev.rotate?.y ?? 0) + (p.rotate?.y ?? 0), z: (prev.rotate?.z ?? 0) + (p.rotate?.z ?? 0) } : undefined;
      const move = p.move || prev.move ? { x: (prev.move?.x ?? 0) + (p.move?.x ?? 0), y: (prev.move?.y ?? 0) + (p.move?.y ?? 0), z: (prev.move?.z ?? 0) + (p.move?.z ?? 0) } : undefined;
      const combined: JointPose = {};
      if (rotate) combined.rotate = rotate;
      if (move) combined.move = move;
      out[joint] = combined;
    }
  }
  return out;
}

/** A named pose: fixed, or computed from the milliseconds since it started (for motions like a lunge). */
export interface PoseClip {
  pose: RigPose | ((elapsedMs: number) => RigPose);
  /** How long to blend into this pose from the previous one (default 120 ms). */
  blendMs?: number;
}

/**
 * Plays named poses with smooth blends, driven by explicit time (never the
 * wall clock), so the same calls always give the same poses. Typical use in a
 * view: `animator.play(fighterPoseName(state), now); rigView.apply(animator.pose(now));`
 */
export class RigAnimator {
  private readonly rig: Rig;
  private readonly clips: Readonly<Record<string, PoseClip>>;
  private name: string;
  private startedAt = 0;
  private from: RigPose = {};
  private blendMs = 0;

  constructor(rig: Rig, clips: Record<string, PoseClip>, initial: string) {
    this.rig = rig;
    for (const [clipName, clip] of Object.entries(clips)) {
      name(clipName, 'pose name');
      if (!clip || (typeof clip.pose !== 'function' && typeof clip.pose !== 'object')) fail(`pose "${clipName}" needs { pose }`);
      if (typeof clip.pose === 'object') validatePose(rig, clip.pose);
      if (clip.blendMs !== undefined) finite(clip.blendMs, `pose "${clipName}".blendMs`, 10_000);
    }
    this.clips = Object.freeze({ ...clips });
    if (!this.clips[initial]) fail(`unknown starting pose "${initial}"`);
    this.name = initial;
  }

  /** The pose playing now. */
  get current(): string { return this.name; }

  /** Switches to a pose (no-op if it's already playing), blending from wherever the rig is now. */
  play(poseName: string, nowMs: number): void {
    if (poseName !== this.name) this.restart(poseName, nowMs);
  }

  /** Starts a pose from its beginning even if it's playing (e.g. a second attack). */
  restart(poseName: string, nowMs: number): void {
    const clip = this.clips[poseName] ?? fail(`unknown pose "${poseName}"`);
    this.from = this.pose(nowMs);
    this.name = poseName;
    this.startedAt = finite(nowMs, 'time', 1e15);
    this.blendMs = clip.blendMs ?? 120;
  }

  /** The rig's pose at `nowMs`. Time going backwards (a replay seek) jumps straight to the current pose. */
  pose(nowMs: number): RigPose {
    const now = finite(nowMs, 'time', 1e15);
    if (now < this.startedAt) { this.startedAt = now; this.blendMs = 0; }
    const clip = this.clips[this.name];
    const elapsed = now - this.startedAt;
    const target = typeof clip.pose === 'function' ? clip.pose(elapsed) : clip.pose;
    if (typeof clip.pose === 'function') validatePose(this.rig, target);
    return this.blendMs > 0 && elapsed < this.blendMs ? mixPoses(this.from, target, elapsed / this.blendMs) : target;
  }
}
