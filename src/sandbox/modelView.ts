import { BoxGeometry, SphereGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { defineModel, groundModelPose, sampleModelAnimation, solveModel, type ModelDefinition } from './model.ts';
import type { RigPose } from './rig.ts';
import {prepareModelSphereLod,type PreparedModelPrimitiveLod} from './modelLod.ts';

export interface ModelView {
  /** Add to actors, or attach to an existing RigView socket. External transforms aren't inspected. */
  root: Group;
  parts: ReadonlyMap<string, Mesh<BoxGeometry | SphereGeometry,MeshStandardMaterial>>;
  apply(pose: RigPose): void;
  /** Evaluate the same named clip that build inspection samples. */
  animate(clip: string, timeMs: number): void;
  /** Switch/start a clip using simulation time; automatically track elapsed time while it remains selected. */
  play(clip: string, simulationMs: number): void;
  dispose(): void;
}
/** Render the boxes/spheres inspected by inspectModel. Animate through apply, not individual mesh mutations. */
export function createModelView(definition: ModelDefinition): ModelView {
  const model = defineModel(definition), root = new Group(); root.name = model.name;
  const parts = new Map<string,Mesh<BoxGeometry | SphereGeometry,MeshStandardMaterial>>();
  const prepared=new Map<string,PreparedModelPrimitiveLod<SphereGeometry>>();
  for (const p of model.parts) {
    const bank=p.shape==='sphere'?prepareModelSphereLod(p.size.x/2):undefined;
    if(bank)prepared.set(p.name,bank);
    const geometry = bank?.geometry??new BoxGeometry(p.size.x,p.size.y,p.size.z);
    const mesh = new Mesh(geometry,new MeshStandardMaterial({color:p.color ?? 0xffffff,roughness:.8}));
    mesh.name = p.name; mesh.castShadow = true; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false;
    root.add(mesh); parts.set(p.name,mesh);
  }
  const apply = (pose: RigPose) => {
    for (const p of solveModel(model,pose)) {
      const mesh = parts.get(p.name)!, t = p.transform;
      mesh.matrix.set(t.xAxis.x,t.yAxis.x,t.zAxis.x,t.position.x,t.xAxis.y,t.yAxis.y,t.zAxis.y,t.position.y,t.xAxis.z,t.yAxis.z,t.zAxis.z,t.position.z,0,0,0,1);
      mesh.matrixWorldNeedsUpdate = true;
    }
  };
  apply(groundModelPose(model));
  let playing = '', startedAt = 0, lastTime = 0;
  const play = (clip: string, time: number) => {
    if (!Number.isFinite(time) || time < 0) throw new Error('Model: simulation time must be finite and nonnegative');
    const start = clip !== playing || time < lastTime ? time : startedAt;
    const pose = sampleModelAnimation(model,clip,time-start);
    playing=clip; startedAt=start; lastTime=time; apply(pose);
  };
  let disposed=false;
  return {root,parts,apply,animate:(clip,time) => apply(sampleModelAnimation(model,clip,time)),play,dispose:() => {
    if(disposed)return;disposed=true;
    for (const [name,mesh] of parts) { const bank=prepared.get(name);if(bank)bank.dispose();else mesh.geometry.dispose();mesh.material.dispose(); }
    root.removeFromParent();
  }};
}
