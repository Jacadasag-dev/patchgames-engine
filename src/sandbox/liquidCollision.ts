/** Geometry for the bounded liquid solver. Pure data: no renderer/native state. */
import type { PhysicsCollider, PhysicsCompoundBody, PhysicsHeightfield, PhysicsRotation, PhysicsScene, PhysicsVector } from './physics.ts';
import { physicsConvexFaces, physicsShapeBounds, physicsShapeVolume } from './physicsGeometry.ts';

export const liquidZero = (): PhysicsVector => ({ x: 0, y: 0, z: 0 });
export const liquidAdd = (a: PhysicsVector, b: PhysicsVector): PhysicsVector => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const liquidSub = (a: PhysicsVector, b: PhysicsVector): PhysicsVector => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const liquidScale = (a: PhysicsVector, s: number): PhysicsVector => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const liquidDot = (a: PhysicsVector, b: PhysicsVector): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const liquidLength = (a: PhysicsVector): number => Math.hypot(a.x, a.y, a.z);
export const liquidNormal = (a: PhysicsVector): PhysicsVector => liquidScale(a, 1 / (liquidLength(a) || 1));
export function liquidRotate(v: PhysicsVector, q?: PhysicsRotation): PhysicsVector {
  if (!q) return { ...v };
  const t = { x: 2 * (q.y * v.z - q.z * v.y), y: 2 * (q.z * v.x - q.x * v.z), z: 2 * (q.x * v.y - q.y * v.x) };
  return { x: v.x + q.w * t.x + q.y * t.z - q.z * t.y, y: v.y + q.w * t.y + q.z * t.x - q.x * t.z,
    z: v.z + q.w * t.z + q.x * t.y - q.y * t.x };
}
function multiply(a?: PhysicsRotation, b?: PhysicsRotation): PhysicsRotation | undefined {
  if (!a) return b; if (!b) return a;
  return { x: a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y, y: a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,
    z: a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w, w: a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z };
}
type Plane = { normal: PhysicsVector; offset: number };
export interface LiquidObstacle {
  collider: PhysicsCollider; colliderId: string; bodyId?: string; velocity: PhysicsVector;
  /** Shared by every child: one compound's linear motion and offset. */
  bodyMotion?: { mass: number; velocity: PhysicsVector; offset: PhysicsVector; previousOffset: PhysicsVector };
  /** Prepared once per step; collision queries never rebuild box planes. */
  planes?: Plane[]; inverseRotation?: PhysicsRotation; min: PhysicsVector; max: PhysicsVector;
}
export interface LiquidCollision { position: PhysicsVector; normal: PhysicsVector; point: PhysicsVector }
const axes = ['x', 'y', 'z'] as const;
const stationary = Object.freeze({x:0,y:0,z:0});
function boxPlanes(half:PhysicsVector):Plane[]{
  return [{normal:{x:-1,y:0,z:0},offset:half.x},{normal:{x:1,y:0,z:0},offset:half.x},
    {normal:{x:0,y:-1,z:0},offset:half.y},{normal:{x:0,y:1,z:0},offset:half.y},
    {normal:{x:0,y:0,z:-1},offset:half.z},{normal:{x:0,y:0,z:1},offset:half.z}];
}
function finite(v: PhysicsVector): boolean { return !!v && axes.every(a => Number.isFinite(v[a]) && Math.abs(v[a]) <= 10000); }
function validate(c: PhysicsCollider): void {
  if (!c || !finite(c.position)) throw new Error('Invalid liquid collider position');
  if(c.waterBoundary!==undefined&&c.waterBoundary!==false)throw new Error('Invalid liquid collider waterBoundary');
  if (c.rotation && (!finite(c.rotation) || !Number.isFinite(c.rotation.w) || Math.abs(liquidLength(c.rotation)**2 + c.rotation.w**2 - 1) > .002))
    throw new Error('Liquid collider rotation must be a unit quaternion');
  const s = c.shape;
  if (!s || !['box','ball','capsule','convex'].includes(s.kind)) throw new Error('Unsupported liquid collider shape');
  if (s.kind === 'box' && (!finite(s.halfExtents) || axes.some(a => s.halfExtents[a] <= 0))) throw new Error('Invalid liquid box');
  if ((s.kind === 'ball' || s.kind === 'capsule') && (!Number.isFinite(s.radius) || s.radius <= 0 || s.radius > 1000)) throw new Error('Invalid liquid sphere radius');
  if (s.kind === 'capsule' && (!Number.isFinite(s.halfHeight) || s.halfHeight < 0 || s.halfHeight > 1000)) throw new Error('Invalid liquid capsule');
}
export function liquidObstacles(scene: PhysicsScene, bodies: PhysicsCompoundBody[]): LiquidObstacle[] {
  if (!Array.isArray(scene.colliders) || !Array.isArray(bodies) || scene.colliders.length > 256 || bodies.length > 64) throw new Error('Liquid collision budget exceeded');
  const result: LiquidObstacle[] = [], keys = new Set<string>();
  function add(c: PhysicsCollider, colliderId: string, velocity: PhysicsVector, bodyId?: string, bodyMotion?: LiquidObstacle['bodyMotion']): void {
    if (result.length >= 256) throw new Error('Liquid collision budget exceeded');
    if(typeof colliderId!=='string'||!colliderId.length||colliderId.length>1024)throw new Error('Invalid liquid collider identity');
    validate(c);
    const key = `${bodyId ?? ''}/${colliderId}`;
    if (keys.has(key)) throw new Error('Duplicate liquid collider identity'); keys.add(key);
    const shape = c.shape;
    const planes = shape.kind === 'box' ? boxPlanes(shape.halfExtents) : shape.kind === 'convex' ? physicsConvexFaces(shape).map(face => {
      const a = shape.vertices[face[0]], b = liquidSub(shape.vertices[face[1]], a), d = liquidSub(shape.vertices[face[2]], a);
      const normal = liquidNormal({ x: b.y*d.z-b.z*d.y, y: b.z*d.x-b.x*d.z, z: b.x*d.y-b.y*d.x });
      return { normal, offset: liquidDot(normal, a) };
    }) : undefined;
    const bounds = physicsShapeBounds(shape, c.rotation);
    const inverseRotation=c.rotation?{x:-c.rotation.x,y:-c.rotation.y,z:-c.rotation.z,w:c.rotation.w}:undefined;
    result.push({ collider: c, colliderId, bodyId, velocity, bodyMotion, planes, inverseRotation, min: liquidAdd(c.position, bounds.min), max: liquidAdd(c.position, bounds.max) });
  }
  scene.colliders.forEach((c, index) => add(c, c.id ?? `liquid-static-${index}`, liquidZero()));
  const ids = new Set<string>();
  for (const body of bodies) {
    if (!body || typeof body.id !== 'string' || !body.id || body.id.length>256 || ids.has(body.id) || !finite(body.position) || !finite(body.velocity)
      || !Array.isArray(body.colliders) || body.colliders.length > 32) throw new Error('Invalid liquid body');
    ids.add(body.id);
    const mass=body.mass??body.colliders.reduce((sum,c)=>sum+physicsShapeVolume(c.shape),0);
    if(!Number.isFinite(mass)||mass<.000001||mass>1e7)throw new Error('Invalid liquid body mass');
    const motion=body.fixed?undefined:{mass,velocity:{...body.velocity},offset:liquidZero(),previousOffset:liquidZero()};
    for (const c of body.colliders) add({ ...c, position: liquidAdd(body.position, liquidRotate(c.position, body.rotation)),
      rotation: multiply(body.rotation, c.rotation) }, c.id, body.fixed ? liquidZero() : body.velocity, body.id,motion);
  }
  return result.sort((a, b) => { const one = `${a.bodyId ?? ''}/${a.colliderId}`, two = `${b.bodyId ?? ''}/${b.colliderId}`; return one < two ? -1 : one > two ? 1 : 0; });
}
function sphereRay(start: PhysicsVector, delta: PhysicsVector, center: PhysicsVector, radius: number): { t: number; normal: PhysicsVector } | undefined {
  const p = liquidSub(start, center), a = liquidDot(delta, delta), b = liquidDot(p, delta), c = liquidDot(p, p) - radius*radius;
  if (c < 0) return { t: 0, normal: liquidLength(p) > 1e-10 ? liquidNormal(p) : { x: 0, y: 1, z: 0 } };
  const d = b*b-a*c;
  if (a < 1e-20 || b >= 0 || d < 0) return;
  const t = (-b-Math.sqrt(d))/a;
  return t >= 0 && t <= 1 ? { t, normal: liquidNormal(liquidAdd(p, liquidScale(delta, t))) } : undefined;
}
/** Exact distance to a box. Expanding its six planes alone creates square
 * ledges around corners, where spherical fluid samples can otherwise rest. */
