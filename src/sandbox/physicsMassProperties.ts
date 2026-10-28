/** Pure solid mass properties shared by fluid coupling and stability probes.
 * Match compound rigid bodies: uniform density, with child mass proportional
 * to solid volume. All returned moments are about the actual world mass center. */
import type {PhysicsCompoundBody,PhysicsRotation,PhysicsShape,PhysicsVector} from './physics.ts';
import {physicsConvexFaces,physicsShapeVolume} from './physicsGeometry.ts';

export type PhysicsMatrix3=[number,number,number,number,number,number,number,number,number];
export interface PhysicsBodyMassProperties {
  mass:number;center:PhysicsVector;inertia:PhysicsMatrix3;inverseInertia:PhysicsMatrix3;
}
type SolidProperties={volume:number;center:PhysicsVector;inertia:PhysicsMatrix3};
const zero=():PhysicsVector=>({x:0,y:0,z:0});
const matrix=():PhysicsMatrix3=>[0,0,0,0,0,0,0,0,0];
const add=(a:PhysicsVector,b:PhysicsVector):PhysicsVector=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
const sub=(a:PhysicsVector,b:PhysicsVector):PhysicsVector=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const scale=(v:PhysicsVector,n:number):PhysicsVector=>({x:v.x*n,y:v.y*n,z:v.z*n});
const dot=(a:PhysicsVector,b:PhysicsVector)=>a.x*b.x+a.y*b.y+a.z*b.z;
const cross=(a:PhysicsVector,b:PhysicsVector):PhysicsVector=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
const components=(v:PhysicsVector)=>[v.x,v.y,v.z];
const validVector=(v:PhysicsVector)=>!!v&&components(v).every(Number.isFinite);
function rotation(q?:PhysicsRotation):PhysicsMatrix3 {
  if(!q)return[1,0,0,0,1,0,0,0,1];
  if(!validVector(q)||!Number.isFinite(q.w)||Math.abs(Math.hypot(q.x,q.y,q.z,q.w)-1)>.001)throw new Error('Invalid mass properties rotation');
  const {x,y,z,w}=q;
  return[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w),2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w),2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)];
}
function apply(m:PhysicsMatrix3,v:PhysicsVector):PhysicsVector {
  return{x:m[0]*v.x+m[1]*v.y+m[2]*v.z,y:m[3]*v.x+m[4]*v.y+m[5]*v.z,z:m[6]*v.x+m[7]*v.y+m[8]*v.z};
}
function rotateTensor(t:PhysicsMatrix3,r:PhysicsMatrix3):PhysicsMatrix3 {
  const result=matrix();
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)for(let k=0;k<3;k++)for(let l=0;l<3;l++)result[i*3+j]+=r[i*3+k]*t[k*3+l]*r[j*3+l];
  return result;
}
function parallel(t:PhysicsMatrix3,offset:PhysicsVector,mass:number):void {
  const a=components(offset),squared=dot(offset,offset);
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)t[i*3+j]+=mass*((i===j?squared:0)-a[i]*a[j]);
}
const shapeCache=new WeakMap<PhysicsShape,SolidProperties>();
/** Unit-density shape tensor. Convex integration uses tetrahedra around an
 * interior reference, avoiding cancellation for an off-center hull. */
