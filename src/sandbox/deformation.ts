/** Bounded elastic/plastic sheet model. Only displacement normal to an authored
 * thin box is solved; this is not a general volumetric soft-body solver. The
 * exact same piecewise-linear surface supplies rendering and native collision. */
import type { PhysicsCollider, PhysicsRotation, PhysicsVector } from './physics.ts';

export type DeformationEdge = 'left' | 'right' | 'top' | 'bottom';
export interface DeformationConfiguration {
  segments?: 2 | 3 | 4;
  /** Spring stiffness per node in N/m. */ stiffness?: number;
  /** Viscous damping per node in Ns/m. */ damping?: number;
  /** Recoverable displacement before permanent set, in metres. */ yieldDisplacement?: number;
  /** Fraction of excess displacement retained per solve (0 is purely elastic). */ plasticity?: number;
  maxDeflection?: number;
  /** Normal impulse in one accepted tick which tears the panel off its supports. */ ruptureImpulse?: number;
  pinnedEdges?: DeformationEdge[];
}
export const DEFORMATION_LIMITS = Object.freeze({ panels: 8, nodes: 25, segments: 4, contacts: 512, substeps: 32 });
export const DEFORMATION_DEFAULTS = Object.freeze({ segments: 3 as const, stiffness: 18000, damping: 80,
  yieldDisplacement: .035, plasticity: .9, maxDeflection: 1.2, ruptureImpulse: 6000,
  pinnedEdges: Object.freeze(['left', 'right', 'top', 'bottom'] as DeformationEdge[]) });
