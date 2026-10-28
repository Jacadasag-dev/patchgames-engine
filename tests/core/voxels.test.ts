import {describe,it,expect} from 'vitest';
import * as THREE from 'three';
import {VoxelField,type VoxelSurfaceCache} from '../../src/sandbox/voxels.ts';
import {VoxelWorldView} from '../../src/sandbox/voxelView.ts';
import {createVoxelWorld} from '../../src/sandbox/voxelWorld.ts';
import {prepareTerrainWorld} from '../../src/sandbox/terrainWorld.ts';

const bounds={minX:-64,maxX:64,minY:-4,maxY:8,minZ:-64,maxZ:64};
const field=()=>new VoxelField({bounds,chunkSize:4,sample:(_x,y)=>y<1?1:0});
describe('editable voxel worlds',()=>{
  it('cuts imported native solids identically across seams, placements and undo without sampling',()=>{
    const original=field(),imported=new VoxelField({bounds,chunkSize:4,sample:()=>{throw new Error('Imported edits must not generate terrain');}});
    for(const x of [-1,0])for(const z of [-1,0])imported.importCollisionChunk(x,z,original.chunkColliders(x,z));
    const edits=[{x:-1,y:0,z:-1,material:0},{x:0,y:0,z:-1,material:0},{x:0,y:2,z:0,material:2},{x:1,y:-1,z:0,material:0}];
    for(const next of [edits,edits.slice(0,2),[],edits.toReversed()]){
      original.setEdits(next);imported.setEdits(next);expect(imported.collisionEdits()).toEqual(original.collisionEdits());
    }
    expect(()=>imported.importCollisionChunk(1,0,original.chunkColliders(0,0))).toThrow(/identity/);
    const bad=structuredClone(original.chunkColliders(0,0));bad[0].position.x+=.25;
    expect(()=>imported.importCollisionChunk(0,0,bad)).toThrow(/bounds/);
  });
  it('retains a normal visible horizon and seam columns without resampling cached cells',()=>{
    let samples=0;const f=new VoxelField({bounds:{...bounds,minX:-128,maxX:128,minZ:-128,maxZ:128},sample:()=>{samples++;return 0;}});
    for(let x=-33;x<65;x++)for(let z=-33;z<65;z++)f.get(x,0,z);
    const before=samples;
    for(let x=-33;x<65;x++)for(let z=-33;z<65;z++)f.get(x,0,z);
    expect(samples).toBe(before);
  });
  it('samples only requested cells during ordinary rays, leaving full columns to preparation',()=>{
    let samples=0;const f=new VoxelField({bounds,chunkSize:4,sample:(_x,y)=>{samples++;return y<1?1:0;}});
    expect(f.get(0,0,0)).toBe(1);expect(samples).toBe(1);
    f.get(0,0,0);expect(samples).toBe(1);
    const column=f.baseColumn(0,0);expect(column).toHaveLength(12);expect(samples).toBe(12);
    expect(Object.isFrozen(column)).toBe(true);
  });
  it('invalidates only newly changed chunk neighborhoods across successive edits',()=>{
    const f=field(),first={x:1,y:0,z:1,material:0};f.setEdits([first]);
    const untouched=f.chunkRevision(0,0);
    f.setEdits([first,{x:25,y:0,z:25,material:0}]);
    expect(f.chunkRevision(0,0)).toBe(untouched);expect(f.chunkRevision(6,6)).toBeGreaterThan(untouched);
    f.setEdits([{x:25,y:0,z:25,material:0}]);expect(f.chunkRevision(0,0)).toBeGreaterThan(untouched);
  });
  it('uses exact negative grid crossings and returns the struck face for placement',()=>{
    const f=field(),hit=f.raycast({x:-.5,y:3,z:-.5},{x:0,y:-1,z:0},6)!;
    expect(hit.block).toEqual({x:-1,y:0,z:-1});expect(hit.previous).toEqual({x:-1,y:1,z:-1});
    expect(hit.normal).toEqual({x:0,y:1,z:0});expect(hit.distance).toBe(2);
    expect(f.raycast({x:0,y:3,z:0},{x:0,y:1,z:0},6)).toBeNull();
  });
  it('splits native solid runs when digging a tunnel and restores them when filled',()=>{
    const f=field();expect(f.columnColliders(0,0)).toHaveLength(1);
    f.setEdits([{x:0,y:-2,z:0,material:0}]);
    expect(f.get(0,-2,0)).toBe(0);expect(f.columnColliders(0,0)).toHaveLength(2);
    expect(f.collisionEdits().remove).toHaveLength(1);expect(f.collisionEdits().add.length).toBeGreaterThan(1);
    f.setEdits([]);expect(f.columnColliders(0,0)).toHaveLength(1);
  });
  it('keeps incremental cut descriptors independent of edit arrival history',()=>{
    const a={x:1,y:0,z:1,material:0},b={x:2,y:-1,z:2,material:0};
    const first=field(),fresh=field();
    first.setEdits([b]);first.collisionEdits();first.setEdits([b,a]);
    fresh.setEdits([a,b]);expect(first.collisionEdits()).toEqual(fresh.collisionEdits());
    first.setEdits([a]);fresh.setEdits([a]);expect(first.collisionEdits()).toEqual(fresh.collisionEdits());
  });
  it('culls internal/seam faces and preserves actual cave ceiling surfaces',()=>{
    const f=new VoxelField({bounds:{minX:0,maxX:2,minY:0,maxY:1,minZ:0,maxZ:1},chunkSize:4,sample:()=>1});
    const s=f.surface(0,0);expect(s.materials).toHaveLength(10);expect(s.positions).toHaveLength(10*18);
    for(let i=0;i<s.positions.length;i+=9){const a=new THREE.Vector3(...s.positions.slice(i,i+3) as [number,number,number]),b=new THREE.Vector3(...s.positions.slice(i+3,i+6) as [number,number,number]),c=new THREE.Vector3(...s.positions.slice(i+6,i+9) as [number,number,number]);
      expect(b.sub(a).cross(c.sub(a)).normalize().dot(new THREE.Vector3(...s.normals.slice(i,i+3) as [number,number,number]))).toBeCloseTo(1);}
  });
  it('retains sparse edits after deterministic column cache eviction',()=>{
    const f=new VoxelField({bounds,chunkSize:4,maxCachedColumns:64,sample:(x,y,z)=>y<((x*13+z*7)&3)?1:0});
    f.setEdits([{x:-1,y:4,z:-1,material:3}]);const original=f.baseColumn(-1,-1);
    for(let x=0;x<100;x++)f.baseColumn(x,0);
    expect(f.get(-1,4,-1)).toBe(3);expect(f.baseColumn(-1,-1)).toEqual(original);
  });
  it('batches a chunk by material and disposes geometry when chunks leave',()=>{
    const f=field(),materials=[new THREE.MeshBasicMaterial(),new THREE.MeshBasicMaterial()],view=new VoxelWorldView(materials);
    view.update(f,[{x:0,z:0}]);const mesh=view.root.children[0] as THREE.Mesh;
    expect(mesh.geometry.groups).toHaveLength(1);expect(view.inspection().chunks).toBe(1);
    view.update(f,[]);expect(view.root.children).toHaveLength(0);view.dispose();materials.forEach(m=>m.dispose());
  });
  it('retains existing geometry while a newly edited chunk is generated in slices',()=>{
    const f=new VoxelField({bounds,chunkSize:32,sample:(_x,y)=>y<1?1:0});
    const materials=[new THREE.MeshBasicMaterial(),new THREE.MeshBasicMaterial()],view=new VoxelWorldView(materials);
    view.update(f,[{x:0,z:0}]);const original=view.root.children[0];
    const wanted=[{x:0,z:0},{x:1,z:0}];view.update(f,wanted);
    expect(view.root.children[0]).toBe(original);expect(view.inspection().pendingChunks).toBe(1);
    f.setEdits([{x:33,y:0,z:2,material:0}]);
    for(let i=0;i<100&&view.inspection().pendingChunks;i++)view.update(f,wanted);
    expect(view.inspection().pendingChunks).toBe(0);expect(view.root.children[0]).toBe(original);
    const mesh=view.root.children[1] as THREE.Mesh;
    expect(mesh.geometry.getAttribute('position').count).toBe(f.surface(1,0).positions.length/3);
    expect(Array.from(mesh.geometry.getAttribute('position').array)).toEqual(f.surface(1,0).positions);
    view.dispose();materials.forEach(m=>m.dispose());
  });
  it('continues updating the visible mesh when edits arrive every six rendered frames',()=>{
    const f=new VoxelField({bounds,chunkSize:32,sample:(_x,y)=>y<1?1:0});
    const materials=[new THREE.MeshBasicMaterial(),new THREE.MeshBasicMaterial()],view=new VoxelWorldView(materials);
    view.update(f,[{x:0,z:0}]);const first=view.root.children[0];
    // A 200ms mining action at 30Hz must not cancel an eight-frame rebuild
    // forever. Alternate one cell so both removal and restoration are tested.
    for(let frame=0;frame<180;frame++){
      if(frame%6===0)f.setEdits([{x:1,y:0,z:1,material:(frame/6)%2?1:0}]);
      view.update(f,[{x:0,z:0}]);
    }
    expect(view.root.children[0]).not.toBe(first);
    view.dispose();materials.forEach(m=>m.dispose());
  });
  it('regenerates only the edited column and face neighbors and rejects a cache from another field',()=>{
    const f=field(),cache:VoxelSurfaceCache=new Map();
    const drain=(value:VoxelField)=>{const work=value.surfaceSteps(0,0,cache);let slices=0,result=work.next();while(!result.done){slices++;result=work.next();}return{slices,surface:result.value};};
    expect(drain(f).slices).toBe(16);
    f.setEdits([{x:1,y:0,z:1,material:0}]);const edited=drain(f);
    expect(edited.slices).toBe(5);expect(edited.surface).toEqual(f.surface(0,0));
    const other=new VoxelField({bounds,chunkSize:4,sample:()=>0});
    expect(drain(other).surface.materials).toHaveLength(0);
    expect(drain(f).surface).toEqual(f.surface(0,0));
  });
  it('prepares matching native column collision through the real terrain host and keeps old snapshots immutable',()=>{
    type W={edits:{x:number;y:number;z:number;material:number}[]};
    const world=createVoxelWorld<{seed:number},W>({field:()=>({bounds,sample:(_x,y)=>y<1?1:0}),seed:t=>t.seed,edits:w=>w?.edits??[]});
    const t={seed:17};world.terrainWorld.sync(t,{edits:[]});
    expect(world.terrainWorld.synchronized!(t,{edits:[]})).toBe(true);
    const before=prepareTerrainWorld(world.terrainWorld,t,[{x:-1,z:-1}]);
    const coversTop=(c:typeof before.scene.colliders[number])=>c.shape.kind==='box'&&Math.abs(c.position.x+.5)<c.shape.halfExtents.x&&Math.abs(c.position.z+.5)<c.shape.halfExtents.z&&c.position.y+c.shape.halfExtents.y>.5;
    const old=before.scene.colliders.find(coversTop);expect(old).toBeDefined();
    const edited={edits:[{x:-1,y:0,z:-1,material:0}]};
    expect(world.terrainWorld.synchronized!(t,edited)).toBe(false);
    expect(world.terrainWorld.read(t)).toBe(before);
    world.terrainWorld.sync(t,edited);
    const after=prepareTerrainWorld(world.terrainWorld,t,[{x:-1,z:-1}]);
    expect(after.scene.colliders.some(coversTop)).toBe(false);
    expect(before.scene.colliders).toContain(old);expect(after.revision).not.toBe(before.revision);
  });
  it('warms future voxel chunks without replacing accepted collision or advancing edit identity',()=>{
    const world=createVoxelWorld<{seed:number},{edits:[]}>({field:()=>({bounds,sample:(_x,y)=>y<1?1:0}),seed:t=>t.seed,edits:w=>w?.edits??[]});
    const t={seed:17};world.terrainWorld.sync(t,{edits:[]});
    const before=prepareTerrainWorld(world.terrainWorld,t,[{x:.5,z:.5}]),revision=world.field(t).revision;
    for(let i=0;i<64;i++)world.terrainWorld.prefetch!(t,[{x:20,z:0,velocity:{x:6,z:0}}]);
    expect(world.field(t).chunkPrepared(1,-1)).toBe(true);
    expect(world.terrainWorld.read(t)).toBe(before);expect(world.field(t).revision).toBe(revision);
    expect(world.terrainWorld.prepared(t,[{x:.5,z:.5}])).toBe(true);
  });
});
