/** Additive finite-thickness terrain. Ordinary heightfields stay unchanged;
 * these slabs supply real cave roofs, overhangs, holes and support planes. */
import {PHYSICS_SCENE_LIMITS,type PhysicsCollider,type PhysicsScene,type PhysicsVector} from './physics.ts';

export const TERRAIN_VOLUME_LIMITS=Object.freeze({slabs:8,cells:512,samples:1089,axisCells:32,colliders:96});
export interface TerrainVolumeSlab {
  id:string;
  /** Center of the XZ footprint. Sample elevations are relative to origin.y. */
  origin?:PhysicsVector;
  width:number;depth:number;columns:number;rows:number;
  /** Native column-major vertex samples: column * (rows + 1) + row. */
  top:number[];bottom:number[];
  /** Omitted complete cells, indexed column * rows + row. */
  holes?:number[];
  color?:string;
}
export interface TerrainVolumesRecipe {id:string;slabs:TerrainVolumeSlab[]}
export interface TerrainVolumeSupportPatch {
  id:string;colliderId:string;
  /** Upward-oriented triangle; the same h10–h01 diagonal as native terrain. */
  vertices:[PhysicsVector,PhysicsVector,PhysicsVector];
}
export interface TerrainVolumeSurface {
  positions:number[];normals:number[];
  /** One tag per triangle. Internal cell boundaries have no visible side wall. */
  kinds:('top'|'underside'|'side')[];slabIds:string[];
}
export interface TerrainVolumesManifest {
  version:1;id:string;revision:string;
  slabs:TerrainVolumeSlab[];colliders:PhysicsCollider[];
  supports:TerrainVolumeSupportPatch[];surface:TerrainVolumeSurface;
}
export interface TerrainVolumeWorld {
  version:1;revision:string;volumes:TerrainVolumesManifest;scene:PhysicsScene;
  supports:TerrainVolumeSupportPatch[];
}
const fail=(message:string):never=>{throw new Error(`Invalid terrain volumes: ${message}`);};
const finite=(n:number,min:number,max:number,label:string)=>{if(!Number.isFinite(n)||n<min||n>max)fail(label);};
const id=(value:string)=>{if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,40}$/.test(value))fail('IDs require 1..40 letters, digits, underscores or hyphens');};
function freeze<T>(value:T):T {if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
const hash=(text:string)=>{let h=2166136261;for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619);return(h>>>0).toString(16);};
function normal(a:PhysicsVector,b:PhysicsVector,c:PhysicsVector):PhysicsVector {
  const x=(b.y-a.y)*(c.z-a.z)-(b.z-a.z)*(c.y-a.y),y=(b.z-a.z)*(c.x-a.x)-(b.x-a.x)*(c.z-a.z),z=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x),n=Math.hypot(x,y,z);
  if(!n)fail('degenerate surface');return{x:x/n,y:y/n,z:z/n};
}

/** Compile exact piecewise-planar solid prisms. Coplanar cells merge only when
 * every supplied sample agrees exactly with the same top and bottom planes.
 * Geometry exceeding the native small-scene budget fails, never truncates. */
