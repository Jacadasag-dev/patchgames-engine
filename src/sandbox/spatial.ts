/** Pure metre/Y-up spatial helpers shared by placement domains. Asset +Z is
 * forward. Callers validate their own bounded recipes before using these operations. */
import type { PhysicsCollider, PhysicsVector } from './physics.ts';
import { physicsShapeBounds } from './physicsGeometry.ts';

export interface Point { x: number; z: number }
export type Direction = 'north' | 'south' | 'east' | 'west';

/** Normalize generated geometry, not only its hash, across JS engines. */
const snap = (value: number, scale: number): number => { const result = Math.round(value * scale) / scale; return result === 0 ? 0 : result; };
export const spatialCoordinate = (value: number): number => snap(value, 1e7);
export const spatialAngle = (value: number): number => snap(value, 1e9);
/** Raw cardinal angles preserve authored/legacy transforms where required. */
export const directionYaw = (side: Direction): number => side === 'north' ? Math.PI : side === 'east' ? Math.PI / 2 : side === 'west' ? -Math.PI / 2 : 0;

/** Undefined means there is no direction, including a coincident point target. */
export function facingYaw(target: Point | Direction | undefined, x: number, z: number): number | undefined {
  if (typeof target === 'string') return spatialAngle(directionYaw(target));
  if (!target) return;
  const dx = target.x - x, dz = target.z - z;
  return dx * dx + dz * dz < 1e-14 ? undefined : spatialAngle(Math.atan2(dx, dz));
}

export function transformSpatialPoint(point: Point, origin: Point, yaw: number): Point {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { x: spatialCoordinate(origin.x + c * point.x + s * point.z), z: spatialCoordinate(origin.z - s * point.x + c * point.z) };
}

/** One at the target, zero at/beyond range. Range must be positive and finite. */
export function nearScore(point: Point, target: Point, range: number): number {
  if (!Number.isFinite(range) || range <= 0) throw new Error('Spatial proximity range must be positive and finite.');
  return 1 - Math.min(1, spatialCoordinate(Math.hypot(point.x - target.x, point.z - target.z)) / range);
}

export interface SpatialRouteSample {
  distance: number; point: Point; tangent: Point; index: number; t: number;
}

/** Nearest nonzero route segment. Equal distances keep the first segment;
 * duplicate vertices are ignored. Callers bound and validate the route array. */
export function nearestSpatialRoute(point: Point, points: readonly Point[]): SpatialRouteSample | undefined {
  let nearest: SpatialRouteSample | undefined;
  for (let index = 0; index + 1 < points.length; index++) {
    const a = points[index], b = points[index + 1], dx = b.x - a.x, dz = b.z - a.z, lengthSquared = dx * dx + dz * dz;
    if (lengthSquared < 1e-14) continue;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared));
    const at = { x: spatialCoordinate(a.x + t * dx), z: spatialCoordinate(a.z + t * dz) };
    const distance = spatialCoordinate(Math.hypot(point.x - at.x, point.z - at.z));
    if (nearest && distance >= nearest.distance) continue;
    const length = Math.sqrt(lengthSquared);
    nearest = { distance, point: at, tangent: { x: spatialCoordinate(dx / length), z: spatialCoordinate(dz / length) }, index, t: spatialCoordinate(t) };
  }
  return nearest;
}

/** Conservative walking corridor against upright boxes/balls from asset
 * manifests. This retains the world planner's existing yaw-only primitive
 * approximation; it is not a general pitched-collider or capsule sweep.
 * Elevated pieces are excluded by their vertical extent, not asset bounds. */
