import RAPIER from '@dimforge/rapier3d-compat';
import { z } from 'zod';
import { physicsShapeBounds, physicsShapeVolume } from '../physicsGeometry.ts';
import { PHYSICS_VERSION, PHYSICS_SCENE_LIMITS as LIMITS, PHYSICS_COMPOUND_LIMITS as COMPOUND,
  type PhysicsCollider, type PhysicsHeightfield, type PhysicsCompoundStep, type PhysicsCompoundResult,
  type PhysicsImpact, type PhysicsVector, type PhysicsRotation,
  type PhysicsTerrainChunk, type PhysicsScene, type PhysicsStep, type PhysicsRay, type PhysicsBodyResult } from '../physics.ts';

// This version is part of the replay ABI. Preserve this implementation and the
// pinned engine when adding a future version; never silently upgrade old replays.
let loading: Promise<void> | undefined;
export const loadPhysics = () => loading ??= RAPIER.init().then(() => {
  // Compile the host validators and exercise native entry points before a live
  // tick's deadline starts. The first ray may otherwise pay cold JIT costs.
  // This disposable, fixed scene never executes game code or seeds match state.
  const bridge = new PhysicsBridge();
  const call = (operation: string, request: unknown) => {
    const result = JSON.parse(bridge.dispatch(JSON.stringify({ version: PHYSICS_VERSION, operation, request })));
    if (result.error) throw new Error(`Physics initialization failed: ${result.error}`);
  };
  try {
    call('scene', { colliders: [{ id:'warmup-floor',shape: { kind: 'box', halfExtents: { x: 2, y: 0.5, z: 2 } }, position: { x: 0, y: -0.5, z: 0 } }] });
    for (let i = 0; i < 3; i++) {
      call('scene-edit',{base:i+1,order:['warmup-floor'],colliders:[]});
      call('ray', { origin: { x: 0, y: 2, z: 0 }, direction: { x: 0, y: -1, z: 0 }, distance: 4 });
      call('rays', [{ origin: { x: 0, y: 2, z: 0 }, direction: { x: 0, y: -1, z: 0 }, distance: 4 }]);
      call('step', { bodies: [{ shape: { kind: 'capsule', radius: 0.4, halfHeight: 0.5 },
        position: { x: 0, y: 1, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, lockRotations: true }],
        gravity: { x: 0, y: -10, z: 0 }, dt: 1 / 30 });
      // The offset child also warms the off-center contact support fallback.
      call('step-compound', { bodies: [{ id: 'warmup', position: { x: 4, y: 0.5, z: 0 },
        velocity: { x: 0, y: -1, z: 0 }, colliders: [{ id: 'solid', position: { x: -4, y: 0, z: 0 },
          shape: { kind: 'ball', radius: 0.5 } }] }], gravity: { x: 0, y: -10, z: 0 }, dt: 1 / 30 });
    }
  } finally { bridge.dispose(); }
});
const coordinate = z.number().finite().min(-10000).max(10000);
const vector = z.strictObject({ x: coordinate, y: coordinate, z: coordinate });
const dimension = z.number().finite().min(0.02).max(1000);
const rotation = z.strictObject({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite(), w: z.number().finite() })
  .refine(q => Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 0.001, 'Rotation must be a unit quaternion');
const shape = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ball'), radius: dimension }),
  z.strictObject({ kind: z.literal('capsule'), radius: dimension, halfHeight: z.number().finite().min(0).max(1000) }),
  z.strictObject({ kind: z.literal('box'), halfExtents: z.strictObject({ x: dimension, y: dimension, z: dimension }) }),
  z.strictObject({ kind: z.literal('convex'), vertices: z.array(z.strictObject({
    x: z.number().finite().min(-1000).max(1000), y: z.number().finite().min(-1000).max(1000), z: z.number().finite().min(-1000).max(1000),
  })).min(4).max(64) }),
]);
const stableId = z.string().min(1).max(128);
const collider = z.strictObject({ id: stableId.optional(), shape, position: vector, rotation: rotation.optional(),
  friction: z.number().min(0).max(2).optional(), restitution: z.number().min(0).max(1).optional(), waterBoundary:z.literal(false).optional() });
