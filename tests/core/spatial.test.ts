import { describe, expect, it } from 'vitest';
import type { PhysicsCollider, PhysicsVector } from '../../src/sandbox/physics.ts';
import { colliderBlocksCorridor, colliderBlocksRectangle, directionYaw, facingYaw, nearScore, nearestSpatialRoute,
  spatialAngle, spatialCoordinate, transformSpatialPoint } from '../../src/sandbox/spatial.ts';

describe('shared spatial placement operations', () => {
  it('uses asset +Z forward and stable generated coordinates without rounding raw cardinal inputs', () => {
    expect(directionYaw('north')).toBe(Math.PI);
    expect(facingYaw('north', 0, 0)).toBe(spatialAngle(Math.PI));
    expect(facingYaw({ x: 4, z: 0 }, 0, 0)).toBe(spatialAngle(Math.PI / 2));
    expect(facingYaw({ x: 1, z: 2 }, 1, 2)).toBeUndefined();
    expect(transformSpatialPoint({ x: 0, z: 2 }, { x: 3, z: 4 }, directionYaw('east'))).toEqual({ x: 5, z: 4 });
    expect(spatialCoordinate(.123456789)).toBe(.1234568);
    expect(Object.is(spatialCoordinate(-1e-12), -0)).toBe(false);
    expect(spatialCoordinate(NaN)).toBeNaN();
    expect(nearScore({ x: 3, z: 4 }, { x: 0, z: 0 }, 10)).toBe(.5);
    expect(nearScore({ x: 30, z: 40 }, { x: 0, z: 0 }, 10)).toBe(0);
    expect(() => nearScore({ x: 0, z: 0 }, { x: 0, z: 0 }, 0)).toThrow('range');
  });

  it('finds route proximity and forward direction with deterministic ties and duplicate vertices', () => {
    const route = [{ x: -2, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 4 }];
    const sample = nearestSpatialRoute({ x: 0, z: 2 }, route)!;
    expect(sample).toEqual({ distance: 2, point: { x: 0, z: 0 }, tangent: { x: 1, z: 0 }, index: 0, t: .5 });
    expect(facingYaw(sample.point, 0, 2)).toBe(spatialAngle(Math.PI));
    expect(facingYaw(sample.tangent, 0, 0)).toBe(spatialAngle(Math.PI / 2));
    expect(nearestSpatialRoute({ x: 3, z: 9 }, route)).toMatchObject({ distance: spatialCoordinate(Math.hypot(1, 5)), point: { x: 2, z: 4 }, index: 2, t: 1 });
    expect(nearestSpatialRoute({ x: 1, z: 1 }, [{ x: 0, z: 0 }, { x: 0, z: 0 }])).toBeUndefined();
  });

  it('allows walking through a rotated compound doorway while rejecting its posts and low lintel', () => {
    const yaw = .63, origin = { x: 7, z: -2 }, point = (x: number, y: number, z: number): PhysicsVector => ({ ...transformSpatialPoint({ x, z }, origin, yaw), y });
    const box = (x: number, y: number, z: number, halfExtents: PhysicsVector): PhysicsCollider => ({ shape: { kind: 'box', halfExtents }, position: point(x, y, z),
      rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) } });
    const posts = [-1.1, 1.1].map(x => box(x, 1.5, 0, { x: .2, y: 1.5, z: .25 }));
    const high = box(0, 2.6, 0, { x: 1.3, y: .2, z: .25 }), low = box(0, 1.8, 0, { x: 1.3, y: .2, z: .25 });
    const start = point(0, 0, -3), end = point(0, 0, 3);
    expect([...posts, high].some(collider => colliderBlocksCorridor(collider, start, end, .3, 1.8))).toBe(false);
    expect(colliderBlocksCorridor(low, start, end, .3, 1.8)).toBe(true);
    expect(colliderBlocksCorridor(posts[0], point(-1.1, 0, -3), point(-1.1, 0, 3), .3, 1.8)).toBe(true);
    expect(colliderBlocksCorridor({ shape: { kind: 'ball', radius: .4 }, position: point(0, .4, 0) }, start, end, .3, 1.8)).toBe(true);
  });

  it('tests street rectangles without rounded end overreach and respects rotated posts and overhead geometry', () => {
    const street = { x: 0, z: 0, width: 2, depth: 10 };
    const post: PhysicsCollider = { shape: { kind: 'box', halfExtents: { x: .2, y: 1.5, z: .2 } }, position: { x: 1.3, y: 1.5, z: 0 },
      rotation: { x: 0, y: Math.sin(Math.PI / 8), z: 0, w: Math.cos(Math.PI / 8) } };
    expect(colliderBlocksRectangle(post, street, 0, 1.8)).toBe(false);
    expect(colliderBlocksRectangle({ ...post, position: { ...post.position, x: 1.25 } }, street, 0, 1.8)).toBe(true);
    const lintel: PhysicsCollider = { shape: { kind: 'box', halfExtents: { x: 1.5, y: .2, z: .2 } }, position: { x: 0, y: 2.2, z: 0 } };
    expect(colliderBlocksRectangle(lintel, street, 0, 1.8)).toBe(false);
    expect(colliderBlocksRectangle({ ...lintel, position: { x: 0, y: 1.9, z: 0 } }, street, 0, 1.8)).toBe(true);
    expect(colliderBlocksRectangle({ shape: { kind: 'ball', radius: .2 }, position: { x: 1.19, y: .2, z: 5.19 } }, street, 0, 1.8)).toBe(false);
    expect(colliderBlocksRectangle({ shape: { kind: 'ball', radius: .2 }, position: { x: 1.1, y: .2, z: 5.1 } }, street, 0, 1.8)).toBe(true);
    expect(colliderBlocksRectangle({ ...post, rotation: undefined, position: { x: 0, y: 1.5, z: 5.3 } }, street, 0, 1.8)).toBe(false);
  });
});
