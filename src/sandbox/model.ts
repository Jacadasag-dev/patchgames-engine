/** Declarative box/sphere models. Default exports in .model.ts files under src/game get automatic build inspection.
 * Coordinates are metres, +Y up, +Z forward. Angles use the rig's XYZ degrees.
 * These helpers are pure: share the same definition between logic, view and tests.
 */
import { composeRigTransforms, defineRig, IDENTITY, jointLocalTransform, type RigAngles, type RigPose, type RigTransform, type RigVector } from './rig.ts';

export type ModelFace = 'left' | 'right' | 'top' | 'bottom' | 'front' | 'back';
export interface ModelAttachment {
  part: string;
  face: ModelFace;
  /** fixed (default) is rigid. joint rotates around the attachment pivot near the child's
   * contacting face, offset by sink/gap/position; it permits overlap, not detachment. */
  mode?: 'fixed' | 'joint';
  /** Tangential alignment in the parent's frame: -1 matches child/parent low edges,
   * 0 centres the child, +1 matches high edges (not the child's centre to that edge).
   * Intermediate values interpolate: bottom-face {x:-.8,z:.8} selects an inset corner.
   * The face-normal axis is ignored. Placement follows parent/child dimensions. */
  align?: Partial<RigVector>;
  /** Metres of intentional overlap. Positive gap instead leaves space. */
  sink?: number;
  gap?: number;
}
export interface ModelPart {
  name: string;
  /** Defaults to box. Spheres use equal X/Y/Z diameters; ellipsoids are not supported. */
  shape?: 'box' | 'sphere';
  size: RigVector;
  /** Absolute centre for roots; additive parent-frame offset for attached parts. */
  position?: RigVector;
  /** Rest rotation in XYZ degrees. Animation composes after this rotation, not component-wise replacement. */
  rotate?: RigAngles;
  attach?: ModelAttachment;
  color?: number;
  /** Explicitly opt this part into derived collision bounds. Decorations default to false. */
  collision?: boolean;
  /** A reason is required for intentionally detached or buried geometry. */
  allowFloating?: string;
  allowBuried?: string;
}
export type ModelGround = 'required' | 'above' | 'ignore';
export interface ModelPose {
  name: string;
  /** Local rotations about attachment points; moves are in the parent's frame. */
  pose: RigPose;
  ground?: ModelGround;
}
export interface ModelDefinition {
  name: string;
  root: string;
  parts: readonly ModelPart[];
  ground?: ModelGround;
  tolerance?: number;
  /** Key poses, with linearly interpolated move/XYZ angle samples between consecutive entries. */
  poses?: readonly ModelPose[];
  /** Intermediate samples per transition, 0–8 (default 3). Not continuous collision proof. */
  samples?: number;
  /** Feet/support parts used to place the entire model on y=0 during animation playback. */
  grounding?: { parts: readonly string[] };
  animations?: Readonly<Record<string, ModelAnimation>>;
}
export interface ModelAnimation {
  durationMs: number;
  loop?: boolean;
  /** Set false for jumps or flight to preserve authored vertical motion. */
  grounding?: boolean;
  keyframes: readonly { atMs: number; pose: RigPose }[];
  /** Uniform inspection intervals over the clip; keyframes are always checked too. 2–16, default 8. */
  samples?: number;
}
export interface ModelBounds { min: RigVector; max: RigVector; size: RigVector; center: RigVector }
export interface SolvedModelPart { name: string; shape?: 'box' | 'sphere'; size: RigVector; transform: RigTransform }
export interface ModelDiagnostic {
  code: 'FLOATING' | 'BURIED' | 'ATTACHMENT' | 'BELOW_GROUND' | 'NO_GROUND';
  severity: 'error' | 'warning';
  pose: string;
  part: string;
  other?: string;
  /** Separating-axis clearance, in metres (not Euclidean nearest-point distance). */
  gap?: number;
  axis?: RigVector;
  message: string;
}
export interface ModelReport {
  name: string;
  parts: number;
  posesChecked: number;
  bounds: ModelBounds;
  collisionBounds: ModelBounds | null;
  diagnostics: ModelDiagnostic[];
  errors: number;
  warnings: number;
  truncated: boolean;
}