const heightfield = { rows: z.number().int().min(1).max(LIMITS.terrainCells), columns: z.number().int().min(1).max(LIMITS.terrainCells),
  heights: z.array(coordinate).max(LIMITS.terrainSamples), width: dimension, depth: dimension };
const terrain = z.strictObject(heightfield)
  .refine(t => t.heights.length === (t.rows + 1) * (t.columns + 1), 'Heightfield dimensions do not match');
const terrainChunk = z.strictObject({ ...heightfield, id: z.string().min(1).max(128), position: vector })
  .refine(t => t.heights.length === (t.rows + 1) * (t.columns + 1), 'Heightfield dimensions do not match');
const sceneSchema = z.strictObject({ colliders: z.array(collider).max(LIMITS.streamedColliders), terrain: terrain.optional(),
  staticMap: z.strictObject({ revision: stableId.refine(value => value.trim().length > 0, 'Static map revision must be nonempty') }).optional(),
  terrainChunks: z.array(terrainChunk).max(LIMITS.terrainChunks).optional() }).superRefine((scene, ctx) => {
  if (scene.staticMap && scene.terrainChunks?.length)
    ctx.addIssue({ code: 'custom', message: 'Static maps and streamed terrain use separate scene contracts' });
  if (scene.staticMap && scene.colliders.length > LIMITS.staticMapColliders)
    ctx.addIssue({ code: 'custom', message: 'Static map collider limit exceeded' });
  if (!scene.staticMap && !scene.terrainChunks?.length && scene.colliders.length > LIMITS.colliders)
    ctx.addIssue({ code: 'custom', message: 'Small-scene collider limit exceeded' });
  const colliderIds = new Set<string>();
  for (const collider of scene.colliders) {
    if (scene.staticMap && (collider.id === undefined || !collider.id.trim()))
      ctx.addIssue({ code: 'custom', message: 'Static map colliders require stable IDs' });
    if (collider.id === undefined) continue;
    if (colliderIds.has(collider.id)) ctx.addIssue({ code: 'custom', message: 'Static collider IDs must be unique' });
    colliderIds.add(collider.id);
  }
  const ids = new Set<string>(); let samples = scene.terrain?.heights.length ?? 0;
  for (const chunk of scene.terrainChunks ?? []) {
    if (ids.has(chunk.id)) ctx.addIssue({ code: 'custom', message: 'Terrain chunk IDs must be unique' });
    ids.add(chunk.id); samples += chunk.heights.length;
  }
  if (samples > LIMITS.streamedTerrainSamples) ctx.addIssue({ code: 'custom', message: 'Active terrain sample limit exceeded' });
});
const sceneEditSchema=z.strictObject({base:z.number().int().nonnegative(),order:z.array(stableId).max(LIMITS.streamedColliders),
  colliders:z.array(collider.extend({id:stableId})).max(512)});
const stepSchema = z.strictObject({ bodies: z.array(collider.extend({ velocity: vector,
  angularVelocity: vector.optional(), fixed: z.boolean().optional(), lockRotations: z.boolean().optional(),
  mass: z.number().min(0.01).max(10000).optional() })).min(1).max(32), gravity: vector,
  dt: z.number().finite().positive().max(0.25) });