export interface DeformationPanel {
  configuration: Required<DeformationConfiguration>;
  collider: PhysicsCollider;
  normalAxis: 'x' | 'y' | 'z'; uAxis: 'x' | 'y' | 'z'; vAxis: 'x' | 'y' | 'z';
  points: PhysicsVector[]; pinned: boolean[]; triangles: [number, number, number][];
}
export interface DeformationState { offsets: number[]; velocities: number[]; plasticOffsets: number[]; ruptured: boolean }
export interface DeformationContact { point: PhysicsVector; impulse: PhysicsVector; radius?: number }
const axes = ['x', 'y', 'z'] as const;
function bounded(n: number, name: string, low: number, high: number): void {
  if (!Number.isFinite(n) || n < low || n > high) throw new Error(`Invalid deformation ${name}`);
}
const add = (a: PhysicsVector, b: PhysicsVector): PhysicsVector => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: PhysicsVector, b: PhysicsVector): PhysicsVector => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: PhysicsVector, b: PhysicsVector): PhysicsVector => ({ x: a.y*b.z-a.z*b.y, y: a.z*b.x-a.x*b.z, z: a.x*b.y-a.y*b.x });
const scale = (v: PhysicsVector, n: number): PhysicsVector => ({ x: v.x*n, y: v.y*n, z: v.z*n });
export function deformationRotate(v: PhysicsVector, q?: PhysicsRotation, inverse = false): PhysicsVector {
  if (!q) return { ...v };
  const xyz = scale(q, inverse ? -1 : 1), t = scale(cross(xyz, v), 2);
  return add(v, add(scale(t, q.w), cross(xyz, t)));
}
function freeze<T>(v: T): T { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
export function compileDeformationPanel(collider: PhysicsCollider, input: DeformationConfiguration = {}): DeformationPanel {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(DEFORMATION_DEFAULTS, key)))
    throw new Error('Deformation requires supported configuration fields');
  if (collider.shape.kind !== 'box') throw new Error('Deformation requires one thin box collider');
  const cfg = { ...DEFORMATION_DEFAULTS, ...input, pinnedEdges: [...(input.pinnedEdges ?? DEFORMATION_DEFAULTS.pinnedEdges)] };
  if (![2,3,4].includes(cfg.segments)) throw new Error('Deformation segments must be 2, 3 or 4');
  bounded(cfg.stiffness, 'stiffness', 1, 1e6); bounded(cfg.damping, 'damping', 0, 1e5);
  bounded(cfg.yieldDisplacement, 'yield displacement', .0001, 10); bounded(cfg.plasticity, 'plasticity', 0, 1);
  bounded(cfg.maxDeflection, 'max deflection', cfg.yieldDisplacement, 20); bounded(cfg.ruptureImpulse, 'rupture impulse', .001, 1e10);
  if (!cfg.pinnedEdges.length || cfg.pinnedEdges.length > 4 || new Set(cfg.pinnedEdges).size !== cfg.pinnedEdges.length || cfg.pinnedEdges.some(e => !['left','right','top','bottom'].includes(e)))
    throw new Error('Deformation requires one to four distinct pinned edges');
  const half = collider.shape.halfExtents;
  for (const axis of axes) { bounded(half[axis], 'dimension', .02, 100); bounded(collider.position[axis], 'position', -10000, 10000); }
  if (collider.rotation && (!Object.values(collider.rotation).every(Number.isFinite) || Math.abs(Math.hypot(collider.rotation.x, collider.rotation.y, collider.rotation.z, collider.rotation.w)-1) > .001))
    throw new Error('Deformation requires a finite unit rotation');
  const normalAxis = [...axes].sort((a,b) => half[a]-half[b])[0];
  // Cyclic axes make u cross v point along the positive normal.
  const uAxis = normalAxis === 'x' ? 'y' : normalAxis === 'y' ? 'z' : 'x';
  const vAxis = normalAxis === 'x' ? 'z' : normalAxis === 'y' ? 'x' : 'y';
  if (half[normalAxis] > Math.min(half[uAxis], half[vAxis]) / 4) throw new Error('Deformation requires a thin panel, not a solid volume');
  const points: PhysicsVector[] = [], pinned: boolean[] = [], triangles: [number,number,number][] = [], n = cfg.segments;
  for (let v=0; v<=n; v++) for (let u=0; u<=n; u++) {
    const p = {x:0,y:0,z:0}; p[uAxis] = half[uAxis]*(2*u/n-1); p[vAxis] = half[vAxis]*(2*v/n-1); points.push(p);
    pinned.push(u===0 && cfg.pinnedEdges.includes('left') || u===n && cfg.pinnedEdges.includes('right') || v===0 && cfg.pinnedEdges.includes('bottom') || v===n && cfg.pinnedEdges.includes('top'));
    if(u<n && v<n) { const a=v*(n+1)+u, b=a+1, c=a+n+1, d=c+1; triangles.push([a,b,d],[a,d,c]); }
  }
  return freeze({ configuration: cfg, collider: JSON.parse(JSON.stringify(collider)), normalAxis, uAxis, vAxis, points, pinned, triangles });
}
export function createDeformationState(panel: DeformationPanel): DeformationState {
  return freeze({ offsets: panel.points.map(()=>0), velocities: panel.points.map(()=>0), plasticOffsets: panel.points.map(()=>0), ruptured:false });
}
export function validateDeformationState(panel: DeformationPanel, state: DeformationState): void {
  if (!state || typeof state.ruptured !== 'boolean') throw new Error('Invalid deformation state');
  for (const key of ['offsets','velocities','plasticOffsets'] as const) {
    const values = state[key]; if (!Array.isArray(values) || values.length !== panel.points.length) throw new Error('Deformation state has incorrect node count');
    values.forEach((v,i) => { bounded(v,key,key==='velocities'?-500:-panel.configuration.maxDeflection,key==='velocities'?500:panel.configuration.maxDeflection);
      if(panel.pinned[i] && v!==0) throw new Error('Pinned deformation nodes cannot move'); });
  }
}
export function deformationPoints(panel: DeformationPanel, state: DeformationState): PhysicsVector[] {
  validateDeformationState(panel,state);
  return panel.points.map((p,i)=>({ ...p, [panel.normalAxis]:state.offsets[i] }));
}
export function deformationColliders(panel: DeformationPanel, state: DeformationState): PhysicsCollider[] {
  const points=deformationPoints(panel,state), normal=panel.normalAxis;
  const half=panel.collider.shape.kind==='box' ? panel.collider.shape.halfExtents[normal] : 0;
  const {id:sourceId,...source}=panel.collider;
  return panel.triangles.map((triangle,index)=>({ ...source,...(sourceId?{id:`${sourceId.slice(0,108)}:deformation:${index}`}:{ }),
    shape:{kind:'convex',vertices:triangle.flatMap(i=>[-1,1].map(sign=>({...points[i],[normal]:points[i][normal]+sign*half})))} }));
}
/** Immutable/replay-safe update. Contacts are already accepted native impulses,
 * not forces to be multiplied by dt. Gravity is resolved along the panel normal.
 * Ruptured panels retain their shape and subsequently move as rigid debris. */