function shapeProperties(shape:PhysicsShape):SolidProperties {
  const cached=shapeCache.get(shape);if(cached)return cached;
  const volume=physicsShapeVolume(shape);
  if(!Number.isFinite(volume)||volume<=0)throw new Error('Invalid mass properties solid volume');
  let center=zero(),inertia=matrix();
  if(shape.kind==='box'){
    const h=shape.halfExtents;
    if(!validVector(h)||components(h).some(n=>n<=0))throw new Error('Invalid mass properties box');
    inertia=[volume*(h.y*h.y+h.z*h.z)/3,0,0,0,volume*(h.x*h.x+h.z*h.z)/3,0,0,0,volume*(h.x*h.x+h.y*h.y)/3];
  }else if(shape.kind==='ball'||shape.kind==='capsule'){
    const r=shape.radius,h=shape.kind==='capsule'?shape.halfHeight:0;
    if(!Number.isFinite(r)||r<=0||!Number.isFinite(h)||h<0)throw new Error('Invalid mass properties curved solid');
    const sphere=4*Math.PI*r**3/3,cylinder=2*h*Math.PI*r*r;
    const axial=.4*sphere*r*r+.5*cylinder*r*r;
    // Each hemisphere's first moment adds 3hr/4 to the combined cap inertia.
    const transverse=sphere*(.4*r*r+.75*h*r+h*h)+cylinder*(3*r*r+4*h*h)/12;
    inertia=[transverse,0,0,0,axial,0,0,0,transverse];
  }else{
    const points=shape.vertices,origin=scale(points.reduce(add,zero()),1/points.length),first=zero(),second=matrix();
    let measuredVolume=0;
    for(const face of physicsConvexFaces(shape)){
      const vertices=[zero(),...face.map(i=>sub(points[i],origin))],a=vertices[1],b=vertices[2],c=vertices[3];
      const v=Math.abs(dot(a,cross(b,c)))/6,sum=vertices.reduce(add,zero()),s=components(sum);
      measuredVolume+=v;first.x+=v*sum.x/4;first.y+=v*sum.y/4;first.z+=v*sum.z/4;
      for(let i=0;i<3;i++)for(let j=0;j<3;j++)second[i*3+j]+=v/20*(s[i]*s[j]+vertices.reduce((n,p)=>n+components(p)[i]*components(p)[j],0));
    }
    const localCenter=scale(first,1/measuredVolume),c=components(localCenter);
    for(let i=0;i<3;i++)for(let j=0;j<3;j++)second[i*3+j]-=measuredVolume*c[i]*c[j];
    const trace=second[0]+second[4]+second[8];
    for(let i=0;i<3;i++)for(let j=0;j<3;j++)inertia[i*3+j]=((i===j?trace:0)-second[i*3+j])*volume/measuredVolume;
    center=add(origin,localCenter);
  }
  const result={volume,center,inertia};shapeCache.set(shape,result);return result;
}
function inverse(t:PhysicsMatrix3):PhysicsMatrix3 {
  const normalizer=Math.max(...t.map(Math.abs)),a=t.map(v=>v/normalizer);
  const cofactors:PhysicsMatrix3=[a[4]*a[8]-a[5]*a[7],a[2]*a[7]-a[1]*a[8],a[1]*a[5]-a[2]*a[4],
    a[5]*a[6]-a[3]*a[8],a[0]*a[8]-a[2]*a[6],a[2]*a[3]-a[0]*a[5],
    a[3]*a[7]-a[4]*a[6],a[1]*a[6]-a[0]*a[7],a[0]*a[4]-a[1]*a[3]];
  const determinant=a[0]*cofactors[0]+a[1]*cofactors[3]+a[2]*cofactors[6];
  if(!Number.isFinite(determinant)||determinant<=0||normalizer<=0)throw new Error('Invalid mass properties inertia');
  const result=cofactors.map(v=>v/determinant/normalizer) as PhysicsMatrix3;
  if(result.some(n=>!Number.isFinite(n)))throw new Error('Invalid mass properties inverse inertia');
  return result;
}
export function physicsBodyMassProperties(body:PhysicsCompoundBody):PhysicsBodyMassProperties {
  if(!body||!validVector(body.position)||!Array.isArray(body.colliders)||!body.colliders.length||body.colliders.length>32)throw new Error('Invalid mass properties body');
  const parts=body.colliders.map(c=>{
    if(!validVector(c.position))throw new Error('Invalid mass properties collider');
    const solid=shapeProperties(c.shape),r=rotation(c.rotation);
    return{solid,center:add(c.position,apply(r,solid.center)),inertia:rotateTensor(solid.inertia,r)};
  });
  const volume=parts.reduce((n,p)=>n+p.solid.volume,0),mass=body.mass??volume;
  if(!Number.isFinite(mass)||mass<.000001||mass>1e7)throw new Error('Invalid mass properties body mass');
  const localCenter=scale(parts.reduce((p,part)=>add(p,scale(part.center,part.solid.volume)),zero()),1/volume),inertia=matrix();
  for(const p of parts){
    for(let i=0;i<9;i++)inertia[i]+=p.inertia[i]*mass/volume;
    parallel(inertia,sub(p.center,localCenter),mass*p.solid.volume/volume);
  }
  const r=rotation(body.rotation),worldInertia=rotateTensor(inertia,r);
  return{mass,center:add(body.position,apply(r,localCenter)),inertia:worldInertia,inverseInertia:inverse(worldInertia)};
}
/** Convert a world angular impulse about the body's mass center to delta omega. */
export function physicsApplyInverseInertia(properties:Pick<PhysicsBodyMassProperties,'inverseInertia'>,torque:PhysicsVector):PhysicsVector {
  return apply(properties.inverseInertia,torque);
}