const compoundSchema = z.strictObject({ bodies: z.array(z.strictObject({
  id: stableId, position: vector, rotation: rotation.optional(), velocity: vector,
  angularVelocity: vector.optional(), fixed: z.boolean().optional(), lockRotations: z.boolean().optional(),
  mass: z.number().finite().min(0.01).max(1e7).optional(),
  colliders: z.array(collider.extend({ id: stableId })).min(1).max(COMPOUND.collidersPerBody),
})).min(1).max(COMPOUND.bodies), gravity: vector, dt: z.number().finite().positive().max(0.25),
  impactThreshold: z.number().finite().min(0).max(1e12).optional(),
}).superRefine((request, ctx) => {
  const ids = new Set<string>(); let count = 0;
  for (const body of request.bodies) {
    if (ids.has(body.id)) ctx.addIssue({ code: 'custom', message: 'Compound body IDs must be unique' });
    ids.add(body.id);
    const children = new Set<string>();
    for (const child of body.colliders) {
      count++;
      if (children.has(child.id)) ctx.addIssue({ code: 'custom', message: 'Compound child IDs must be unique within a body' });
      children.add(child.id);
      const local = rotate(child.position, body.rotation);
      if ([local.x + body.position.x, local.y + body.position.y, local.z + body.position.z].some(n => !Number.isFinite(n) || Math.abs(n) > 10000))
        ctx.addIssue({ code: 'custom', message: 'Compound child world position is out of bounds' });
    }
  }
  if (count > COMPOUND.colliders) ctx.addIssue({ code: 'custom', message: 'Compound collider limit exceeded' });
});
const raySchema = z.strictObject({ origin: vector, direction: vector,
  distance: z.number().finite().positive().max(10000) });
const raysSchema = z.array(raySchema).max(256);

/** Shared trust boundary for engine services that sample the same physics data. */
export const validatePhysicsScene = (scene: unknown): PhysicsScene => sceneSchema.parse(scene);
export const validatePhysicsCompoundBodies = (bodies: unknown): PhysicsCompoundStep['bodies'] => {
  if (Array.isArray(bodies) && !bodies.length) return [];
  return compoundSchema.parse({bodies,gravity:{x:0,y:-9.81,z:0},dt:1/30}).bodies;
};

function descriptor(c: PhysicsCollider) {
  const s = c.shape;
  const d = s.kind === 'ball' ? RAPIER.ColliderDesc.ball(s.radius)
    : s.kind === 'capsule' ? RAPIER.ColliderDesc.capsule(s.halfHeight, s.radius)
      : s.kind === 'box' ? RAPIER.ColliderDesc.cuboid(s.halfExtents.x, s.halfExtents.y, s.halfExtents.z)
        : convexDescriptor(s);
  d.setFriction(c.friction ?? 0).setRestitution(c.restitution ?? 0);
  return d;
}

function convexDescriptor(shape: Extract<PhysicsCollider['shape'], { kind: 'convex' }>): RAPIER.ColliderDesc {
  physicsShapeVolume(shape);
  const descriptor = RAPIER.ColliderDesc.convexHull(new Float32Array(shape.vertices.flatMap(point => [point.x, point.y, point.z])));
  if (!descriptor) throw new Error('Convex hull could not form a native solid.');
  return descriptor;
}

function rotate(v: PhysicsVector, q?: PhysicsRotation): PhysicsVector {
  if (!q) return v;
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return { x: v.x + q.w * tx + q.y * tz - q.z * ty,
    y: v.y + q.w * ty + q.z * tx - q.x * tz, z: v.z + q.w * tz + q.x * ty - q.y * tx };
}
function volume(c: PhysicsCollider): number {
  return physicsShapeVolume(c.shape);
}
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function compareImpact(a: PhysicsImpact, b: PhysicsImpact): number {
  return compareId(a.bodyId, b.bodyId) || compareId(a.colliderId, b.colliderId)
    || compareId(a.otherBodyId ?? '', b.otherBodyId ?? '') || compareId(a.otherColliderId ?? '', b.otherColliderId ?? '');
}

/** One bounded cache per QuickJS sandbox. Native worlds are always freed. */
export class PhysicsBridge {
  private scene:PhysicsScene|undefined;
  private sceneGeneration=0;
  private colliderDescriptors=new WeakMap<PhysicsCollider,RAPIER.ColliderDesc>();
  private key = '';
  private snapshot: Uint8Array | null = null;
  private queryWorld: RAPIER.World | null = null;
  private staticIds = new Map<number, string>();
  private deserializer: RAPIER.SerializationPipeline | null = null;
  /** Active chunks only: immutable shape data can survive a neighboring chunk update. */
  private heightfields = new Map<string, { key: string; descriptor: RAPIER.ColliderDesc }>();

