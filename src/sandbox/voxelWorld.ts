import {createTerrainWorld,type TerrainWorldHost} from './terrainWorld.ts';
import {VoxelField,type VoxelEdit,type VoxelFieldOptions} from './voxels.ts';

export interface VoxelWorldOptions<T,W> {
  field:(tuning:T)=>VoxelFieldOptions;
  seed:(tuning:T)=>number;
  edits:(world:W|undefined)=>readonly VoxelEdit[];
}
/** A voxel solid layer over a real, unmineable bedrock heightfield. The ordinary
 * terrain worker prepares native column boxes outside ticks and transfers the
 * same accepted scene to prediction. No competing movement/collision solver.
 * Expose terrainWorld on both GameLogic and GameView, as with other worlds. */
export function createVoxelWorld<T,W>(options:VoxelWorldOptions<T,W>):{terrainWorld:TerrainWorldHost<T>;field:(tuning:T)=>VoxelField}{
  let current:VoxelField|undefined,tuningKey='';
  const field=(tuning:T)=>{
    const key=JSON.stringify(tuning);
    if(!current||key!==tuningKey){current=new VoxelField(options.field(tuning));tuningKey=key;}
    return current;
  };
  const terrainWorld=createTerrainWorld<T,W>(tuning=>{
    const f=field(tuning),b=f.bounds;
    if(b.minX!==-b.maxX||b.minZ!==-b.maxZ||f.chunkSize!==32)throw new Error('Streamed voxel worlds require centered XZ bounds and 32-cell chunks.');
    return{version:1,seed:options.seed(tuning),bounds:{width:b.maxX-b.minX,depth:b.maxZ-b.minZ},base:{height:b.minY},
      assets:[],regions:[],streaming:{chunkSize:f.chunkSize,cells:16}};
  },{
    localColliders:true,
    collisionChunks:(tuning,chunks)=>chunks.map(c=>({x:c.x,z:c.z,colliders:field(tuning).chunkColliders(c.x,c.z)})),
    colliders:(tuning,manifest)=>{const f=field(tuning),p=manifest.origin??{x:0,z:0},b=f.bounds;
      // Finite worlds own their perimeter collision on authority and prediction.
      // Native walls stop swept capsules before their next preparation interest
      // leaves the declared world; no game-specific coordinate clamp is needed.
      const y=(b.minY+b.maxY)/2,h=(b.maxY-b.minY)/2+128,size=f.chunkSize,cx=Math.floor(p.x/size),cz=Math.floor(p.z/size);
      const x0=Math.max(b.minX,cx*size),x1=Math.min(b.maxX,(cx+1)*size),z0=Math.max(b.minZ,cz*size),z1=Math.min(b.maxZ,(cz+1)*size);
      const walls:import('./physics.ts').PhysicsCollider[]=[];
      for(const x of [b.minX,b.maxX])if(x>=cx*size&&x<=(cx+1)*size)walls.push({id:`voxel:edge:x:${x}:${cz}`,
        position:{x:x+(x===b.minX?-.5:.5),y,z:(z0+z1)/2},shape:{kind:'box',halfExtents:{x:.5,y:h,z:(z1-z0)/2+.5}}});
      for(const z of [b.minZ,b.maxZ])if(z>=cz*size&&z<=(cz+1)*size)walls.push({id:`voxel:edge:z:${z}:${cx}`,
        position:{x:(x0+x1)/2,y,z:z+(z===b.minZ?-.5:.5)},shape:{kind:'box',halfExtents:{x:(x1-x0)/2+.5,y:h,z:.5}}});
      return [...f.chunkColliders(cx,cz),...walls];},
    collisionEdits:(world,tuning)=>{const f=field(tuning);
      if(projection(tuning,world)!==projected||f.revision!==projectedFieldRevision)f.setEdits(options.edits(world));
      return f.collisionEdits();},
    collisionIdentity:(value,tuning)=>JSON.stringify([tuning,options.edits(value)]),
  });
  // The generic host validates and snapshots collider edits. Keep that work in
  // preparation: readyTerrain also calls sync at the start of a 100ms tick.
  // Compare serialized sparse state, never mutable object identity.
  const sync=terrainWorld.sync.bind(terrainWorld);let projected:string|undefined,projectedFieldRevision=-1;
  terrainWorld.backgroundPreparation=true;
  const projection=(tuning:T,value:unknown)=>JSON.stringify([tuning,options.edits(value as W|undefined)]);
  terrainWorld.editIdentity=projection;
  terrainWorld.synchronized=(tuning,value)=>projection(tuning,value)===projected&&field(tuning).revision===projectedFieldRevision;
  terrainWorld.sync=(tuning,value)=>{const next=projection(tuning,value);if(next===projected&&field(tuning).revision===projectedFieldRevision)return;field(tuning).setEdits(options.edits(value as W|undefined));sync(tuning,value);projected=next;projectedFieldRevision=field(tuning).revision;};
  terrainWorld.prefetch=(tuning,interests)=>{
    const f=field(tuning),size=f.chunkSize,points=interests?.length?interests:[{x:0,z:0}];
    const wanted=new Map<string,{x:number;z:number;distance:number}>();
    for(const p of points){
      const aheadX=p.x+(p.velocity?.x??0)*3,aheadZ=p.z+(p.velocity?.z??0)*3,radius=(p.radius??size/4)+size/2;
      const minX=Math.floor(Math.max(f.bounds.minX,Math.min(p.x,aheadX)-radius)/size),maxX=Math.ceil(Math.min(f.bounds.maxX,Math.max(p.x,aheadX)+radius)/size)-1;
      const minZ=Math.floor(Math.max(f.bounds.minZ,Math.min(p.z,aheadZ)-radius)/size),maxZ=Math.ceil(Math.min(f.bounds.maxZ,Math.max(p.z,aheadZ)+radius)/size)-1;
      for(let x=minX;x<=maxX;x++)for(let z=minZ;z<=maxZ;z++){
        const k=`${x}:${z}`,distance=Math.hypot((x+.5)*size-aheadX,(z+.5)*size-aheadZ),old=wanted.get(k);
        if(!old||distance<old.distance)wanted.set(k,{x,z,distance});
        if(wanted.size>4096)throw new Error('Voxel prefetch interest exceeds its work budget.');
      }
    }
    const candidates=[...wanted.values()].sort((a,b)=>a.distance-b.distance||a.x-b.x||a.z-b.z).slice(0,128);
    const missing=candidates.filter(c=>!f.chunkPrepared(c.x,c.z));
    if(missing.length)f.prepareChunk(missing[0].x,missing[0].z,32);
    return{ready:missing.length===0,pending:missing.length,revision:'voxel-prefetch',loadedRevision:'voxel-prefetch'};
  };
  const prepare=terrainWorld.prepare.bind(terrainWorld);
  const prepareUnits=(tuning:T,interests:readonly import('./terrainStreaming.ts').TerrainInterest[]|undefined,includeInitial:boolean,units:number)=>{
    const f=field(tuning),size=f.chunkSize,points=interests?.length?[...interests]:[{x:0,z:0}];
    if(includeInitial&&interests?.length)points.push({x:0,z:0});
    const chunks=new Map<string,{x:number;z:number}>();
    for(const p of points){const radius=(p.radius??size/4)+size/16,
      endX=p.x+(p.velocity?.x??0)*.5,endZ=p.z+(p.velocity?.z??0)*.5;
      const minX=Math.floor(Math.max(f.bounds.minX,Math.min(p.x,endX)-radius)/size),maxX=Math.ceil(Math.min(f.bounds.maxX,Math.max(p.x,endX)+radius)/size)-1;
      const minZ=Math.floor(Math.max(f.bounds.minZ,Math.min(p.z,endZ)-radius)/size),maxZ=Math.ceil(Math.min(f.bounds.maxZ,Math.max(p.z,endZ)+radius)/size)-1;
      for(let x=minX;x<=maxX;x++)for(let z=minZ;z<=maxZ;z++)chunks.set(`${x}:${z}`,{x,z});
    }
    if(chunks.size>128)throw new Error('Voxel preparation exceeds the 128 active chunk budget.');
    for(const c of chunks.values())if(!f.prepareChunk(c.x,c.z,units))return{ready:false,pending:chunks.size,revision:'voxel-preparing',loadedRevision:'voxel-preparing'};
    return prepare(tuning,interests,includeInitial);
  };
  terrainWorld.prepare=(tuning,interests,includeInitial=false)=>prepareUnits(tuning,interests,includeInitial,128);
  terrainWorld.prepareFrame=(tuning,interests)=>prepareUnits(tuning,interests,false,16);
  let importedField:VoxelField|undefined;const importedSources=new Set<string>();
  terrainWorld.importCollisionChunk=(tuning,chunk,manifest)=>{
    const f=field(tuning);if(importedField!==f){importedSources.clear();importedField=f;}
    const key=`${chunk.x}:${chunk.z}`;
    if(!importedSources.has(key)||!f.chunkPrepared(chunk.x,chunk.z)){
      f.importCollisionChunk(chunk.x,chunk.z,chunk.colliders);
      if(importedSources.size>=256)importedSources.delete(importedSources.values().next().value!);
      importedSources.add(key);
    }
    return manifest?terrainWorld.primeCollisionSource?.(tuning,manifest)!:true;
  };
  let adoptedTuning='',activeChunks=new Set<string>();
  const adopt=terrainWorld.adoptPrepared.bind(terrainWorld);
  terrainWorld.adoptPrepared=(tuning,cache,verified)=>{
    const result=adopt(tuning,cache,verified);
    adoptedTuning=JSON.stringify(tuning);activeChunks=new Set(cache.streamed?.chunks.map(c=>`${c.x}:${c.z}`));
    return result;
  };
  terrainWorld.prepareLocalEdits=(tuning,world,interests)=>{
    if(JSON.stringify(tuning)!==adoptedTuning||!activeChunks.size)return;
    const f=field(tuning),size=f.chunkSize;
    for(const p of interests){
      const radius=(p.radius??size/4)+size/16,endX=p.x+(p.velocity?.x??0)*.5,endZ=p.z+(p.velocity?.z??0)*.5;
      const minX=Math.floor(Math.max(f.bounds.minX,Math.min(p.x,endX)-radius)/size),maxX=Math.ceil(Math.min(f.bounds.maxX,Math.max(p.x,endX)+radius)/size)-1;
      const minZ=Math.floor(Math.max(f.bounds.minZ,Math.min(p.z,endZ)-radius)/size),maxZ=Math.ceil(Math.min(f.bounds.maxZ,Math.max(p.z,endZ)+radius)/size)-1;
      for(let x=minX;x<=maxX;x++)for(let z=minZ;z<=maxZ;z++)if(!activeChunks.has(`${x}:${z}`)||!f.chunkPrepared(x,z))return;
    }
    terrainWorld.sync(tuning,world);
    return terrainWorld.prepareCollisionEdits?.(tuning);
  };
  return{terrainWorld,field};
}