export function compileTerrainVolumes(recipe:TerrainVolumesRecipe):TerrainVolumesManifest {
  if(!recipe||!Array.isArray(recipe.slabs)||!recipe.slabs.length||recipe.slabs.length>TERRAIN_VOLUME_LIMITS.slabs)fail('slab count');id(recipe.id);
  const ids=new Set<string>();let cellCount=0;
  const slabs=recipe.slabs.map(source=>{
    id(source.id);if(ids.has(source.id))fail('duplicate slab ID');ids.add(source.id);
    finite(source.width,.04,1000,'width');finite(source.depth,.04,1000,'depth');
    for(const n of [source.columns,source.rows])if(!Number.isInteger(n)||n<1||n>TERRAIN_VOLUME_LIMITS.axisCells)fail('grid dimensions');
    const count=(source.columns+1)*(source.rows+1);if(count>TERRAIN_VOLUME_LIMITS.samples||!Array.isArray(source.top)||!Array.isArray(source.bottom)||source.top.length!==count||source.bottom.length!==count)fail('sample dimensions');
    cellCount+=source.columns*source.rows;if(cellCount>TERRAIN_VOLUME_LIMITS.cells)fail('cell budget');
    const origin={...(source.origin??{x:0,y:0,z:0})};for(const axis of ['x','y','z'] as const)finite(origin[axis],-9000,9000,'origin');
    for(let i=0;i<count;i++){finite(source.top[i],-1000,1000,'top elevation');finite(source.bottom[i],-1000,1000,'bottom elevation');if(source.top[i]-source.bottom[i]<.002)fail('slabs require at least 2mm of positive thickness');}
    const holes=[...(source.holes??[])];if(holes.some((n,i)=>!Number.isInteger(n)||n<0||n>=source.columns*source.rows||holes.indexOf(n)!==i))fail('hole cells');holes.sort((a,b)=>a-b);
    if(source.color!==undefined&&!/^#[\da-fA-F]{6}$/.test(source.color))fail('color must be #rrggbb');
    return{...source,origin,top:source.top.slice(),bottom:source.bottom.slice(),holes,color:source.color??'#79956a'};
  });
  const colliders:PhysicsCollider[]=[],supports:TerrainVolumeSupportPatch[]=[],surface:TerrainVolumeSurface={positions:[],normals:[],kinds:[],slabIds:[]};
  const triangle=(slabId:string,kind:TerrainVolumeSurface['kinds'][number],a:PhysicsVector,b:PhysicsVector,c:PhysicsVector)=>{
    const n=normal(a,b,c);for(const p of [a,b,c]){surface.positions.push(p.x,p.y,p.z);surface.normals.push(n.x,n.y,n.z);}surface.kinds.push(kind);surface.slabIds.push(slabId);
  };
  for(const slab of slabs){
    const {columns,rows,origin}=slab,omitted=new Set(slab.holes),used=new Uint8Array(columns*rows),owners:Array<[string,string]>=Array(columns*rows);
    const sample=(field:number[],x:number,z:number)=>field[x*(rows+1)+z];
    const point=(field:number[],x:number,z:number):PhysicsVector=>({x:origin.x+(x/columns-.5)*slab.width,y:origin.y+sample(field,x,z),z:origin.z+(z/rows-.5)*slab.depth});
    const prism=(points:PhysicsVector[],suffix:string):string=>{
      if(colliders.length>=TERRAIN_VOLUME_LIMITS.colliders)fail('native collider budget exceeded; reduce sampled detail or split the prepared scene');
      const colliderId=`tv:${recipe.id}:${slab.id}:${suffix}`,position={x:0,y:0,z:0};
      for(const p of points){position.x+=p.x/points.length;position.y+=p.y/points.length;position.z+=p.z/points.length;}
      const vertices=points.map(p=>({x:p.x-position.x,y:p.y-position.y,z:p.z-position.z}));
      if(vertices.some(p=>Math.max(Math.abs(p.x),Math.abs(p.y),Math.abs(p.z))>1000))fail('local prism bounds');
      colliders.push({id:colliderId,position,shape:{kind:'convex',vertices},friction:.8,restitution:0,waterBoundary:false});return colliderId;
    };
    for(let x=0;x<columns;x++)for(let z=0;z<rows;z++){
      const cell=x*rows+z;if(omitted.has(cell)||used[cell])continue;
      const planes=[slab.top,slab.bottom].map(field=>({field,a:sample(field,x,z),dx:sample(field,x+1,z)-sample(field,x,z),dz:sample(field,x,z+1)-sample(field,x,z)}));
      const fits=(cx:number,cz:number)=>!omitted.has(cx*rows+cz)&&!used[cx*rows+cz]&&planes.every(p=>[0,1].every(i=>[0,1].every(j=>sample(p.field,cx+i,cz+j)===p.a+p.dx*(cx+i-x)+p.dz*(cz+j-z))));
      if(fits(x,z)){
        let endX=x+1,endZ=z+1;while(endX<columns&&fits(endX,z))endX++;
        while(endZ<rows&&Array.from({length:endX-x},(_,i)=>x+i).every(cx=>fits(cx,endZ)))endZ++;
        const corners=[[x,z],[endX,z],[endX,endZ],[x,endZ]],colliderId=prism([slab.top,slab.bottom].flatMap(field=>corners.map(([cx,cz])=>point(field,cx,cz))),`r${cell}`);
        for(let cx=x;cx<endX;cx++)for(let cz=z;cz<endZ;cz++){used[cx*rows+cz]=1;owners[cx*rows+cz]=[colliderId,colliderId];}
      }else{
        const corners=[[x,z],[x+1,z],[x,z+1],[x+1,z+1]],points=[slab.top,slab.bottom].map(field=>corners.map(([cx,cz])=>point(field,cx,cz)));
        owners[cell]=([[0,2,1],[3,1,2]] as const).map((indices,i)=>prism(points.flatMap(layer=>indices.map(index=>layer[index])),`c${cell}-${i}`)) as [string,string];used[cell]=1;
      }
    }
    for(let x=0;x<columns;x++)for(let z=0;z<rows;z++){
      const cell=x*rows+z;if(omitted.has(cell))continue;
      const coordinates=[[x,z],[x+1,z],[x,z+1],[x+1,z+1]],top=coordinates.map(([cx,cz])=>point(slab.top,cx,cz)),bottom=coordinates.map(([cx,cz])=>point(slab.bottom,cx,cz));
      for(const [which,indices] of ([[0,[0,2,1]],[1,[3,1,2]]] as const)){
        const vertices=indices.map(i=>top[i]) as [PhysicsVector,PhysicsVector,PhysicsVector];
        supports.push({id:`tv:${recipe.id}:${slab.id}:s${cell}-${which}`,colliderId:owners[cell][which],vertices});triangle(slab.id,'top',...vertices);
        triangle(slab.id,'underside',bottom[indices[0]],bottom[indices[2]],bottom[indices[1]]);
      }
      // Top boundary winding is upward; reverse its perimeter for the sides.
      const edges:[[number,number],number,number][]=[[[0,2],x-1,z],[[2,3],x,z+1],[[3,1],x+1,z],[[1,0],x,z-1]];
      for(const [[a,b],cx,cz] of edges)if(cx<0||cx>=columns||cz<0||cz>=rows||omitted.has(cx*rows+cz)){
        triangle(slab.id,'side',top[a],bottom[a],bottom[b]);triangle(slab.id,'side',top[a],bottom[b],top[b]);
      }
    }
  }
  const canonical=JSON.stringify([recipe.id,slabs]),revision=`terrain-volumes-v1-${hash(canonical)}-${hash('solids:'+canonical)}`;
  return freeze({version:1,id:recipe.id,revision,slabs,colliders,supports,surface});
}

/** Combine with an existing heightfield/streamed terrain scene without changing
 * that scene or its fast path. Explicit solid budgets include existing props. */
export function createTerrainVolumeWorld(baseScene:PhysicsScene,volumes:TerrainVolumesManifest):TerrainVolumeWorld {
  if(volumes.version!==1||!Array.isArray(volumes.colliders)||!Array.isArray(volumes.supports))fail('compiled manifest');
  const count=baseScene.colliders.length+volumes.colliders.length,limit=baseScene.terrainChunks?.length?PHYSICS_SCENE_LIMITS.streamedColliders:PHYSICS_SCENE_LIMITS.colliders;
  if(count>limit)fail(`combined native scene exceeds ${limit} colliders`);
  const colliders=[...baseScene.colliders,...volumes.colliders],ids=new Set<string>();for(const c of colliders)if(c.id){if(ids.has(c.id))fail('combined collider IDs');ids.add(c.id);}
  // Do not recursively freeze caller-owned base terrain/props.
  const scene={...baseScene,colliders};Object.freeze(colliders);Object.freeze(scene);
  return Object.freeze({version:1 as const,revision:`${volumes.revision}-${hash(JSON.stringify(baseScene))}`,volumes,scene,supports:volumes.supports});
}

/** Highest actual slab support below the query's Y, never the uppermost slab
 * irrespective of height. Omitted cells stay holes. This is a support query,
 * not a replacement for native swept collision against tops and undersides. */
export function sampleTerrainVolumes(volumes:TerrainVolumesManifest,point:PhysicsVector,maxDistance=Infinity):{height:number;distance:number;normal:PhysicsVector;slabId:string;colliderId:string}|undefined {
  for(const axis of ['x','y','z'] as const)finite(point[axis],-10000,10000,'query point');if(!(maxDistance>=0)||Number.isNaN(maxDistance))fail('query distance');
  let result:ReturnType<typeof sampleTerrainVolumes>;
  for(const patch of volumes.supports){const [a,b,c]=patch.vertices,det=(b.x-a.x)*(c.z-a.z)-(c.x-a.x)*(b.z-a.z),u=((point.x-a.x)*(c.z-a.z)-(c.x-a.x)*(point.z-a.z))/det,v=((b.x-a.x)*(point.z-a.z)-(point.x-a.x)*(b.z-a.z))/det;
    if(u<0||v<0||u+v>1)continue;const height=a.y+u*(b.y-a.y)+v*(c.y-a.y),distance=point.y-height;
    if(distance<0||distance>maxDistance||result&&height<=result.height)continue;
    result={height,distance,normal:normal(a,b,c),slabId:patch.id.split(':')[2],colliderId:patch.colliderId};
  }return result;
}