  dispatch(json: string): string {
    try {
      if (json.length > LIMITS.streamedSceneChars) throw new Error('Physics request exceeds limit');
      const data = JSON.parse(json);
      const sceneUpload = data.operation === 'scene'||data.operation==='scene-bind';
      const staticMapScene = sceneUpload && data.request?.staticMap !== undefined;
      const streamedScene = sceneUpload && Array.isArray(data.request?.terrainChunks) && data.request.terrainChunks.length > 0;
      const requestLimit = staticMapScene ? LIMITS.staticMapSceneChars : streamedScene ? LIMITS.streamedSceneChars : LIMITS.requestChars;
      if (json.length > requestLimit) throw new Error('Physics request exceeds limit');
      if (data.version !== PHYSICS_VERSION) throw new Error('Unsupported recorded physics version');
      if (data.operation === 'scene'||data.operation==='scene-bind') {
        const scene=sceneSchema.parse(data.request);this.configure(scene);this.scene=scene;this.sceneGeneration++;
        return JSON.stringify({ value:data.operation==='scene'?true:this.sceneGeneration });
      }
      if(data.operation==='scene-edit'){
        const edit=sceneEditSchema.parse(data.request),previous=this.scene;
        if(!previous||edit.base!==this.sceneGeneration)throw new Error('Stale physics scene edit');
        if(previous.staticMap)throw new Error('Static map geometry is immutable; prepare a complete replacement scene');
        const current=new Map(previous.colliders.map(c=>[c.id,c])),ids=new Set(edit.order),changed=new Set<string>();
        if(ids.size!==edit.order.length||(!previous.terrainChunks?.length&&ids.size>LIMITS.colliders))throw new Error('Invalid physics scene edit order');
        for(const c of edit.colliders){if(!ids.has(c.id)||changed.has(c.id))throw new Error('Invalid physics scene edit collider');changed.add(c.id);current.set(c.id,c);}
        const colliders=edit.order.map(id=>{const c=current.get(id);if(!c)throw new Error('Missing physics scene edit collider');return c;});
        const scene={...previous,colliders};this.configure(scene);this.scene=scene;this.sceneGeneration++;
        return JSON.stringify({ value:this.sceneGeneration });
      }
      if (data.operation === 'rays') {
        const rays = raysSchema.parse(data.request);
        if (!this.queryWorld) throw new Error('Configure a physics scene first');
        return JSON.stringify({ value: rays.map(ray => this.ray(ray)) });
      }
      if (data.operation === 'step-compound') {
        return JSON.stringify({ value: this.stepCompound(compoundSchema.parse(data.request)) });
      }
      const request = data.operation === 'step' ? stepSchema.parse(data.request)
        : data.operation === 'ray' ? raySchema.parse(data.request) : null;
      if (!request) throw new Error('Unknown physics operation');
      return JSON.stringify({ value: data.operation === 'step' ? this.step(request as Omit<PhysicsStep, 'scene'>) : this.ray(request as Omit<PhysicsRay, 'scene'>) });
    } catch (error) {
      return JSON.stringify({ error: error instanceof z.ZodError ? 'Invalid or excessive physics request'
        : error instanceof SyntaxError && json.length > LIMITS.requestChars ? 'Physics request exceeds limit'
        : error instanceof Error ? error.message.slice(0, 200) : 'Physics request failed' });
    }
  }

