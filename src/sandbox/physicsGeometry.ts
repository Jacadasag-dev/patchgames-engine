/** Bounded pure geometry shared by procedural authoring and collision queries. */
import type { PhysicsShape, PhysicsRotation, PhysicsVector } from './physics.ts';

const subtract = (a: PhysicsVector, b: PhysicsVector): PhysicsVector => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: PhysicsVector, b: PhysicsVector): PhysicsVector => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a: PhysicsVector, b: PhysicsVector): number => a.x * b.x + a.y * b.y + a.z * b.z;
function rotate(v: PhysicsVector, q?: PhysicsRotation): PhysicsVector {
  if (!q) return v;
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return { x: v.x + q.w * tx + q.y * tz - q.z * ty, y: v.y + q.w * ty + q.z * tx - q.x * tz,
    z: v.z + q.w * tz + q.x * ty - q.y * tx };
}

/** Axis-aligned bounds relative to the collider origin, with optional rotation.
 * Convex hull extrema are exact, including hulls whose origin is off-center. */
export function physicsShapeBounds(shape: PhysicsShape, rotation?: PhysicsRotation): { min: PhysicsVector; max: PhysicsVector } {
  if (shape.kind === 'convex') {
    const vertices = shape.vertices.map(v => rotate(v, rotation));
    return { min: { x: Math.min(...vertices.map(v => v.x)), y: Math.min(...vertices.map(v => v.y)), z: Math.min(...vertices.map(v => v.z)) },
      max: { x: Math.max(...vertices.map(v => v.x)), y: Math.max(...vertices.map(v => v.y)), z: Math.max(...vertices.map(v => v.z)) } };
  }
  let half: PhysicsVector;
  if (shape.kind === 'ball') half = { x: shape.radius, y: shape.radius, z: shape.radius };
  else if (shape.kind === 'capsule') {
    const axis = rotate({ x: 0, y: shape.halfHeight, z: 0 }, rotation);
    half = { x: shape.radius + Math.abs(axis.x), y: shape.radius + Math.abs(axis.y), z: shape.radius + Math.abs(axis.z) };
  } else {
    const x = rotate({ x: shape.halfExtents.x, y: 0, z: 0 }, rotation), y = rotate({ x: 0, y: shape.halfExtents.y, z: 0 }, rotation), z = rotate({ x: 0, y: 0, z: shape.halfExtents.z }, rotation);
    half = { x: Math.abs(x.x) + Math.abs(y.x) + Math.abs(z.x), y: Math.abs(x.y) + Math.abs(y.y) + Math.abs(z.y), z: Math.abs(x.z) + Math.abs(y.z) + Math.abs(z.z) };
  }
  return { min: { x: -half.x, y: -half.y, z: -half.z }, max: half };
}

/** Outward-oriented triangles of the convex hull. Input points are not changed.
 * Hull construction is bounded by the 64-point limit.
 * An incremental triangular hull handles coplanar faces without over-counting.
 * It also validates 3D extent before passing vertices into native physics. */
export function physicsConvexFaces(shape: Extract<PhysicsShape, { kind: 'convex' }>): [number, number, number][] {
  const points = shape.vertices;
  if (!Array.isArray(points) || points.length < 4 || points.length > 64 || points.some(p => !p
    || [p.x, p.y, p.z].some(n => !Number.isFinite(n) || Math.abs(n) > 1000))) throw new Error('Convex hull requires 4..64 finite bounded points.');
  const bounds = physicsShapeBounds(shape), scale = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z);
  const epsilon = Math.max(1e-9, scale * 1e-8);
  const farthest = (distance: (point: PhysicsVector) => number) => {
    let index = 0, greatest = -Infinity;
    for (let i = 0; i < points.length; i++) { const value = distance(points[i]); if (value > greatest) { index = i; greatest = value; } }
    return { index, greatest };
  };
  const a = 0, b = farthest(p => dot(subtract(p, points[a]), subtract(p, points[a]))).index;
  const ab = subtract(points[b], points[a]), length = Math.sqrt(dot(ab, ab));
  if (length <= epsilon) throw new Error('Convex hull points must span three dimensions.');
  const c = farthest(p => { const normal = cross(ab, subtract(p, points[a])); return dot(normal, normal); }).index;
  const normal = cross(ab, subtract(points[c], points[a])), normalLength = Math.sqrt(dot(normal, normal));
  if (normalLength <= epsilon * length) throw new Error('Convex hull points must span three dimensions.');
  const last = farthest(p => Math.abs(dot(normal, subtract(p, points[a]))) / normalLength), d = last.index;
  if (last.greatest <= epsilon) throw new Error('Convex hull points must span three dimensions.');
  const center = { x: (points[a].x + points[b].x + points[c].x + points[d].x) / 4,
    y: (points[a].y + points[b].y + points[c].y + points[d].y) / 4, z: (points[a].z + points[b].z + points[c].z + points[d].z) / 4 };
  type Face = { ids: [number, number, number]; normal: PhysicsVector; length: number };
  const face = (a: number, b: number, c: number): Face => {
    let normal = cross(subtract(points[b], points[a]), subtract(points[c], points[a]));
    if (dot(normal, subtract(center, points[a])) > 0) { [b, c] = [c, b]; normal = { x: -normal.x, y: -normal.y, z: -normal.z }; }
    return { ids: [a, b, c], normal, length: Math.sqrt(dot(normal, normal)) };
  };
  let faces = [face(a, b, c), face(a, d, b), face(a, c, d), face(b, d, c)];
  const initial = new Set([a, b, c, d]);
  for (let index = 0; index < points.length; index++) {
    if (initial.has(index)) continue;
    const visible = faces.filter(f => dot(f.normal, subtract(points[index], points[f.ids[0]])) > epsilon * f.length);
    if (!visible.length) continue;
    const edges = new Map<string, [number, number]>();
    for (const f of visible) for (let i = 0; i < 3; i++) {
      const one = f.ids[i], two = f.ids[(i + 1) % 3], key = `${Math.min(one, two)}:${Math.max(one, two)}`;
      if (edges.has(key)) edges.delete(key); else edges.set(key, [one, two]);
    }
    const removed = new Set(visible);
    faces = faces.filter(f => !removed.has(f));
    for (const [one, two] of edges.values()) {
      const next = face(one, two, index);
      if (next.length > epsilon * epsilon) faces.push(next);
    }
  }
  return faces.map(f => f.ids);
}

/** Solid volume in cubic metres; convex shapes are validated and triangulated. */
export function physicsShapeVolume(shape: PhysicsShape): number {
  if (shape.kind === 'box') return 8 * shape.halfExtents.x * shape.halfExtents.y * shape.halfExtents.z;
  if (shape.kind !== 'convex') return 4 * Math.PI * shape.radius ** 3 / 3
    + (shape.kind === 'capsule' ? 2 * shape.halfHeight * Math.PI * shape.radius ** 2 : 0);
  const faces = physicsConvexFaces(shape), points = shape.vertices;
  const center = points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length, z: sum.z + p.z / points.length }), { x: 0, y: 0, z: 0 });
  const volume = faces.reduce((sum, f) => sum + Math.abs(dot(subtract(points[f[0]], center),
    cross(subtract(points[f[1]], center), subtract(points[f[2]], center)))) / 6, 0);
  if (!Number.isFinite(volume) || volume <= 0) throw new Error('Convex hull has no solid volume.');
  return volume;
}