export function stepDeformation(panel: DeformationPanel, state: DeformationState, options: {
  mass: number; dt: number; contacts?: readonly DeformationContact[]; gravity?: PhysicsVector;
}): DeformationState {
  validateDeformationState(panel,state); bounded(options.mass,'mass',.01,1e7); bounded(options.dt,'time step',Number.EPSILON,.25);
  const contacts=options.contacts??[]; if(!Array.isArray(contacts)||contacts.length>DEFORMATION_LIMITS.contacts)throw new Error('Deformation contact budget exceeded');
  const gravity=options.gravity??{x:0,y:-9.81,z:0}; for(const axis of axes)bounded(gravity[axis],'gravity',-10000,10000);
  if(state.ruptured)return state;
  const offsets=[...state.offsets],velocities=[...state.velocities],plasticOffsets=[...state.plasticOffsets];
  const cfg=panel.configuration,n=cfg.segments,nodeMass=options.mass/panel.points.length;
  let normalImpulse=0;
  for(const contact of contacts){
    for(const value of [contact.point,contact.impulse])for(const axis of axes)bounded(value[axis],'contact',-1e10,1e10);
    const p=deformationRotate(sub(contact.point,panel.collider.position),panel.collider.rotation,true);
    const impulse=deformationRotate(contact.impulse,panel.collider.rotation,true)[panel.normalAxis]; normalImpulse+=Math.abs(impulse);
    const half=panel.collider.shape.kind==='box'?panel.collider.shape.halfExtents:{x:1,y:1,z:1};
    const radius=contact.radius??Math.max(half[panel.uAxis],half[panel.vAxis])*2/n; bounded(radius,'contact radius',.001,1000);
    const weights=panel.points.map((point,i)=>panel.pinned[i]?0:Math.max(0,1-Math.hypot(point[panel.uAxis]-p[panel.uAxis],point[panel.vAxis]-p[panel.vAxis])/radius));
    const sum=weights.reduce((a,b)=>a+b,0);
    if(sum>0)for(let i=0;i<weights.length;i++)velocities[i]=Math.max(-500,Math.min(500,velocities[i]+impulse*weights[i]/sum/nodeMass));
  }
  const g=deformationRotate(gravity,panel.collider.rotation,true)[panel.normalAxis];
  const substeps=Math.min(DEFORMATION_LIMITS.substeps,Math.max(1,Math.ceil(options.dt*120))),h=options.dt/substeps;
  for(let step=0;step<substeps;step++){
    const old=[...offsets],oldVelocity=[...velocities],bending=.35;
    // Four fixed Jacobi iterations of the implicit spring system keep high
    // stiffness/low mass inputs bounded without an unbounded stability loop.
    for(let iteration=0;iteration<4;iteration++){
      const previous=[...velocities];
      for(let i=0;i<offsets.length;i++)if(!panel.pinned[i]){
        const u=i%(n+1),v=Math.floor(i/(n+1));const neighbors=[u?i-1:-1,u<n?i+1:-1,v?i-n-1:-1,v<n?i+n+1:-1].filter(j=>j>=0);
        const strain=old[i]-plasticOffsets[i];
        const bend=neighbors.reduce((sum,j)=>sum+strain-(old[j]-plasticOffsets[j]),0);
        const neighborV=neighbors.reduce((sum,j)=>sum+previous[j],0);
        const numerator=nodeMass*oldVelocity[i]+h*(nodeMass*g-cfg.stiffness*(strain+bending*bend))+h*h*cfg.stiffness*bending*neighborV;
        velocities[i]=Math.max(-500,Math.min(500,numerator/(nodeMass+h*cfg.damping+h*h*cfg.stiffness*(1+bending*neighbors.length))));
      }
    }
    for(let i=0;i<offsets.length;i++)if(!panel.pinned[i]){
      offsets[i]=Math.max(-cfg.maxDeflection,Math.min(cfg.maxDeflection,old[i]+h*velocities[i]));
      if(Math.abs(offsets[i])===cfg.maxDeflection)velocities[i]=0;
      const strain=offsets[i]-plasticOffsets[i],excess=Math.max(0,Math.abs(strain)-cfg.yieldDisplacement);
      plasticOffsets[i]+=Math.sign(strain)*excess*cfg.plasticity;
      if(Math.abs(velocities[i])<1e-10)velocities[i]=0;
    }
  }
  return freeze({offsets,velocities,plasticOffsets,ruptured:normalImpulse>=cfg.ruptureImpulse});
}