  private configure(scene: PhysicsScene): void {
    // Native insertion order must not depend on which neighbor loaded first.
    // Dynamic snapshots are rebuilt canonically, never from a solver-mutated world.
    const chunks = scene.terrainChunks?.slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const key = JSON.stringify(chunks ? { ...scene, terrainChunks: chunks } : scene);
    if (key !== this.key || !this.snapshot) {
      const base = new RAPIER.World({ x: 0, y: 0, z: 0 });
      const nextHeightfields = new Map<string, { key: string; descriptor: RAPIER.ColliderDesc }>();
      const nextStaticIds = new Map<number, string>();
      const addHeightfield = (id: string, t: PhysicsHeightfield, position?: PhysicsTerrainChunk['position']) => {
        const key = JSON.stringify(t);
        const retained = this.heightfields.get(id);
        let cached = retained?.key === key ? retained : undefined;
        if (!cached) {
          const descriptor = RAPIER.ColliderDesc.heightfield(t.rows, t.columns,
            new Float32Array(t.heights), { x: t.width, y: 1, z: t.depth }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES).setFriction(0);
          if (position) descriptor.setTranslation(position.x, position.y, position.z);
          cached = { key, descriptor };
        }
        nextHeightfields.set(id, cached);
        base.createCollider(cached.descriptor);
      };
      try {
        for (const c of scene.colliders) {
          let d=this.colliderDescriptors.get(c);
          if(!d){d=descriptor(c).setTranslation(c.position.x,c.position.y,c.position.z);if(c.rotation)d.setRotation(c.rotation);this.colliderDescriptors.set(c,d);}
          const created = base.createCollider(d);
          if (c.shape.kind === 'convex' && (!Number.isFinite(created.volume()) || created.volume() <= 0))
            throw new Error('Convex native collider has no solid volume.');
          if (c.id !== undefined) nextStaticIds.set(created.handle, c.id);
        }
        if (scene.terrain) addHeightfield('legacy', scene.terrain);
        for (const chunk of chunks ?? []) addHeightfield('chunk:' + chunk.id, chunk, chunk.position);
        // Populate query acceleration structures before taking the reusable static snapshot.
        base.step();
        const snapshot = base.takeSnapshot();
        // Commit only after the entire replacement is valid and native creation succeeds.
        this.snapshot = snapshot;
        this.heightfields = nextHeightfields;
        this.staticIds = nextStaticIds;
        this.key = key;
      } catch (error) { base.free(); throw error; }
      this.queryWorld?.free();
      this.queryWorld = base;
    }
  }

  private world(): RAPIER.World {
    if (!this.snapshot) throw new Error('Configure a physics scene first');
    // Rapier's static helper allocates a new native serialization pipeline on
    // every restore without freeing that temporary pipeline. Retain only this
    // stateless decoder; every step still owns a fresh canonical solver world.
    this.deserializer ??= new RAPIER.SerializationPipeline();
    return this.deserializer.deserializeAll(this.snapshot);
  }