export function colliderBlocksCorridor(collider: PhysicsCollider, a: PhysicsVector, b: PhysicsVector, halfWidth: number, headroom: number): boolean {
  if (collider.shape.kind === 'convex') {
    const bounds = physicsShapeBounds(collider.shape, collider.rotation), min = bounds.min, max = bounds.max;
    const box: PhysicsCollider = { position: { x: collider.position.x + (min.x + max.x) / 2, y: collider.position.y + (min.y + max.y) / 2, z: collider.position.z + (min.z + max.z) / 2 },
      shape: { kind: 'box', halfExtents: { x: (max.x - min.x) / 2, y: (max.y - min.y) / 2, z: (max.z - min.z) / 2 } } };
    return colliderBlocksCorridor(box, a, b, halfWidth, headroom);
  }
  const shape = collider.shape, half = shape.kind === 'box' ? shape.halfExtents : { x: shape.radius, y: shape.radius, z: shape.radius };
  const q = collider.rotation, c = q ? 1 - 2 * q.y ** 2 : 1, s = q ? 2 * q.y * q.w : 0;
  const local = (p: PhysicsVector) => { const x = p.x - collider.position.x, z = p.z - collider.position.z; return [c * x - s * z, p.y - collider.position.y, s * x + c * z]; };
  const from = local(a), to = local(b), minimum = [-half.x - halfWidth, -half.y - headroom, -half.z - halfWidth], maximum = [half.x + halfWidth, half.y - .02, half.z + halfWidth];
  let low = 0, high = 1;
  for (let axis = 0; axis < 3; axis++) {
    const delta = to[axis] - from[axis];
    if (Math.abs(delta) < 1e-12) { if (from[axis] <= minimum[axis] || from[axis] >= maximum[axis]) return false; continue; }
    const t1 = (minimum[axis] - from[axis]) / delta, t2 = (maximum[axis] - from[axis]) / delta;
    low = Math.max(low, Math.min(t1, t2)); high = Math.min(high, Math.max(t1, t2)); if (low >= high) return false;
  }
  return low < high;
}

/** Upright primitive against an axis-aligned walking rectangle. Boxes use SAT
 * rather than a circular expansion, so a clear arch's posts may remain beside
 * a street. Ball/capsule footprints use their conservative horizontal circle;
 * all shapes retain the real upright vertical extent. Pitched boxes unsupported. */
export function colliderBlocksRectangle(collider: PhysicsCollider, rectangle: Point & { width: number; depth: number }, groundY: number, headroom: number): boolean {
  if (collider.shape.kind === 'convex') {
    const { min, max } = physicsShapeBounds(collider.shape, collider.rotation), p = collider.position;
    return p.y + max.y > groundY + .02 && p.y + min.y < groundY + headroom
      && p.x + max.x > rectangle.x - rectangle.width / 2 && p.x + min.x < rectangle.x + rectangle.width / 2
      && p.z + max.z > rectangle.z - rectangle.depth / 2 && p.z + min.z < rectangle.z + rectangle.depth / 2;
  }
  const shape = collider.shape, halfY = shape.kind === 'box' ? shape.halfExtents.y : shape.radius + (shape.kind === 'capsule' ? shape.halfHeight : 0);
  if (collider.position.y + halfY <= groundY + .02 || collider.position.y - halfY >= groundY + headroom) return false;
  const dx = collider.position.x - rectangle.x, dz = collider.position.z - rectangle.z, rx = rectangle.width / 2, rz = rectangle.depth / 2;
  if (shape.kind !== 'box') {
    const x = Math.max(0, Math.abs(dx) - rx), z = Math.max(0, Math.abs(dz) - rz);
    return x * x + z * z < shape.radius * shape.radius;
  }
  const q = collider.rotation, c = q ? 1 - 2 * q.y ** 2 : 1, s = q ? 2 * q.y * q.w : 0, x = shape.halfExtents.x, z = shape.halfExtents.z;
  return Math.abs(dx) < rx + Math.abs(c) * x + Math.abs(s) * z
    && Math.abs(dz) < rz + Math.abs(s) * x + Math.abs(c) * z
    && Math.abs(c * dx - s * dz) < x + Math.abs(c) * rx + Math.abs(s) * rz
    && Math.abs(s * dx + c * dz) < z + Math.abs(s) * rx + Math.abs(c) * rz;
}