const axes = ['x', 'y', 'z'] as const;
const zero = (): RigVector => ({ x: 0, y: 0, z: 0 });
const add = (a: RigVector, b: RigVector): RigVector => ({ x:a.x+b.x,y:a.y+b.y,z:a.z+b.z });
const mul = (a: RigVector, n: number): RigVector => ({ x:a.x*n || 0,y:a.y*n || 0,z:a.z*n || 0 });
const sub = (a: RigVector, b: RigVector): RigVector => add(a,mul(b,-1));
const dot = (a: RigVector, b: RigVector): number => a.x*b.x+a.y*b.y+a.z*b.z;
const cross = (a: RigVector,b: RigVector): RigVector => ({ x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x });
const basis = (t: RigTransform): RigVector[] => [t.xAxis,t.yAxis,t.zAxis];
const rotate = (t: RigTransform,v: RigVector): RigVector => add(add(mul(t.xAxis,v.x),mul(t.yAxis,v.y)),mul(t.zAxis,v.z));
const inverseRotate = (t: RigTransform,v: RigVector): RigVector => ({ x:dot(t.xAxis,v),y:dot(t.yAxis,v),z:dot(t.zAxis,v) });
const faces: Record<ModelFace, RigVector> = { left:{x:-1,y:0,z:0},right:{x:1,y:0,z:0},top:{x:0,y:1,z:0},bottom:{x:0,y:-1,z:0},front:{x:0,y:0,z:1},back:{x:0,y:0,z:-1} };
const rotationRig = defineRig({ joints:[{name:'part',position:zero()}],sockets:[] });
function rotation(angles?: RigAngles): RigTransform {
  if (angles !== undefined) {
    if (!angles || typeof angles !== 'object') throw new Error('Model: rotation must be XYZ angles');
    for (const axis of axes) if (angles[axis] !== undefined) finite(angles[axis]!,`rotation.${axis}`,-720,720);
  }
  return jointLocalTransform(rotationRig,'part',{ part:{rotate:angles} });
}
function finite(n: number, label: string, min = -100, max = 100): void {
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Model: ${label} must be within ${min}..${max}`);
}
function name(n: string): void {
  if (typeof n !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(n)) throw new Error(`Model: invalid name ${String(n)}`);
}
function vector(v: RigVector, label: string, min = -100): void { for (const axis of axes) finite(v[axis],`${label}.${axis}`,min); }

/** Validate and copy a definition; parents are sorted automatically and cycles are rejected.
 * Example: defineModel({ name:'prop', root:'body', parts:[
 *   { name:'body', size:{x:1,y:1,z:1}, position:{x:0,y:.5,z:0}, collision:true },
 *   { name:'cap', size:{x:.5,y:.1,z:.5}, attach:{part:'body',face:'top'} }
 * ] }). Default-export this from src/game/prop.model.ts, and render the same definition.
 */
export function defineModel(definition: ModelDefinition): ModelDefinition {
  const d = JSON.parse(JSON.stringify(definition)) as ModelDefinition;
  name(d.name); name(d.root);
  if (!Array.isArray(d.parts) || !d.parts.length || d.parts.length > 48) throw new Error('Model: expected 1–48 parts');
  const seen = new Set<string>();
  for (const p of d.parts) {
    name(p.name);
    if (seen.has(p.name)) throw new Error(`Model: duplicate part ${p.name}`);
    seen.add(p.name);
  }
  for (const p of d.parts) {
    vector(p.size,p.name,0.000001); if (p.position) vector(p.position,p.name);
    if (p.shape !== undefined && p.shape !== 'box' && p.shape !== 'sphere') throw new Error(`Model: unknown shape for ${p.name}`);
    if (p.shape === 'sphere' && (p.size.x !== p.size.y || p.size.x !== p.size.z)) throw new Error(`Model: ${p.name} sphere diameters must be equal`);
    rotation(p.rotate);
    if (p.color !== undefined) finite(p.color,'color',0,0xffffff);
    for (const reason of [p.allowFloating,p.allowBuried]) if (reason !== undefined && (typeof reason !== 'string' || !reason.trim() || reason.length > 200)) throw new Error('Model: allowance needs a short reason');
    if (p.attach) {
      if (p.attach.mode !== undefined && !['fixed','joint'].includes(p.attach.mode)) throw new Error('Model: invalid attachment mode');
      if (!seen.has(p.attach.part) || !Object.hasOwn(faces,p.attach.face)) throw new Error(`Model: ${p.name} has an invalid attachment parent or face`);
      finite(p.attach.sink ?? 0,'sink',0); finite(p.attach.gap ?? 0,'gap',0);
      if (p.attach.sink && p.attach.gap) throw new Error('Model: choose sink or gap');
      for (const a of axes) finite(p.attach.align?.[a] ?? 0,'alignment',-1,1);
    }
  }
  const ordered: ModelPart[] = [], visiting = new Set<string>(), visited = new Set<string>();
  const visit = (p: ModelPart) => {
    if (visited.has(p.name)) return;
    if (visiting.has(p.name)) throw new Error(`Model: attachment cycle at ${p.name}`);
    visiting.add(p.name);
    if (p.attach) visit(d.parts.find(parent => parent.name === p.attach!.part)!);
    visiting.delete(p.name); visited.add(p.name); ordered.push(p);
  };
  d.parts.forEach(visit); d.parts = ordered;
  if (!seen.has(d.root)) throw new Error('Model: root part is missing');
  const ground = (g?: ModelGround) => { if (g !== undefined && !['required','above','ignore'].includes(g)) throw new Error('Model: invalid ground policy'); };
  ground(d.ground); finite(d.tolerance ?? .001,'tolerance',0,.01);
  finite(d.samples ?? 3,'samples',0,8);
  if (!Number.isInteger(d.samples ?? 3) || (d.poses?.length ?? 0) > 12) throw new Error('Model: at most 12 key poses and 8 integer samples');
  const poseNames = new Set<string>(['rest']);
  for (const p of d.poses ?? []) {
    name(p.name); ground(p.ground);
    if (poseNames.has(p.name)) throw new Error('Model: duplicate pose name');
    poseNames.add(p.name);
    validateModelPose(d,p.pose);
  }
  if (d.grounding && (!Array.isArray(d.grounding.parts) || !d.grounding.parts.length || d.grounding.parts.length > 48 || d.grounding.parts.some(p => !seen.has(p)))) throw new Error('Model: grounding must name existing support parts');
  if (Object.keys(d.animations ?? {}).length > 6) throw new Error('Model: at most 6 animation clips');
  for (const [clipName,clip] of Object.entries(d.animations ?? {})) {
    name(clipName); finite(clip.durationMs,'clip duration',100,60000);
    finite(clip.samples ?? 8,'clip samples',2,16);
    if (!Number.isInteger(clip.samples ?? 8) || !Array.isArray(clip.keyframes) || clip.keyframes.length < 2 || clip.keyframes.length > 16) throw new Error('Model: clips need 2–16 keyframes and integer samples');
    let previous = -1;
    for (const frame of clip.keyframes) {
      finite(frame.atMs,'keyframe time',0,clip.durationMs);
      if (frame.atMs <= previous) throw new Error('Model: keyframe times must increase');
      previous = frame.atMs; validateModelPose(d,frame.pose);
    }
    if (clip.keyframes[0].atMs !== 0 || previous !== clip.durationMs) throw new Error('Model: keyframes must cover 0 through durationMs');
    if (clip.loop && JSON.stringify(interpolateModelPose(d,clip.keyframes[0].pose,{},0)) !== JSON.stringify(interpolateModelPose(d,clip.keyframes.at(-1)!.pose,{},0))) throw new Error('Model: looping clips must end at their starting pose');
  }
  return d;
}
function validateModelPose(d: ModelDefinition, pose: RigPose): void {
  for (const [key,p] of Object.entries(pose)) {
    if (!d.parts.some(part => part.name === key)) throw new Error(`Model: unknown pose part ${key}`);
    if (p.move) vector(p.move,key); rotation(p.rotate);
  }
}

function interpolateModelPose(model: ModelDefinition, from: RigPose, to: RigPose, amount: number): RigPose {
  return Object.fromEntries(model.parts.map(p => {
    const move = zero(), rotate = zero();
    for (const axis of axes) {
      move[axis] = (from[p.name]?.move?.[axis] ?? 0)*(1-amount)+(to[p.name]?.move?.[axis] ?? 0)*amount;
      rotate[axis] = (from[p.name]?.rotate?.[axis] ?? 0)*(1-amount)+(to[p.name]?.rotate?.[axis] ?? 0)*amount;
    }
    return [p.name,{move,rotate}];
  }));
}
/** Move all roots together so the lowest declared support touches y=0. Does not provide terrain IK or prevent foot sliding. */
export function groundModelPose(model: ModelDefinition, pose: RigPose = {}): RigPose {
  if (!model.grounding) return pose;
  const supports = solveModel(model,pose).filter(p => model.grounding!.parts.includes(p.name));
  const offset = -bounds(supports).min.y;
  const result = {...pose};
  for (const p of model.parts) if (!p.attach) result[p.name] = {...pose[p.name],move:add(pose[p.name]?.move ?? zero(),{x:0,y:offset,z:0})};
  return result;
}
/** The single animation evaluator used by rendering, inspection and logic. Time is explicit simulation milliseconds. */
export function sampleModelAnimation(model: ModelDefinition, clipName: string, timeMs: number): RigPose {
  finite(timeMs,'animation time',0,1e15);
  const clip = model.animations && Object.hasOwn(model.animations,clipName) ? model.animations[clipName] : undefined;
  if (!clip) throw new Error(`Model: unknown animation ${clipName}`);
  const time = clip.loop ? timeMs % clip.durationMs : Math.min(timeMs,clip.durationMs);
  const end = clip.keyframes.findIndex(f => f.atMs >= time);
  const a = clip.keyframes[Math.max(0,end-1)], b = clip.keyframes[Math.max(0,end)];
  const pose = interpolateModelPose(model,a.pose,b.pose,a === b ? 0 : (time-a.atMs)/(b.atMs-a.atMs));
  return clip.grounding === false ? pose : groundModelPose(model,pose);
}

/** Repeat a template at named offsets. Each copy owns its nested fields and can be edited independently. */
export function repeatModelPart(template: Omit<ModelPart,'name'>, copies: readonly { name: string; offset: RigVector }[]): ModelPart[] {
  if (copies.length > 48) throw new Error('Model: too many repeated parts');
  return copies.map(c => ({ ...JSON.parse(JSON.stringify(template)),name:c.name,position:add(template.position ?? zero(),c.offset) }));
}
/** Mirrored pair across the parent's X/Y/Z plane, including offsets, alignment, attachment face and rotation. */
export function mirrorModelPart(part: ModelPart, mirroredName: string, axis: 'x'|'y'|'z' = 'x'): ModelPart[] {
  const copy = JSON.parse(JSON.stringify(part)) as ModelPart; copy.name = mirroredName;
  if (copy.position) copy.position[axis] *= -1;
  if (copy.rotate) for (const a of axes) if (a !== axis && copy.rotate[a] !== undefined) copy.rotate[a]! *= -1;
  if (copy.attach) {
    const normal = faces[copy.attach.face];
    if (normal[axis]) copy.attach.face = (Object.keys(faces) as ModelFace[]).find(f => faces[f][axis] === -normal[axis])!;
    if (copy.attach.align?.[axis] !== undefined) copy.attach.align[axis]! *= -1;
  }
  return [part,copy];
}
function radius(part: SolvedModelPart, axis: RigVector): number {
  if (part.shape === 'sphere') return part.size.x/2;
  return basis(part.transform).reduce((sum,b,i) => sum+Math.abs(dot(b,axis))*part.size[axes[i]]/2,0);
}

/** Solve centres and orientations, rotating children around their declared attachment pivot. */
export function solveModel(model: ModelDefinition, pose: RigPose = {}): SolvedModelPart[] {
  validateModelPose(model,pose);
  const solved = new Map<string,SolvedModelPart>();
  for (const p of model.parts) {
    const rest = rotation(p.rotate), animated = rotation(pose[p.name]?.rotate);
    let pivot = p.position ?? zero(), offset = zero(), parent = IDENTITY;
    if (p.attach) {
      const target = solved.get(p.attach.part);
      if (!target) throw new Error(`Model: missing parent ${p.attach.part}`);
      parent = target.transform;
      const normal = faces[p.attach.face];
      const local = { name:p.name,shape:p.shape,size:p.size,transform:rest };
      const parentHalfExtent = Math.abs(dot(target.size,normal))/2;
      pivot = add(mul(normal,parentHalfExtent+(p.attach.gap ?? 0)-(p.attach.sink ?? 0)),p.position ?? zero());
      for (const a of axes) if (!normal[a]) {
        const unit = { ...zero(),[a]:1 };
        pivot[a] += (p.attach.align?.[a] ?? 0)*(target.size[a]/2-radius(local,unit));
      }
      // Offset spheres meet on a curved surface, not on their bounding-box faces.
      // Keep the requested tangential offset and solve the normal distance exactly.
      if (p.shape === 'sphere' && target.shape === 'sphere') {
        const tangent = sub(pivot,mul(normal,dot(pivot,normal)));
        const combined = (p.size.x+target.size.x)/2;
        const squared = combined*combined-dot(tangent,tangent);
        if (squared < 0) throw new Error(`Model: ${p.name} offset is beyond ${target.name}'s sphere attachment reach`);
        const distance = Math.sqrt(squared)+(p.attach.gap ?? 0)-(p.attach.sink ?? 0)+dot(p.position ?? zero(),normal);
        pivot = add(tangent,mul(normal,distance-p.size.x/2));
      }
      offset = inverseRotate(rest,mul(normal,radius(local,normal)));
    }
    const orient = composeRigTransforms(rest,animated);
    const transform = composeRigTransforms(parent,{ ...orient,position:add(add(pivot,pose[p.name]?.move ?? zero()),rotate(orient,offset)) });
    solved.set(p.name,{name:p.name,shape:p.shape,size:p.size,transform});
  }
  return [...solved.values()];
}