function boxContact(x:number,y:number,z:number,half:PhysicsVector,radius:number):{normal:PhysicsVector;penetration:number}|undefined{
  const ox=Math.max(0,Math.abs(x)-half.x),oy=Math.max(0,Math.abs(y)-half.y),oz=Math.max(0,Math.abs(z)-half.z),distance=Math.hypot(ox,oy,oz);
  if(distance>radius)return;
  if(distance>1e-15)return{normal:{x:Math.sign(x)*ox/distance,y:Math.sign(y)*oy/distance,z:Math.sign(z)*oz/distance},penetration:radius-distance};
  let gap=half.x-Math.abs(x),normal={x:x>0?1:-1,y:0,z:0};
  if(half.y-Math.abs(y)<gap){gap=half.y-Math.abs(y);normal={x:0,y:y>0?1:-1,z:0};}
  if(half.z-Math.abs(z)<gap){gap=half.z-Math.abs(z);normal={x:0,y:0,z:z>0?1:-1};}
  return{normal,penetration:radius+gap};
}
/** Along a ray, squared distance to an AABB is a piecewise quadratic. Split
 * only where an axis crosses a real box face, then solve each interval for
 * the rounded edge/corner. Ordinary face hits retain the cheap slab path. */
function roundedBoxRay(a:PhysicsVector,d:PhysicsVector,half:PhysicsVector,radius:number):{t:number;normal:PhysicsVector;penetration:number}|undefined{
  const embedded=boxContact(a.x,a.y,a.z,half,radius);if(embedded)return{t:0,...embedded};
  const cuts=[0,1];
  for(const axis of axes)if(Math.abs(d[axis])>1e-15)for(const face of [-half[axis],half[axis]]){const t=(face-a[axis])/d[axis];if(t>0&&t<1)cuts.push(t);}
  cuts.sort((one,two)=>one-two);
  for(let i=0;i<cuts.length-1;i++){
    const lo=cuts[i],hi=cuts[i+1],middle=(lo+hi)*.5;let aa=0,bb=0,cc=-radius*radius;
    for(const axis of axes){const at=a[axis]+d[axis]*middle;if(Math.abs(at)<=half[axis])continue;const offset=a[axis]-Math.sign(at)*half[axis];aa+=d[axis]*d[axis];bb+=offset*d[axis];cc+=offset*offset;}
    if(aa<1e-25)continue;const discriminant=bb*bb-aa*cc;if(discriminant<0)continue;
    const t=(-bb-Math.sqrt(discriminant))/aa;if(t<lo-1e-12||t>hi+1e-12)continue;
    const clamped=Math.max(lo,Math.min(hi,t)),at={x:a.x+d.x*clamped,y:a.y+d.y*clamped,z:a.z+d.z*clamped};
    const offset={x:at.x-Math.max(-half.x,Math.min(half.x,at.x)),y:at.y-Math.max(-half.y,Math.min(half.y,at.y)),z:at.z-Math.max(-half.z,Math.min(half.z,at.z))};
    return{t:clamped,normal:liquidNormal(offset),penetration:0};
  }
}
/** Swept sphere versus analytic/convex solids. Generic convex corners remain conservative. */
export function collideLiquid(start: PhysicsVector, end: PhysicsVector, radius: number, obstacle: LiquidObstacle, time: number, fromTime = time): LiquidCollision | undefined {
  const fixed=!obstacle.bodyMotion&&obstacle.velocity.x===0&&obstacle.velocity.y===0&&obstacle.velocity.z===0;
  // Static sweeps dominate flight queries. Keep the same inclusive AABB test
  // without per-axis dynamic property lookups and zero-motion arithmetic.
  if(fixed&&(Math.max(start.x,end.x)<obstacle.min.x-radius||Math.min(start.x,end.x)>obstacle.max.x+radius
    ||Math.max(start.y,end.y)<obstacle.min.y-radius||Math.min(start.y,end.y)>obstacle.max.y+radius
    ||Math.max(start.z,end.z)<obstacle.min.z-radius||Math.min(start.z,end.z)>obstacle.max.z+radius))return;
  const travel = obstacle.bodyMotion?.offset ?? (fixed?stationary:liquidScale(obstacle.velocity, time)),
    oldTravel = obstacle.bodyMotion ? (fromTime===time?obstacle.bodyMotion.offset:obstacle.bodyMotion.previousOffset) : fixed?stationary:liquidScale(obstacle.velocity,fromTime);
  if(!fixed)for (const axis of axes) if (Math.max(start[axis], end[axis]) < obstacle.min[axis]+Math.min(travel[axis],oldTravel[axis])-radius
    || Math.min(start[axis], end[axis]) > obstacle.max[axis]+Math.max(travel[axis],oldTravel[axis])+radius) return;
  const c=obstacle.collider,origin=fixed?c.position:liquidAdd(c.position,travel);
  if(start===end&&(fixed||fromTime===time)&&!c.rotation&&c.shape.kind==='box'){
    const x=end.x-origin.x,y=end.y-origin.y,z=end.z-origin.z,half=c.shape.halfExtents;
    const hit=boxContact(x,y,z,half,radius);if(!hit)return;
    const {x:nx,y:ny,z:nz}=hit.normal,correction=hit.penetration+1e-7;
    return{position:{x:origin.x+x+nx*correction,y:origin.y+y+ny*correction,z:origin.z+z+nz*correction},normal:{x:nx,y:ny,z:nz},
      point:{x:origin.x+x-nx*radius,y:origin.y+y-ny*radius,z:origin.z+z-nz*radius}};
  }
  const oldOrigin=fixed?c.position:liquidAdd(c.position,oldTravel);
  if(c.shape.kind==='box'){
    const localStart={x:start.x-oldOrigin.x,y:start.y-oldOrigin.y,z:start.z-oldOrigin.z},localEnd={x:end.x-origin.x,y:end.y-origin.y,z:end.z-origin.z};
    const a=c.rotation?liquidRotate(localStart,obstacle.inverseRotation):localStart,b=c.rotation?liquidRotate(localEnd,obstacle.inverseRotation):localEnd;
    const ax=a.x,ay=a.y,az=a.z,dx=b.x-ax,dy=b.y-ay,dz=b.z-az,half=c.shape.halfExtents;
    let enter=0,leave=1,inside=true,closest=-Infinity,closestAxis=0,closestSign=-1,normalAxis=1,normalSign=1;
    // Expanded slabs cheaply reject misses and locate ordinary face hits.
    for(let plane=0;plane<6;plane++){
      const axis=plane>>1,sign=plane%2?1:-1,a=axis===0?ax:axis===1?ay:az,d=axis===0?dx:axis===1?dy:dz,h=axis===0?half.x:axis===1?half.y:half.z;
      const distance=sign*a-h-radius,rate=sign*d;
      if(distance>closest){closest=distance;closestAxis=axis;closestSign=sign;}
      if(distance>0)inside=false;
      if(Math.abs(rate)<1e-12){if(distance>0)return;continue;}
      const t=-distance/rate;
      if(rate<0){if(t>=enter){enter=t;normalAxis=axis;normalSign=sign;}}else leave=Math.min(leave,t);
      if(enter>leave)return;
    }
    let penetration=0;
    if(inside){enter=0;normalAxis=closestAxis;normalSign=closestSign;penetration=-closest;}
    else if(!(enter>=0&&enter<=1&&enter<=leave))return;
    let x=ax+dx*enter,y=ay+dy*enter,z=az+dz*enter,nx=normalAxis===0?normalSign:0,ny=normalAxis===1?normalSign:0,nz=normalAxis===2?normalSign:0;
    if(Number(Math.abs(x)>half.x)+Number(Math.abs(y)>half.y)+Number(Math.abs(z)>half.z)>1){
      const rounded=roundedBoxRay(a,{x:dx,y:dy,z:dz},half,radius);if(!rounded)return;
      enter=rounded.t;penetration=rounded.penetration;nx=rounded.normal.x;ny=rounded.normal.y;nz=rounded.normal.z;
      x=ax+dx*enter;y=ay+dy*enter;z=az+dz*enter;
    }
    const rx=dx*(1-enter),ry=dy*(1-enter),rz=dz*(1-enter);
    const inward=Math.min(0,rx*nx+ry*ny+rz*nz),amount=penetration-inward+1e-7;
    if(c.rotation){const normal=liquidRotate({x:nx,y:ny,z:nz},c.rotation);
      return{position:liquidAdd(origin,liquidRotate({x:x+rx+nx*amount,y:y+ry+ny*amount,z:z+rz+nz*amount},c.rotation)),normal,
        point:liquidAdd(origin,liquidRotate({x:x-nx*radius,y:y-ny*radius,z:z-nz*radius},c.rotation))};}
    return{position:{x:origin.x+(x+rx+nx*amount),y:origin.y+(y+ry+ny*amount),z:origin.z+(z+rz+nz*amount)},normal:{x:nx,y:ny,z:nz},
      point:{x:origin.x+x-nx*radius,y:origin.y+y-ny*radius,z:origin.z+z-nz*radius}};
  }
  const inverse = obstacle.inverseRotation ?? (c.rotation ? { x: -c.rotation.x, y: -c.rotation.y, z: -c.rotation.z, w: c.rotation.w } : undefined);
  const localStart=liquidSub(start,oldOrigin),localEnd=liquidSub(end,origin);
  const a = inverse?liquidRotate(localStart,inverse):localStart,b=inverse?liquidRotate(localEnd,inverse):localEnd,delta=liquidSub(b,a);
  const shape = c.shape;
  let hit: { t: number; normal: PhysicsVector } | undefined, penetration = 0;
  if (shape.kind === 'ball' || shape.kind === 'capsule') {
    const half = shape.kind === 'capsule' ? shape.halfHeight : 0, r = shape.radius + radius;
    const center = { x: 0, y: Math.max(-half, Math.min(half, a.y)), z: 0 }, offset = liquidSub(a, center);
    if (liquidLength(offset) < r) {
      hit = { t: 0, normal: liquidLength(offset) > 1e-9 ? liquidNormal(offset) : { x: 1, y: 0, z: 0 } }; penetration = r-liquidLength(offset);
    } else {
      const candidates = [sphereRay(a, delta, { x: 0, y: half, z: 0 }, r), sphereRay(a, delta, { x: 0, y: -half, z: 0 }, r)].filter(v => v !== undefined);
      if (half > 0) {
        const aa = delta.x*delta.x+delta.z*delta.z, bb = a.x*delta.x+a.z*delta.z, cc = a.x*a.x+a.z*a.z-r*r, dd = bb*bb-aa*cc;
        if (aa > 1e-20 && dd >= 0) {
          const t = (-bb-Math.sqrt(dd))/aa, y = a.y+delta.y*t;
          if (t >= 0 && t <= 1 && Math.abs(y) <= half) candidates.push({ t, normal: liquidNormal({ x: a.x+delta.x*t, y: 0, z: a.z+delta.z*t }) });
        }
      }
      hit = candidates.sort((one,two) => one.t-two.t)[0];
    }
  } else {
    const planes=obstacle.planes!;
    let enter = 0, leave = 1, normal = { x: 0, y: 1, z: 0 }, inside = true, closest = -Infinity, closestNormal = normal;
    for (const plane of planes) {
      const distance = liquidDot(plane.normal, a)-plane.offset-radius, rate = liquidDot(plane.normal, delta);
      if (distance > closest) { closest = distance; closestNormal = plane.normal; }
      if (distance > 0) inside = false;
      if (Math.abs(rate) < 1e-12) { if (distance > 0) return; continue; }
      const t = -distance/rate;
      if (rate < 0) { if (t >= enter) { enter = t; normal = plane.normal; } } else leave = Math.min(leave, t);
      if (enter > leave) return;
    }
    if (inside) { hit = { t: 0, normal: closestNormal }; penetration = -closest; }
    else if (enter >= 0 && enter <= 1 && enter <= leave) hit = { t: enter, normal };
  }
  if (!hit) return;
  const at = liquidAdd(a, liquidScale(delta, hit.t)), rest = liquidScale(delta, 1-hit.t);
  const inward = Math.min(0, liquidDot(rest, hit.normal));
  const corrected = liquidAdd(liquidAdd(at, rest), liquidScale(hit.normal, penetration-inward+1e-7));
  const normal = liquidRotate(hit.normal, c.rotation);
  return { position: liquidAdd(origin, liquidRotate(corrected, c.rotation)), normal,
    point: liquidSub(liquidAdd(origin, liquidRotate(at, c.rotation)), liquidScale(normal, radius)) };
}
type GroundTriangle={height:number;dx:number;dz:number;normal:PhysicsVector};
export interface LiquidGround { field: PhysicsHeightfield; position: PhysicsVector; id: string; triangles?:GroundTriangle[] }
export function liquidGrounds(scene: PhysicsScene): LiquidGround[] {
  const result: LiquidGround[] = [];
  if (scene.terrain) result.push({ field: scene.terrain, position: liquidZero(), id: 'liquid-terrain' });
  if (scene.terrainChunks) {
    if (!Array.isArray(scene.terrainChunks) || scene.terrainChunks.length > 16) throw new Error('Liquid active terrain budget exceeded');
    for (const field of scene.terrainChunks) result.push({ field, position: field.position, id: field.id });
  }
  for (const { field: f, position } of result) if (!finite(position) || !Number.isInteger(f.rows) || !Number.isInteger(f.columns)
    || f.rows < 1 || f.columns < 1 || f.rows > 32 || f.columns > 32 || !Number.isFinite(f.width) || f.width < .000001 || f.width > 20000 || !Number.isFinite(f.depth) || f.depth < .000001 || f.depth > 20000
    || !Array.isArray(f.heights) || f.heights.length !== (f.rows+1)*(f.columns+1) || f.heights.some(v => !Number.isFinite(v) || Math.abs(v)>10000))
    throw new Error('Invalid liquid terrain');
  for(const ground of result){const f=ground.field,triangles:GroundTriangle[]=[];
    for(let x=0;x<f.columns;x++)for(let z=0;z<f.rows;z++){
      const h00=f.heights[x*(f.rows+1)+z],h10=f.heights[(x+1)*(f.rows+1)+z],h01=f.heights[x*(f.rows+1)+z+1],h11=f.heights[(x+1)*(f.rows+1)+z+1];
      for(const lower of [true,false]){const dx=lower?h10-h00:h11-h01,dz=lower?h01-h00:h11-h10;
        triangles.push({height:lower?h00:h11,dx,dz,normal:liquidNormal({x:-dx*f.columns/f.width,y:1,z:-dz*f.rows/f.depth})});}
    }
    ground.triangles=triangles;
  }
  return result;
}
export function collideLiquidGround(position: PhysicsVector, radius: number, ground: LiquidGround): LiquidCollision | undefined {
  const f = ground.field, localY=position.y-ground.position.y, u = ((position.x-ground.position.x)/f.width+.5)*f.columns, v = ((position.z-ground.position.z)/f.depth+.5)*f.rows;
  if (u < 0 || v < 0 || u > f.columns || v > f.rows) return;
  const x = Math.min(f.columns-1,Math.floor(u)), z = Math.min(f.rows-1,Math.floor(v)), tx = u-x, tz = v-z;
  // Match the native triangular heightfield instead of smoothing across its diagonal.
  const lower = tx+tz <= 1;
  const triangle=ground.triangles?.[(x*f.rows+z)*2+(lower?0:1)];
  if(triangle){const {dx,dz,normal}=triangle,height=lower?triangle.height+tx*dx+tz*dz:triangle.height-(1-tx)*dx-(1-tz)*dz,distance=(localY-height)*normal.y;
    if(distance>=radius)return;
    const amount=radius-distance;
    return{position:{x:position.x+normal.x*amount,y:position.y+normal.y*amount,z:position.z+normal.z*amount},normal:{...normal},point:{x:position.x,y:height+ground.position.y,z:position.z}};
  }
  const h00 = f.heights[x*(f.rows+1)+z], h10 = f.heights[(x+1)*(f.rows+1)+z], h01 = f.heights[x*(f.rows+1)+z+1], h11 = f.heights[(x+1)*(f.rows+1)+z+1];
  const dx = lower ? h10-h00 : h11-h01, dz = lower ? h01-h00 : h11-h10;
  const height = lower ? h00+tx*dx+tz*dz : h11-(1-tx)*dx-(1-tz)*dz;
  const normal = liquidNormal({ x: -dx*f.columns/f.width, y: 1, z: -dz*f.rows/f.depth });
  const distance = (localY-height)*normal.y;
  if (distance >= radius) return;
  return { position: liquidAdd(position, liquidScale(normal, radius-distance)), normal,
    point: { x: position.x, y: height+ground.position.y, z: position.z } };
}
