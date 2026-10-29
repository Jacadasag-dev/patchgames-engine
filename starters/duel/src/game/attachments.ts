/** Plain-data attachment transforms shared by simulation, prediction and rendering. */
import type { Vec3 } from './terrain.ts';

/** Affine columns: local +X/+Y/+Z expressed in the parent frame. Columns include scale.
 * Do not normalize them: nested nonuniform scales can produce shear. */
export interface AttachmentTransform {
  position: Vec3;
  xAxis: Vec3;
  yAxis: Vec3;
  zAxis: Vec3;
}
export interface AttachmentPoint { position: Vec3; direction: Vec3 }
export type AttachmentPoints = Readonly<Record<string, AttachmentPoint>>;
export interface AttachmentPose {
  position?: Vec3;
  /** Quaternion, not Euler angles. Defaults to identity. */
  rotation?: { x: number; y: number; z: number; w: number };
  scale?: Vec3;
}

function unit(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z);
  if (!Number.isFinite(length) || length < 1e-12) throw new Error('Attachment direction must be finite and nonzero');
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** Build a local translation/rotation/scale pose; no engine objects or mutable cache. */
export function attachmentTransform(pose: AttachmentPose = {}): AttachmentTransform {
  const p = pose.position ?? { x: 0, y: 0, z: 0 };
  const s = pose.scale ?? { x: 1, y: 1, z: 1 };
  const q = pose.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  if (!Object.values(p).every(Number.isFinite) || !Object.values(s).every(Number.isFinite)
    || !Number.isFinite(length) || length < 1e-12) throw new Error('Invalid attachment pose');
  const x = q.x / length, y = q.y / length, z = q.z / length, w = q.w / length;
  return {
    position: { ...p },
    xAxis: { x: (1 - 2 * (y * y + z * z)) * s.x, y: 2 * (x * y + z * w) * s.x, z: 2 * (x * z - y * w) * s.x },
    yAxis: { x: 2 * (x * y - z * w) * s.y, y: (1 - 2 * (x * x + z * z)) * s.y, z: 2 * (y * z + x * w) * s.y },
    zAxis: { x: 2 * (x * z + y * w) * s.z, y: 2 * (y * z - x * w) * s.z, z: (1 - 2 * (x * x + y * y)) * s.z },
  };
}

/** Camera local +X is screen-right, +Y up, and -Z looks at the target (Three.js convention).
 * This describes a supplied pose, not camera behavior. For authority supply recorded state,
 * never a smoothed/predicted client camera. Coincident target/parallel up are invalid. */
export function cameraAttachmentTransform(pose: { position: Vec3; target: Vec3; up: Vec3 }): AttachmentTransform {
  const zAxis = unit({ x: pose.position.x - pose.target.x, y: pose.position.y - pose.target.y, z: pose.position.z - pose.target.z });
  const xAxis = unit(cross(pose.up, zAxis));
  return { position: { ...pose.position }, xAxis, yAxis: cross(zAxis, xAxis), zAxis };
}

/** Displacement/axis transformation: translation deliberately does not apply. */
export function transformAttachmentVector(t: AttachmentTransform, v: Vec3): Vec3 {
  return {
    x: t.xAxis.x * v.x + t.yAxis.x * v.y + t.zAxis.x * v.z,
    y: t.xAxis.y * v.x + t.yAxis.y * v.y + t.zAxis.y * v.z,
    z: t.xAxis.z * v.x + t.yAxis.z * v.y + t.zAxis.z * v.z,
  };
}
export function transformAttachmentPosition(t: AttachmentTransform, local: Vec3): Vec3 {
  const v = transformAttachmentVector(t, local);
  return { x: t.position.x + v.x, y: t.position.y + v.y, z: t.position.z + v.z };
}

/** Parent first, then child, then grandchild. Preserves nonuniform scale and shear. */
export function composeAttachmentTransforms(...chain: AttachmentTransform[]): AttachmentTransform {
  return chain.reduce((parent, child) => ({
    position: transformAttachmentPosition(parent, child.position),
    xAxis: transformAttachmentVector(parent, child.xAxis),
    yAxis: transformAttachmentVector(parent, child.yAxis),
    zAxis: transformAttachmentVector(parent, child.zAxis),
  }), attachmentTransform());
}

/** Named points belong to the game's model definition. No built-in mouth/weapon behavior.
 * Direction is a local ray axis, not a surface normal; normalize only AFTER composition. */
export function resolveAttachment<K extends string>(transform: AttachmentTransform, points: Readonly<Record<K, AttachmentPoint>>, name: K): AttachmentPoint {
  if (!Object.hasOwn(points, name)) throw new Error(`Unknown attachment: ${name}`);
  const point = points[name];
  return { position: transformAttachmentPosition(transform, point.position), direction: unit(transformAttachmentVector(transform, point.direction)) };
}