  private step(request: Omit<PhysicsStep, 'scene'>): PhysicsBodyResult[] {
    const world = this.world();
    try {
      world.gravity = request.gravity;
      const pairs = request.bodies.map(c => {
        const d = c.fixed ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true).setCanSleep(false);
        d.setTranslation(c.position.x, c.position.y, c.position.z);
        d.setLinvel(c.velocity.x, c.velocity.y, c.velocity.z);
        if (c.rotation) d.setRotation(c.rotation);
        if (c.angularVelocity) d.setAngvel(c.angularVelocity);
        if (c.lockRotations) d.lockRotations();
        const body = world.createRigidBody(d);
        const desc = descriptor(c);
        if (c.mass !== undefined) desc.setMass(c.mass);
        const collider = world.createCollider(desc, body);
        if (c.shape.kind === 'convex' && (!Number.isFinite(collider.volume()) || collider.volume() <= 0))
          throw new Error('Convex native collider has no solid volume.');
        return { body, collider };
      });
      // Fixed substeps and CCD keep fast bodies from tunnelling without unbounded work.
      const steps = Math.ceil(request.dt * 60);
      world.timestep = request.dt / steps;
      world.integrationParameters.maxCcdSubsteps = 4;
      for (let i = 0; i < steps; i++) world.step();
      return pairs.map(({ body, collider }, i) => {
        const position = body.translation();
        const s = request.bodies[i].shape;
        const half = s.kind === 'ball' ? s.radius : s.kind === 'capsule' ? s.radius + s.halfHeight
          : s.kind === 'box' ? s.halfExtents.y : Math.max(Math.abs(physicsShapeBounds(s, body.rotation()).min.y), Math.abs(physicsShapeBounds(s, body.rotation()).max.y));
        // A ray exactly on a heightfield triangle seam can miss due to f32
        // rounding. Nearby probes keep grounded detection stable at seams.
        let hit: RAPIER.RayColliderIntersection | null = null;
        for (const offset of [0, 0.0001, -0.0001]) {
          hit = world.castRayAndGetNormal(new RAPIER.Ray({ x: position.x + offset, y: position.y, z: position.z + offset },
            { x: 0, y: -1, z: 0 }), half * 2 + 0.08, false, undefined, undefined, collider, body);
          if (hit) break;
        }
        return { position, rotation: body.rotation(), velocity: body.linvel(), angularVelocity: body.angvel(),
          ground: hit ? { distance: hit.timeOfImpact, normal: hit.normal } : null };
      });
    } finally { world.free(); }
  }

  private stepCompound(request: Omit<PhysicsCompoundStep, 'scene'>): PhysicsCompoundResult {
    const world = this.world();
    let events: RAPIER.EventQueue | undefined;
    try {
      events = new RAPIER.EventQueue(true);
      world.gravity = request.gravity;
      const owners = new Map<number, { bodyId: string; colliderId: string }>();
      const bodies = [...request.bodies].sort((a, b) => compareId(a.id, b.id)).map(source => {
        const d = source.fixed ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true).setCanSleep(false);
        d.setTranslation(source.position.x, source.position.y, source.position.z);
        d.setLinvel(source.velocity.x, source.velocity.y, source.velocity.z);
        if (source.rotation) d.setRotation(source.rotation);
        if (source.angularVelocity) d.setAngvel(source.angularVelocity);
        if (source.lockRotations) d.lockRotations();
        const body = world.createRigidBody(d);
        const children = [...source.colliders].sort((a, b) => compareId(a.id, b.id));
        const hasConvex = children.some(child => child.shape.kind === 'convex');
        const totalVolume = hasConvex ? 0 : children.reduce((sum, child) => sum + volume(child), 0);
        const colliders = children.map(child => {
          const desc = descriptor(child).setTranslation(child.position.x, child.position.y, child.position.z)
            .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(0);
          if (child.rotation) desc.setRotation(child.rotation);
          if (source.mass !== undefined && !hasConvex) desc.setMass(source.mass * volume(child) / totalVolume);
          const collider = world.createCollider(desc, body);
          owners.set(collider.handle, { bodyId: source.id, colliderId: child.id });
          return { collider, source: child };
        });
        if (hasConvex) {
          const volumes = colliders.map(({ collider }) => collider.volume()), sum = volumes.reduce((a, b) => a + b, 0);
          if (!Number.isFinite(sum) || volumes.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('Convex native collider has no solid volume.');
          if (source.mass !== undefined) colliders.forEach(({ collider }, index) => collider.setMass(source.mass! * volumes[index] / sum));
          body.recomputeMassPropertiesFromColliders();
        }
        return { id: source.id, body, colliders };
      });
      type Sample = { point: PhysicsVector; normal: PhysicsVector; strength: number };
      const contacts = new Map<string, { a: number; b: number; impulse: number; sample?: Sample }>();
      const contactSample = (a: number, b: number, strength: number): Sample | undefined => {
        let selected: Sample | undefined, best = -Infinity;
        world.contactPair(world.getCollider(a), world.getCollider(b), (manifold, flipped) => {
          let manifoldImpulse = 0;
          for (let index = 0; index < manifold.numContacts(); index++) manifoldImpulse += manifold.contactImpulse(index);
          if (!Number.isFinite(manifoldImpulse)) return;
          const direction = manifold.normal(), sign = flipped ? 1 : -1;
          for (let index = 0; index < manifold.numSolverContacts(); index++) {
            const point = manifold.solverContactPoint(index);
            if (!point || ![point.x, point.y, point.z, direction.x, direction.y, direction.z].every(Number.isFinite)) continue;
            // Native order is stable for equal impulses; retaining its first
            // point avoids recomputing a fictitious contact from final body poses.
            if (manifoldImpulse <= best) continue;
            best = manifoldImpulse;
            selected = { point: { x: point.x, y: point.y, z: point.z },
              normal: { x: sign * direction.x, y: sign * direction.y, z: sign * direction.z }, strength };
          }
        });
        return selected;
      };
      const steps = Math.ceil(request.dt * 60), dt = request.dt / steps;
      world.timestep = dt;
      world.integrationParameters.maxCcdSubsteps = 4;
      for (let i = 0; i < steps; i++) {
        world.step(events);
        let excessive = false, invalid = false;
        events.drainContactForceEvents(event => {
          const one = event.collider1(), two = event.collider2();
          const first = owners.get(one), second = owners.get(two);
          if ((!first && !second) || (first && second && first.bodyId === second.bodyId)) return;
          const impulse = event.totalForceMagnitude() * dt;
          if (!Number.isFinite(impulse)) { invalid = true; return; }
          if (impulse <= 0) return;
          const a = Math.min(one, two), b = Math.max(one, two), key = `${a}:${b}`;
          const previous = contacts.get(key);
          if (previous) {
            previous.impulse += impulse;
            if (!previous.sample || impulse > previous.sample.strength) previous.sample = contactSample(a, b, impulse) ?? previous.sample;
          }
          else if (contacts.size < COMPOUND.contactPairs) contacts.set(key, { a, b, impulse, sample: contactSample(a, b, impulse) });
          else excessive = true;
        });
        if (invalid) throw new Error('Non-finite compound contact impulse');
        if (excessive) throw new Error('Compound contact pair limit exceeded');
      }
      // Unnamed static contacts cannot be distinguished by callers: combine them
      // for each child instead of returning ambiguous duplicate records.
      const directed = new Map<string, PhysicsImpact>();
      const sampleStrengths = new Map<string, number>();
      const contactNeighbors = new Map<number, number[]>();
      const record = (handle: number, other: number, impulse: number, sample?: Sample, reverse = false) => {
        const own = owners.get(handle);
        if (!own) return;
        const neighbor = owners.get(other), otherColliderId = neighbor?.colliderId ?? this.staticIds.get(other);
        const key = JSON.stringify([own.bodyId, own.colliderId, neighbor?.bodyId ?? null, otherColliderId ?? null]);
        const previous = directed.get(key);
        const entry: PhysicsImpact = previous ?? { ...own, ...(neighbor ? { otherBodyId: neighbor.bodyId } : {}),
          ...(otherColliderId !== undefined ? { otherColliderId } : {}), impulse: 0 };
        entry.impulse += impulse;
        if (sample && sample.strength > (sampleStrengths.get(key) ?? -Infinity)) {
          entry.point = { ...sample.point };
          entry.normal = reverse ? { x: -sample.normal.x, y: -sample.normal.y, z: -sample.normal.z } : { ...sample.normal };
          sampleStrengths.set(key, sample.strength);
        }
        directed.set(key, entry);
      };
      for (const contact of [...contacts.values()].sort((a, b) => a.a - b.a || a.b - b.b)) {
        record(contact.a, contact.b, contact.impulse, contact.sample); record(contact.b, contact.a, contact.impulse, contact.sample, true);
        for (const [own, other] of [[contact.a, contact.b], [contact.b, contact.a]]) {
          if (!owners.has(own)) continue;
          const neighbors = contactNeighbors.get(own) ?? [];
          neighbors.push(other); contactNeighbors.set(own, neighbors);
        }
      }
      const impacts = [...directed.values()].filter(contact => contact.impulse >= (request.impactThreshold ?? 0));
      const impactsTruncated = impacts.length > COMPOUND.impacts;
      if (impactsTruncated) impacts.sort((a, b) => b.impulse - a.impulse || compareImpact(a, b)).length = COMPOUND.impacts;
      impacts.sort(compareImpact);
      return { impacts, impactsTruncated, bodies: bodies.map(({ id, body, colliders }) => {
        const position = body.translation();
        let half = 0;
        for (const { collider, source } of colliders) {
          const s = source.shape, q = collider.rotation();
          const y = s.kind === 'ball' ? s.radius : s.kind === 'capsule'
            ? s.radius + Math.abs(rotate({ x: 0, y: 1, z: 0 }, q).y) * s.halfHeight
            : s.kind === 'convex' ? Math.max(Math.abs(physicsShapeBounds(s, q).min.y), Math.abs(physicsShapeBounds(s, q).max.y))
            : Math.abs(rotate({ x: 1, y: 0, z: 0 }, q).y) * s.halfExtents.x
              + Math.abs(rotate({ x: 0, y: 1, z: 0 }, q).y) * s.halfExtents.y
              + Math.abs(rotate({ x: 0, y: 0, z: 1 }, q).y) * s.halfExtents.z;
          half = Math.max(half, Math.abs(collider.translation().y - position.y) + y);
        }
        let hit: RAPIER.RayColliderIntersection | null = null;
        for (const offset of [0, 0.0001, -0.0001]) {
          hit = world.castRayAndGetNormal(new RAPIER.Ray({ x: position.x + offset, y: position.y, z: position.z + offset },
            { x: 0, y: -1, z: 0 }), half * 2 + 0.08, false, undefined, undefined, undefined, body);
          if (hit) break;
        }
        let ground: PhysicsBodyResult['ground'] = hit ? { distance: hit.timeOfImpact, normal: hit.normal } : null;
        // A wide slab can rest on corner supports with empty space under its
        // pivot. Recheck bounded native contact pairs at the final pose so these
        // bodies can settle, without treating an earlier impact or side contact
        // as present support. Keep the usual center-ray result for characters.
        if (!ground) for (const { collider } of colliders) {
          for (const other of contactNeighbors.get(collider.handle) ?? []) {
            const contact = collider.contactCollider(world.getCollider(other), 0.02);
            if (!contact || contact.normal2.y <= 0.5) continue;
            const distance = Math.max(0, position.y - contact.point2.y);
            if (!ground || distance < ground.distance) ground = { distance, normal: contact.normal2 };
          }
        }
        return { id, position, rotation: body.rotation(), velocity: body.linvel(), angularVelocity: body.angvel(),
          ground };
      }) };
    } finally {
      try { events?.free(); } finally { world.free(); }
    }
  }

  private ray(request: Omit<PhysicsRay, 'scene'>) {
    // Queries do not mutate the static scene. Reuse its acceleration structures
    // instead of restoring/freeing a native world for every projectile ray.
    // Steps still restore independent snapshots so solver history cannot leak.
    if (!this.queryWorld) throw new Error('Configure a physics scene first');
    const hit = this.queryWorld.castRayAndGetNormal(new RAPIER.Ray(request.origin, request.direction), request.distance, true);
    if (!hit) return null;
    const colliderId = this.staticIds.get(hit.collider.handle);
    return { distance: hit.timeOfImpact, normal: hit.normal, ...(colliderId !== undefined ? { colliderId } : {}) };
  }

  dispose(): void {
    try { this.queryWorld?.free(); }
    finally {
      this.queryWorld = null; this.snapshot = null; this.key = ''; this.heightfields.clear(); this.staticIds.clear();
      this.scene=undefined;this.sceneGeneration=0;
      this.colliderDescriptors=new WeakMap();
      try { this.deserializer?.free(); } finally { this.deserializer = null; }
    }
  }
}