function bounds(parts: readonly SolvedModelPart[]): ModelBounds {
  const min = {x:Infinity,y:Infinity,z:Infinity}, max = {x:-Infinity,y:-Infinity,z:-Infinity};
  for (const p of parts) for (const a of axes) {
    const r = radius(p,{...zero(),[a]:1});
    min[a] = Math.min(min[a],p.transform.position[a]-r); max[a] = Math.max(max[a],p.transform.position[a]+r);
  }
  return {min,max,size:sub(max,min),center:mul(add(min,max),.5)};
}
/** Visual bounds, or only explicitly selected collision parts. Null means no parts were selected. */
export function modelBounds(model: ModelDefinition, pose: RigPose = {}, collisionOnly = false): ModelBounds | null {
  const parts = solveModel(model,pose).filter(p => !collisionOnly || model.parts.find(d => d.name === p.name)?.collision);
  return parts.length ? bounds(parts) : null;
}
/** A conservative vertical cylinder enclosing selected collision boxes, not all decoration. */
export function modelCollider(model: ModelDefinition, pose: RigPose = {}): { center: RigVector; radius: number; height: number } | null {
  const b = modelBounds(model,pose,true);
  return b ? {center:b.center,radius:Math.hypot(b.size.x,b.size.z)/2,height:b.size.y} : null;
}
function sphereBox(sphere: SolvedModelPart, box: SolvedModelPart): {gap:number;axis:RigVector} {
  const local = inverseRotate(box.transform,sub(sphere.transform.position,box.transform.position));
  const closest = {x:0,y:0,z:0};
  for (const axis of axes) closest[axis] = Math.max(-box.size[axis]/2,Math.min(box.size[axis]/2,local[axis]));
  const toward = sub(closest,local), distance = Math.hypot(toward.x,toward.y,toward.z);
  if (distance > 1e-10) return {gap:distance-sphere.size.x/2,axis:rotate(box.transform,mul(toward,1/distance))};
  const nearest = [...axes].sort((a,b) => (box.size[a]/2-Math.abs(local[a]))-(box.size[b]/2-Math.abs(local[b])))[0];
  return {gap:-(box.size[nearest]/2-Math.abs(local[nearest]))-sphere.size.x/2,axis:rotate(box.transform,{...zero(),[nearest]:local[nearest] < 0 ? -1 : 1})};
}
function clearance(a: SolvedModelPart,b: SolvedModelPart): {gap:number;axis:RigVector} {
  if (a.shape === 'sphere' && b.shape === 'sphere') {
    const delta = sub(b.transform.position,a.transform.position), distance = Math.hypot(delta.x,delta.y,delta.z);
    return {gap:distance-(a.size.x+b.size.x)/2,axis:distance > 1e-10 ? mul(delta,1/distance) : {x:1,y:0,z:0}};
  }
  if (a.shape === 'sphere') return sphereBox(a,b);
  if (b.shape === 'sphere') { const contact = sphereBox(b,a); return {gap:contact.gap,axis:mul(contact.axis,-1)}; }
  const aa = basis(a.transform), bb = basis(b.transform), delta = sub(b.transform.position,a.transform.position);
  let gap = -Infinity, axis = zero();
  for (const candidate of [...aa,...bb,...aa.flatMap(x => bb.map(y => cross(x,y)))]) {
    const length = Math.hypot(candidate.x,candidate.y,candidate.z); if (length < 1e-8) continue;
    const n = mul(candidate,1/length), distance = Math.abs(dot(delta,n))-radius(a,n)-radius(b,n);
    if (distance > gap) { gap = distance; axis = mul(n,dot(delta,n) < 0 ? -1 : 1); }
  }
  return {gap,axis};
}
function separation(a: SolvedModelPart,b: SolvedModelPart): {gap:number;axis:RigVector} {
  const result = clearance(a,b); return {...result,gap:Math.max(0,result.gap)};
}
function contained(a: SolvedModelPart,b: SolvedModelPart,tolerance: number): boolean {
  const delta = sub(a.transform.position,b.transform.position);
  if (b.shape === 'sphere') {
    if (a.shape === 'sphere') return Math.hypot(delta.x,delta.y,delta.z)+a.size.x/2 < b.size.x/2-tolerance;
    for (const x of [-1,1]) for (const y of [-1,1]) for (const z of [-1,1]) {
      const corner = add(delta,rotate(a.transform,{x:x*a.size.x/2,y:y*a.size.y/2,z:z*a.size.z/2}));
      if (Math.hypot(corner.x,corner.y,corner.z) >= b.size.x/2-tolerance) return false;
    }
    return true;
  }
  return basis(b.transform).every((axis,i) => Math.abs(dot(delta,axis))+radius(a,axis) < b.size[axes[i]]/2-tolerance);
}

