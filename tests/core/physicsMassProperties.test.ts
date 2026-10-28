import {describe,expect,it} from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import {beforeRuntimeInitialization} from '../runtimeInitialization.ts';
import {loadPhysics} from '../../src/sandbox/host/physics.ts';
import {physicsBodyMassProperties,physicsApplyInverseInertia} from '../../src/sandbox/physicsMassProperties.ts';
import {physicsShapeVolume} from '../../src/sandbox/physicsGeometry.ts';
import type {PhysicsCompoundBody,PhysicsShape,PhysicsVector} from '../../src/sandbox/physics.ts';

beforeRuntimeInitialization(loadPhysics);
const zero={x:0,y:0,z:0};
const shapeBody=(shape:PhysicsShape,mass=12):PhysicsCompoundBody=>({id:'body',position:{x:3,y:4,z:5},velocity:zero,mass,
  colliders:[{id:'shape',position:zero,shape}]});
const vectorClose=(a:PhysicsVector,b:PhysicsVector,digits=7)=>{for(const axis of ['x','y','z'] as const)expect(a[axis]).toBeCloseTo(b[axis],digits);};
describe('compound solid mass properties',()=>{
  it('uses the analytic box moments and rotates its full tensor into world space',()=>{
    const body=shapeBody({kind:'box',halfExtents:{x:1,y:2,z:3}}),snapshot=JSON.stringify(body);
    const result=physicsBodyMassProperties(body);
    expect(result.center).toEqual(body.position);expect(result.inertia).toEqual([52,0,0,0,40,0,0,0,20]);
    vectorClose(physicsApplyInverseInertia(result,{x:52,y:40,z:20}),{x:1,y:1,z:1});
    body.rotation={x:0,y:0,z:Math.sin(Math.PI/8),w:Math.cos(Math.PI/8)};
    const rotated=physicsBodyMassProperties(body);
    expect(rotated.inertia[0]).toBeCloseTo(46);expect(rotated.inertia[1]).toBeCloseTo(6);expect(rotated.inertia[4]).toBeCloseTo(46);
    expect(JSON.stringify({...body,rotation:undefined})).toBe(snapshot);
  });
  it('computes the real center and parallel-axis moments of separated unequal children',()=>{
    const body=shapeBody({kind:'ball',radius:1},9);
    body.colliders=[{id:'small',position:{x:-4,y:0,z:0},shape:{kind:'ball',radius:1}},
      {id:'large',position:{x:2,y:0,z:0},shape:{kind:'ball',radius:2}}];
    const result=physicsBodyMassProperties(body);
    expect(result.center.x).toBeCloseTo(3+4/3);expect(result.inertia[0]).toBeCloseTo(.4+8*1.6);
    expect(result.inertia[4]).toBeCloseTo(13.2+32);expect(result.inertia[8]).toBeCloseTo(45.2);
    body.rotation={x:0,y:0,z:Math.SQRT1_2,w:Math.SQRT1_2};
    const turned=physicsBodyMassProperties(body);vectorClose(turned.center,{x:3,y:4+4/3,z:5});
    expect(turned.inertia[0]).toBeCloseTo(45.2);expect(turned.inertia[4]).toBeCloseTo(13.2);
  });
  it('integrates off-center convex hulls without substituting their bounding box',()=>{
    const body=shapeBody({kind:'convex',vertices:[{x:10,y:20,z:30},{x:12,y:20,z:30},{x:10,y:24,z:30},{x:10,y:20,z:36}]},8);
    const result=physicsBodyMassProperties(body);vectorClose(result.center,{x:13.5,y:25,z:36.5});
    expect(result.inertia[0]).toBeCloseTo(8*3*(4*4+6*6)/80,8);
    expect(result.inertia[1]).toBeCloseTo(8*2*4/80,8);
    expect(result.inertia[2]).toBeCloseTo(8*2*6/80,8);
  });
  it.each<PhysicsShape>([
    {kind:'box',halfExtents:{x:.2,y:1.2,z:.4}},
    {kind:'ball',radius:.65},
    {kind:'capsule',radius:.3,halfHeight:.8},
    {kind:'convex',vertices:[{x:1,y:0,z:0},{x:2,y:0,z:0},{x:1,y:2,z:0},{x:1,y:0,z:3}]},
  ])('matches native COM and angular response for $kind with child and body rotation',shape=>{
    const body=shapeBody(shape,17);body.rotation={x:0,y:Math.sin(.3),z:0,w:Math.cos(.3)};
    body.colliders[0].position={x:1,y:-.2,z:.4};body.colliders[0].rotation={x:Math.sin(.2),y:0,z:0,w:Math.cos(.2)};
    body.colliders.push({id:'second',position:{x:-1,y:.7,z:.2},shape:{kind:'ball',radius:.2}});
    const actual=physicsBodyMassProperties(body),world=new RAPIER.World(zero);
    try{
      const native=world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(body.position.x,body.position.y,body.position.z).setRotation(body.rotation));
      const total=body.colliders.reduce((n,c)=>n+physicsShapeVolume(c.shape),0);
      for(const child of body.colliders){
        const s=child.shape;
        const desc=s.kind==='box'?RAPIER.ColliderDesc.cuboid(s.halfExtents.x,s.halfExtents.y,s.halfExtents.z):s.kind==='ball'?RAPIER.ColliderDesc.ball(s.radius)
          :s.kind==='capsule'?RAPIER.ColliderDesc.capsule(s.halfHeight,s.radius):RAPIER.ColliderDesc.convexHull(new Float32Array(s.vertices.flatMap(v=>[v.x,v.y,v.z])))!;
        desc.setTranslation(child.position.x,child.position.y,child.position.z).setMass(body.mass!*physicsShapeVolume(s)/total);
        if(child.rotation)desc.setRotation(child.rotation);
        world.createCollider(desc,native);
      }
      native.recomputeMassPropertiesFromColliders();
      vectorClose(actual.center,native.worldCom(),5);
      const torque={x:2,y:3,z:-5};native.applyTorqueImpulse(torque,true);
      vectorClose(physicsApplyInverseInertia(actual,torque),native.angvel(),4);
    }finally{world.free();}
  });
  it('uses native unit density when mass is omitted and rejects invalid data',()=>{
    const body=shapeBody({kind:'box',halfExtents:{x:.05,y:.05,z:.05}});delete body.mass;
    expect(physicsBodyMassProperties(body).mass).toBeCloseTo(.001,12);
    expect(()=>physicsBodyMassProperties({...body,mass:0})).toThrow(/mass/);
    expect(()=>physicsBodyMassProperties({...body,colliders:[]})).toThrow(/body/);
    expect(()=>physicsBodyMassProperties({...body,rotation:{x:0,y:0,z:0,w:2}})).toThrow(/rotation/);
  });
});
