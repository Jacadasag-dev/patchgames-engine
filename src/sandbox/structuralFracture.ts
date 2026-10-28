/** Optional preparation shared by procedural buildings and custom assets.
 * Only authored support relationships are expanded; visual contact never
 * creates a new structural relationship. All geometry remains plain data. */
import { compileStructure, DESTRUCTION_LIMITS, structuralDeformationPanel, type StructuralManifest, type StructuralMember, type StructuralBond } from './destruction.ts';
import { compileFractureSlab, type FractureSlab } from './fracture.ts';
import { physicsConvexFaces } from './physicsGeometry.ts';
import type { PhysicsCollider, PhysicsRotation, PhysicsVector } from './physics.ts';

export interface StructuralFractureRule {
  memberId: string;
  cells: number;
  seed: number | string;
  /** Newtons per generated cohesive connection, not a material pressure. */
  cohesionCapacity: number;
  cohesionDurability?: number;
  maxSupportDistance?: number;
  /** Maximum gap between connected solids, in metres; defaults to .05.
   * Applies only when expanding an already authored bond. */
  bearingDistance?: number;
}
export interface PreparedStructuralFractures {
  structure: StructuralManifest;
  sourceStructure: StructuralManifest;
  fractures: { sourceMemberId: string; sourcePartIds: string[]; sourceSurfaceIds: string[]; sourceLightIds: string[]; slab: FractureSlab }[];
  sourceToMembers: Record<string, string[]>;
  counts: { members: number; bonds: number; colliders: number; fracturedMembers: number; rigidMembers: number };
}
const round=(n:number)=>Number(n.toPrecision(12));
const add=(a:PhysicsVector,b:PhysicsVector):PhysicsVector=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
const sub=(a:PhysicsVector,b:PhysicsVector):PhysicsVector=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const scale=(a:PhysicsVector,n:number):PhysicsVector=>({x:a.x*n,y:a.y*n,z:a.z*n});
const dot=(a:PhysicsVector,b:PhysicsVector)=>a.x*b.x+a.y*b.y+a.z*b.z;
const cross=(a:PhysicsVector,b:PhysicsVector):PhysicsVector=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
const length=(v:PhysicsVector)=>Math.hypot(v.x,v.y,v.z);
function rotate(v:PhysicsVector,q?:PhysicsRotation):PhysicsVector {
  if(!q)return {...v}; const t=scale(cross(q,v),2);return add(v,add(scale(t,q.w),cross(q,t)));
}
function freeze<T>(value:T):T {
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;
}
function fields(value:unknown,allowed:string[],label:string):asserts value is Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))
    ||Object.keys(value).some(key=>!allowed.includes(key)))throw new Error(`${label} requires supported plain fields.`);
}
function number(value:unknown,name:string,min:number,max=1e12):asserts value is number {
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new Error(`Invalid fracture ${name}; expected ${min}..${max}.`);
}
function hash(value:string):string {
  let a=2166136261,b=2246822507;for(let i=0;i<value.length;i++){a=Math.imul(a^value.charCodeAt(i),16777619);b=Math.imul(b^value.charCodeAt(i),3266489909);}
  return (a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');
}
/** Canonical shares preserve the authored total, including the final residue. */
function shares(total:number,weights:number[]):number[] {
  const sum=weights.reduce((a,b)=>a+b,0),values=weights.map(weight=>round(total*weight/sum));
  values[values.length-1]=total-values.slice(0,-1).reduce((a,b)=>a+b,0);return values;
}

type Hull={points:PhysicsVector[];faces:[number,number,number][];edges:[number,number][]};
type Solid={hull:Hull}|{a:PhysicsVector;b:PhysicsVector;radius:number};
function solid(collider:PhysicsCollider):Solid {
  const shape=collider.shape,world=(p:PhysicsVector)=>add(collider.position,rotate(p,collider.rotation));
  if(shape.kind==='ball'||shape.kind==='capsule'){
    const half=shape.kind==='capsule'?shape.halfHeight:0;
    return {a:world({x:0,y:-half,z:0}),b:world({x:0,y:half,z:0}),radius:shape.radius};
  }
  const vertices=shape.kind==='convex'?shape.vertices:Array.from({length:8},(_,i)=>({x:(i&1?1:-1)*shape.halfExtents.x,
    y:(i&2?1:-1)*shape.halfExtents.y,z:(i&4?1:-1)*shape.halfExtents.z}));
  const faces=physicsConvexFaces({kind:'convex',vertices}),edges=new Map<string,[number,number]>();
  for(const f of faces)for(let i=0;i<3;i++){const pair=[f[i],f[(i+1)%3]].sort((a,b)=>a-b) as [number,number];edges.set(pair.join(':'),pair);}
  return {hull:{points:vertices.map(world),faces,edges:[...edges.values()]}};
}
function triangleDistance(p:PhysicsVector,a:PhysicsVector,b:PhysicsVector,c:PhysicsVector):number {
  const ab=sub(b,a),ac=sub(c,a),ap=sub(p,a),d1=dot(ab,ap),d2=dot(ac,ap);if(d1<=0&&d2<=0)return length(ap);
  const bp=sub(p,b),d3=dot(ab,bp),d4=dot(ac,bp);if(d3>=0&&d4<=d3)return length(bp);
  const vc=d1*d4-d3*d2;if(vc<=0&&d1>=0&&d3<=0)return length(sub(p,add(a,scale(ab,d1/(d1-d3)))));
  const cp=sub(p,c),d5=dot(ab,cp),d6=dot(ac,cp);if(d6>=0&&d5<=d6)return length(cp);
  const vb=d5*d2-d1*d6;if(vb<=0&&d2>=0&&d6<=0)return length(sub(p,add(a,scale(ac,d2/(d2-d6)))));
  const va=d3*d6-d5*d4;if(va<=0&&d4-d3>=0&&d5-d6>=0)return length(sub(p,add(b,scale(sub(c,b),(d4-d3)/(d4-d3+d5-d6)))));
  const sum=va+vb+vc;return Math.abs(sum)<1e-24?Math.min(length(ap),length(bp),length(cp)):length(sub(p,add(a,add(scale(ab,vb/sum),scale(ac,vc/sum)))));
}
function segmentDistance(a:PhysicsVector,b:PhysicsVector,c:PhysicsVector,d:PhysicsVector):number {
  const u=sub(b,a),v=sub(d,c),r=sub(a,c),uu=dot(u,u),vv=dot(v,v),uv=dot(u,v),ur=dot(u,r),vr=dot(v,r);
  const clamp=(n:number)=>Math.max(0,Math.min(1,n));let s=0,t=0;
  if(uu<=1e-24)t=vv<=1e-24?0:clamp(vr/vv);
  else if(vv<=1e-24)s=clamp(-ur/uu);
  else{const den=uu*vv-uv*uv;s=den>1e-24?clamp((uv*vr-ur*vv)/den):0;t=(uv*s+vr)/vv;
    if(t<0){t=0;s=clamp(-ur/uu);}else if(t>1){t=1;s=clamp((uv-ur)/uu);}}
  return length(sub(add(a,scale(u,s)),add(c,scale(v,t))));
}
function segmentHull(a:PhysicsVector,b:PhysicsVector,hull:Hull):number {
  let lo=0,hi=1,distance=Infinity;const direction=sub(b,a);
  for(const [ia,ib,ic] of hull.faces){const p=hull.points[ia],q=hull.points[ib],r=hull.points[ic],normal=cross(sub(q,p),sub(r,p));
    const start=dot(normal,sub(a,p)),delta=dot(normal,direction);
    if(Math.abs(delta)<1e-20){if(start>1e-9*length(normal))lo=Infinity;}
    else if(delta<0)lo=Math.max(lo,-start/delta);else hi=Math.min(hi,-start/delta);
    distance=Math.min(distance,triangleDistance(a,p,q,r),triangleDistance(b,p,q,r));}
  if(lo<=hi+1e-10&&hi>=0&&lo<=1)return 0;
  for(const [i,j] of hull.edges)distance=Math.min(distance,segmentDistance(a,b,hull.points[i],hull.points[j]));return distance;
}
/** Exact convex/primitive surface distance, including intersecting edges and
 * face interiors. This prevents a rotated envelope from inventing a bearing. */
function solidDistance(one:Solid,two:Solid):number {
  if(!('hull'in one)&&!('hull'in two))return Math.max(0,segmentDistance(one.a,one.b,two.a,two.b)-one.radius-two.radius);
  if(!('hull'in one)&&'hull'in two)return Math.max(0,segmentHull(one.a,one.b,two.hull)-one.radius);
  if('hull'in one&&!('hull'in two))return Math.max(0,segmentHull(two.a,two.b,one.hull)-two.radius);
  const a=(one as {hull:Hull}).hull,b=(two as {hull:Hull}).hull;let distance=Infinity;
  for(const [i,j] of a.edges){distance=Math.min(distance,segmentHull(a.points[i],a.points[j],b));if(distance<1e-9)return 0;}
  for(const [i,j] of b.edges){distance=Math.min(distance,segmentHull(b.points[i],b.points[j],a));if(distance<1e-9)return 0;}
  return distance;
}
function memberSolids(member:StructuralMember):Solid[] {
  return member.colliders.length?member.colliders.map(solid):[{a:member.position,b:member.position,radius:0}];
}

/** Replace selected solid members with convex cells and expand only existing
 * authored bonds at their actual bearings. No rules means ordinary rigid-member
 * destruction. Too-fine cells, absent bearings or unstable expansions fail
 * explicitly; this compiler never silently anchors cells or reduces detail. */
export function prepareStructuralFractures(base:StructuralManifest,rules:readonly StructuralFractureRule[]):PreparedStructuralFractures {
  if(!base||typeof base!=='object'||typeof base.revision!=='string')throw new Error('Fracture preparation requires a compiled source structure.');
  const sourceStructure=compileStructure(base);
  if(sourceStructure.revision!==base.revision)throw new Error('Fracture source structure differs from its compiled revision.');
  if(!Array.isArray(rules)||rules.length>DESTRUCTION_LIMITS.members)throw new Error('Fracture rules exceed the 64-member budget.');
  const originals=new Map(sourceStructure.members.map(m=>[m.id,m])),selected=new Map<string,StructuralFractureRule>();
  for(const rule of rules){
    fields(rule,['memberId','cells','seed','cohesionCapacity','cohesionDurability','maxSupportDistance','bearingDistance'],'Structural fracture rule');
    if(typeof rule.memberId!=='string'||!originals.has(rule.memberId)||selected.has(rule.memberId))throw new Error('Fracture member must be known and selected only once.');
    number(rule.cells,'cell count',2,48);if(!Number.isInteger(rule.cells))throw new Error('Fracture cell count must be an integer.');
    if(typeof rule.seed==='number')number(rule.seed,'seed',-Number.MAX_VALUE,Number.MAX_VALUE);
    else if(typeof rule.seed!=='string'||rule.seed.length>256)throw new Error('Fracture seed must be a finite number or short string.');
    number(rule.cohesionCapacity,'cohesion capacity',.001);
    if(rule.cohesionDurability!==undefined)number(rule.cohesionDurability,'cohesion durability',.001);
    if(rule.maxSupportDistance!==undefined)number(rule.maxSupportDistance,'maximum support distance',0,10000);
    if(rule.bearingDistance!==undefined)number(rule.bearingDistance,'bearing distance',0,10000);
    const member=originals.get(rule.memberId)!;
    if(member.anchor)throw new Error(`Cannot fracture anchored member ${member.id}; retain a rigid foundation/root and fracture its supported members.`);
    if(member.deformation)throw new Error(`Member ${member.id} cannot be both a ductile panel and prefractured cells.`);
    if(member.colliders.length!==1||member.colliders[0].shape.kind!=='box'||(member.partIds?.length??0)>1)
      throw new Error(`Fracture member ${member.id} requires one exact box collider and at most one source part; keep compounds and other shapes rigid.`);
    selected.set(rule.memberId,rule as unknown as StructuralFractureRule);
  }
  const expandedCount=sourceStructure.members.length+[...selected.values()].reduce((sum,rule)=>sum+rule.cells-1,0);
  if(expandedCount>DESTRUCTION_LIMITS.members)throw new Error(`Prepared fracture needs ${expandedCount} members; limit is 64. Use fewer cells or separately authored structures.`);
  const expandedColliders=sourceStructure.members.reduce((sum,member)=>sum+member.colliders.length,0)
    +[...selected.values()].reduce((sum,rule)=>sum+rule.cells-1,0);
  if(expandedColliders>DESTRUCTION_LIMITS.colliders)throw new Error(`Prepared fracture needs ${expandedColliders} colliders; limit is 256. Use fewer cells or separately authored structures.`);
  const members:StructuralMember[]=[],bonds:StructuralBond[]=[],fractures:PreparedStructuralFractures['fractures']=[],sourceToMembers:Record<string,string[]>={};
  for(const source of sourceStructure.members){
    const rule=selected.get(source.id);if(!rule){members.push(source);sourceToMembers[source.id]=[source.id];continue;}
    const collider=source.colliders[0],box=collider.shape as Extract<PhysicsCollider['shape'],{kind:'box'}>;
    const raw=compileFractureSlab({id:`fracture:${hash(source.id)}`,seed:rule.seed,position:collider.position,rotation:collider.rotation,
      size:scale(box.halfExtents,2),cells:rule.cells,density:1});
    const weights=raw.cells.map(cell=>cell.volume),masses=shares(source.mass,weights),strengths=shares(source.strength,weights),durabilities=shares(source.durability??source.strength,weights);
    const slab:FractureSlab={...raw,cells:raw.cells.map((cell,index)=>({...cell,mass:masses[index],strength:strengths[index],durability:durabilities[index],
      collider:{...cell.collider,...(collider.friction===undefined?{}:{friction:collider.friction}),...(collider.restitution===undefined?{}:{restitution:collider.restitution})}}))};
    for(const cell of slab.cells){
      if(cell.mass<.01||cell.strength<.001||cell.durability<.001)throw new Error(`Fracture cells for ${source.id} fall below structural mass/strength/durability limits. Use fewer cells or revise the authored material.`);
      members.push({id:cell.id,mass:cell.mass,strength:cell.strength,durability:cell.durability,position:cell.position,colliders:[cell.collider],
        ...((rule.maxSupportDistance??source.maxSupportDistance)===undefined?{}:{maxSupportDistance:rule.maxSupportDistance??source.maxSupportDistance})});
    }
    for(const join of slab.adjacency)bonds.push({id:join.id,from:join.from,to:join.to,kind:'cohesive',capacity:rule.cohesionCapacity,
      ...(rule.cohesionDurability===undefined?{}:{durability:rule.cohesionDurability})});
    sourceToMembers[source.id]=slab.cells.map(cell=>cell.id);
    fractures.push({sourceMemberId:source.id,sourcePartIds:[...(source.partIds??[])],sourceSurfaceIds:[...(source.surfaceIds??[])],sourceLightIds:[...(source.lightIds??[])],slab});
  }
  if(new Set(members.map(m=>m.id)).size!==members.length)throw new Error('Generated fracture member ID conflicts with an authored member.');
  const solids=new Map(members.map(member=>[member.id,memberSolids(member)]));
  for(const bond of sourceStructure.bonds){
    if(!selected.has(bond.from)&&!selected.has(bond.to)){bonds.push(bond);continue;}
    const tolerance=Math.min(selected.get(bond.from)?.bearingDistance??Infinity,selected.get(bond.to)?.bearingDistance??Infinity);
    const limit=Number.isFinite(tolerance)?tolerance:.05,connections:{from:string;to:string}[]=[];let nearest=Infinity;
    for(const from of sourceToMembers[bond.from])for(const to of sourceToMembers[bond.to]){
      const gap=round(Math.min(...solids.get(from)!.flatMap(a=>solids.get(to)!.map(b=>solidDistance(a,b)))));nearest=Math.min(nearest,gap);
      if(gap<=limit+1e-8)connections.push({from,to});
    }
    if(!connections.length)throw new Error(`Authored bond ${bond.id} has no fracture bearing within ${limit}m (nearest ${nearest}m). Move the support or explicitly increase bearingDistance.`);
    const capacities=shares(bond.capacity,connections.map(()=>1)),durabilities=shares(bond.durability??bond.capacity,connections.map(()=>1));
    const outgoing=new Map<string,number>();for(const link of connections)outgoing.set(link.from,(outgoing.get(link.from)??0)+1);
    connections.forEach((link,index)=>{
      const weight=round((bond.weight??1)/outgoing.get(link.from)!);
      if(capacities[index]<.001||durabilities[index]<.001||weight<.001)throw new Error(`Expanded bond ${bond.id} falls below structural capacity/durability/weight limits. Use fewer cells or revise the authored connection.`);
      bonds.push({id:`fracture-link:${hash(bond.id)}:${index}`,...link,capacity:capacities[index],durability:durabilities[index],weight,...(bond.kind?{kind:bond.kind}:{})});
    });
    if(bonds.length>DESTRUCTION_LIMITS.bonds)throw new Error(`Prepared fracture exceeds the 256-bond budget. Use fewer cells or fewer authored bearings.`);
  }
  const colliders=members.reduce((sum,member)=>sum+(structuralDeformationPanel(member)?.triangles.length??member.colliders.length),0);
  if(bonds.length>DESTRUCTION_LIMITS.bonds||colliders>DESTRUCTION_LIMITS.colliders)throw new Error(`Prepared fracture exceeds the 256-bond/collider budget (${bonds.length} bonds, ${colliders} colliders). Use fewer cells.`);
  // The core also checks aggregate load paths and the 32-collider member bound.
  const structure=compileStructure({id:sourceStructure.id,version:sourceStructure.version,gravity:sourceStructure.gravity,members,bonds});
  return freeze({structure,sourceStructure,fractures,sourceToMembers,counts:{members:structure.members.length,bonds:structure.bonds.length,colliders,
    fracturedMembers:fractures.length,rigidMembers:sourceStructure.members.length-fractures.length}});
}