/** Inspect rest, named poses and intermediate samples. Checks boxes/spheres, not arbitrary meshes or visual quality. */
export function inspectModel(definition: ModelDefinition): ModelReport {
  const d = defineModel(definition), tolerance = d.tolerance ?? .001;
  const restPose = groundModelPose(d);
  const report: ModelReport = {name:d.name,parts:d.parts.length,posesChecked:0,bounds:modelBounds(d,restPose)!,collisionBounds:modelBounds(d,restPose,true),diagnostics:[],errors:0,warnings:0,truncated:false};
  const emit = (item: ModelDiagnostic) => {
    if (item.severity === 'error') report.errors++; else report.warnings++;
    if (report.diagnostics.length < 200) report.diagnostics.push(item); else report.truncated = true;
  };
  const poses: ModelPose[] = [{name:'rest',pose:groundModelPose(d),ground:d.ground ?? 'required'},...(d.poses ?? [])];
  const checks: ModelPose[] = [...poses];
  for (let i=1;i<poses.length;i++) for (let j=1;j<=(d.samples ?? 3);j++) {
    const amount = j/((d.samples ?? 3)+1), pose: Record<string,{move:RigVector;rotate:RigAngles}> = {};
    for (const p of d.parts) {
      const from = poses[i-1].pose[p.name], to = poses[i].pose[p.name];
      const move = zero(), angles = zero();
      for (const a of axes) {
        move[a] = (from?.move?.[a] ?? 0)*(1-amount)+(to?.move?.[a] ?? 0)*amount;
        angles[a] = (from?.rotate?.[a] ?? 0)*(1-amount)+(to?.rotate?.[a] ?? 0)*amount;
      }
      pose[p.name] = {move,rotate:angles};
    }
    checks.push({name:`${poses[i-1].name}->${poses[i].name}@${amount.toFixed(2)}`,pose,ground:poses[i].ground ?? 'above'});
  }
  for (const [clipName,clip] of Object.entries(d.animations ?? {})) {
    const times = new Set(clip.keyframes.map(f => f.atMs));
    for (let i=0;i<=(clip.samples ?? 8);i++) times.add(clip.durationMs*i/(clip.samples ?? 8));
    for (const time of times) checks.push({name:`${clipName}@${Math.round(time)}ms`,pose:sampleModelAnimation(d,clipName,time),ground:d.ground === 'ignore' ? 'ignore' : d.grounding && clip.grounding !== false ? 'required' : 'above'});
  }
  for (const check of checks) {
    const parts = solveModel(d,check.pose), byName = new Map(parts.map(p => [p.name,p]));
    const graph = new Map(parts.map(p => [p.name,new Set<string>()]));
    for (let i=0;i<parts.length;i++) for (let j=i+1;j<parts.length;j++) if (separation(parts[i],parts[j]).gap <= tolerance) {
      graph.get(parts[i].name)!.add(parts[j].name); graph.get(parts[j].name)!.add(parts[i].name);
    }
    const reached = new Set<string>(), pending = [d.root,...d.parts.filter(p => p.allowFloating).map(p => p.name)];
    while (pending.length) { const key = pending.pop()!; if (reached.has(key)) continue; reached.add(key); pending.push(...graph.get(key)!); }
    for (const p of parts) {
      const spec = d.parts.find(s => s.name === p.name)!;
      if (!reached.has(p.name)) {
        // Find the nearest part in the connected component, avoiding a misleading zero gap to a floating sibling.
        const near = parts.filter(q => reached.has(q.name)).map(q => ({other:q.name,...separation(p,q)})).sort((a,b) => a.gap-b.gap)[0];
        emit({code:'FLOATING',severity:'error',pose:check.name,part:p.name,...near,message:`${p.name} is disconnected from ${d.root}; move it toward ${near.other} or declare intentional floating.`});
      }
      if (spec.attach && !spec.allowFloating) {
        const target = byName.get(spec.attach.part)!, normal = rotate(target.transform,faces[spec.attach.face]);
        const plane = dot(sub(p.transform.position,target.transform.position),normal)-radius(target,normal);
        const r = radius(p,normal), distance = separation(p,target);
        const wrongSurface = target.shape === 'sphere'
          ? dot(sub(p.transform.position,target.transform.position),normal) <= 0 || clearance(p,target).gap < -(spec.attach.sink ?? 0)-tolerance
          : plane-r > tolerance || plane-r < -(spec.attach.sink ?? 0)-tolerance;
        const jointMove = check.pose[p.name]?.move ?? zero();
        const invalid = spec.attach.mode === 'joint' && check.name !== 'rest'
          ? Math.hypot(jointMove.x,jointMove.y,jointMove.z) > tolerance
          : wrongSurface;
        if (distance.gap > tolerance || invalid) emit({code:'ATTACHMENT',severity:'error',pose:check.name,part:p.name,other:target.name,gap:distance.gap,axis:normal,message:spec.attach.mode === 'joint' ? `${p.name} joint must remain touching ${target.name} without translating its pivot.` : `${p.name} no longer meets ${target.name}.${spec.attach.face} within its declared sink depth.`});
      }
      if (!spec.allowBuried) for (const q of parts) if (q !== p && contained(p,q,tolerance)) {
        emit({code:'BURIED',severity:'warning',pose:check.name,part:p.name,other:q.name,message:`${p.name} is fully inside ${q.name}; check visibility or declare intentional burial.`}); break;
      }
      if ((check.ground ?? 'above') !== 'ignore' && bounds([p]).min.y < -tolerance) emit({code:'BELOW_GROUND',severity:'error',pose:check.name,part:p.name,message:`${p.name} extends below y=0.`});
    }
    if (check.ground === 'required' && !parts.some(p => Math.abs(bounds([p]).min.y) <= tolerance)) emit({code:'NO_GROUND',severity:'error',pose:check.name,part:d.root,message:'No part touches y=0 in this grounded pose.'});
    report.posesChecked++;
  }
  return report;
}
