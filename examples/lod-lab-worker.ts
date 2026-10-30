import {compileTerrainChunk,type TerrainManifest,type TerrainRecipe} from '../src/sandbox/terrain.ts';
import {generateFoliage,type FoliageBake} from '../src/sandbox/foliageGenerator.ts';

export interface LodLabPrepared {chunks:TerrainManifest[];tree:FoliageBake;treeCount:number;elapsedMs:number}
export async function prepareLodLab():Promise<LodLabPrepared>{
  const start=performance.now();
  const tree=await generateFoliage({kind:'foliage',version:1,name:'LOD woodland oak',seed:187,quality:'high',
    heightMeters:5.8,crownRadiusMeters:1.7,trunkRadiusMeters:.18,branchLevels:2,branches:4,branchSegments:10,
    branchAngle:1.1,density:35,leafSizeMeters:.45,tipDensity:.85},{resolution:128});
  const bounds=tree.model.bounds,radius=Math.hypot(Math.max(Math.abs(bounds.min[0]),Math.abs(bounds.max[0])),Math.max(Math.abs(bounds.min[2]),Math.abs(bounds.max[2])));
  const recipe:TerrainRecipe={version:1,seed:412,bounds:{width:512,depth:512},streaming:{chunkSize:128,cells:32},
    base:{height:-.4,noise:{amplitude:4,wavelength:88,octaves:3}},
    material:{tileSize:[3,3],texture:{kind:'texture',version:1,name:'Woodland ground',resolution:64,layers:[{source:{kind:'generator',recipe:{pattern:{family:'dirt',grainMeters:.04,stones:.3},tileMeters:[3,3],color:'#718156',secondaryColor:'#364b32',roughness:.95}}}]}},
    assets:[{id:'tree',footprint:{kind:'circle',radius},appearance:{kind:'foliage',height:bounds.max[1]},environment:{wind:{bendRadians:.025,swayHz:.3,flutter:.12,referenceHeight:5.8,sizeExponent:.5}}}],
    regions:[{id:'woodland',mask:{kind:'box',width:512,depth:512,center:{x:0,z:0}},color:'#66815b',layers:[{id:'trees',assets:['tree'],spacing:32,density:.7,scale:[.85,1.15]}]}],
  };
  const chunks:TerrainManifest[]=[];for(let z=-2;z<2;z++)for(let x=-2;x<2;x++){
    const manifest=compileTerrainChunk(recipe,{x,z,size:128,cells:32});
    if(!manifest.diagnostics.valid)throw Error(manifest.diagnostics.issues.map(issue=>issue.code+': '+issue.message).join('\n'));
    chunks.push(manifest);
  }
  return{chunks,tree,treeCount:chunks.reduce((sum,chunk)=>sum+chunk.instances.length,0),elapsedMs:performance.now()-start};
}
if(typeof self!=='undefined')self.onmessage=async()=>{try{
  const result=await prepareLodLab(),buffers=new Set<ArrayBuffer>();
  const collect=(value:unknown)=>{if(ArrayBuffer.isView(value)){if(value.buffer instanceof ArrayBuffer)buffers.add(value.buffer);}else if(value instanceof ArrayBuffer)buffers.add(value);else if(value&&typeof value==='object')for(const child of Object.values(value))collect(child);};
  collect(result);self.postMessage({result},{transfer:[...buffers]});
}catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}};
