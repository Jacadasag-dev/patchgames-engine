import type {PlanetPatchData,PlanetVector} from './planet.ts';
import {PLANET_BIOME_IDS,type CompiledPlanetBiomes} from './planetBiomes.ts';
import {generateMaterial,prepareGeneratedMaterialMipmaps,type GeneratedMaterialPixels,type MaterialGeneratorRecipe} from './materialGenerator.ts';

/** Microstructure is invisible on broad cells. Keep orbital patches indexed and
 * single-material instead of expanding them into biome draw-call groups. */
export const PLANET_SURFACE_DETAIL_MAX_CELL_METERS=32;
/** Average neutral albedo of the generated biome recipes, measured in LINEAR
 * colour space. Match mip-filtered detail instead of applying sRGB brightness
 * as a linear factor, which exposes large polygon steps at terrain LOD changes. */
const coarseAlbedo:Record<typeof PLANET_BIOME_IDS[number],number>={ocean:.5,beach:.46,grassland:.48,'temperate-forest':.44,taiga:.44,'tropical-forest':.44,desert:.46,tundra:.52,alpine:.5};
function typicalSurfaceCellMeters(data:PlanetPatchData):number{
  const segments=Math.round(Math.sqrt(data.surfaceTriangles/2)),p=data.positions;let length=0,count=0;
  const edge=(a:number,b:number)=>{length+=Math.hypot(p[a*3]-p[b*3],p[a*3+1]-p[b*3+1],p[a*3+2]-p[b*3+2]);count++;};
  for(const line of [0,Math.floor(segments/2),segments])for(let i=0;i<segments;i++){edge(line*(segments+1)+i,line*(segments+1)+i+1);edge(i*(segments+1)+line,(i+1)*(segments+1)+line);}
  return count?length/count:Infinity;
}
/** All tiles share a 4m period. Worker-side dominant-normal projection avoids
 * polar UV pinching and steep cliff stretching, without renderer-specific GLSL.
 * Triangle seams on projection changes are a bounded tradeoff, not triplanar blending. */
export function preparePlanetSurfacePatch(biomes:CompiledPlanetBiomes,data:PlanetPatchData):PlanetPatchData {
  const p=data.positions,n=data.normals,vertexCount=p.length/3,ids:number[]=[],tints:PlanetVector[]=[];
  for(let i=0;i<vertexCount;i++){
    const sample=biomes.sample([data.origin[0]+p[i*3],data.origin[1]+p[i*3+1],data.origin[2]+p[i*3+2]]);
    ids.push(PLANET_BIOME_IDS.indexOf(sample.id));tints.push(sample.color);
  }
  if(typicalSurfaceCellMeters(data)>PLANET_SURFACE_DETAIL_MAX_CELL_METERS){
    const colors=new Float32Array(p.length);for(let i=0;i<vertexCount;i++)for(let axis=0;axis<3;axis++)colors[i*3+axis]=tints[i][axis]*coarseAlbedo[PLANET_BIOME_IDS[ids[i]]];
    return {...data,positions:p,normals:n,indices:data.indices,colors,uvs:undefined,groups:undefined,byteLength:p.byteLength+n.byteLength+colors.byteLength+data.indices.byteLength};
  }
  const count=data.indices.length,positions=new Float32Array(count*3),normals=new Float32Array(count*3),colors=new Float32Array(count*3),uvs=new Float32Array(count*2),indices=new Uint16Array(count);
  const buckets=PLANET_BIOME_IDS.map(()=>[] as number[]),phase=data.origin.map(v=>((v%4)+4)%4);
  for(let k=0;k<count;k+=3){
    const a=data.indices[k],b=data.indices[k+1],c=data.indices[k+2];
    const sums=[0,1,2].map(axis=>Math.abs(n[a*3+axis]+n[b*3+axis]+n[c*3+axis]));
    const axis=sums[0]>=sums[1]&&sums[0]>=sums[2]?0:sums[1]>=sums[2]?1:2;
    const axes=axis===0?[2,1]:axis===1?[0,2]:[0,1];
    const material=ids[a]===ids[b]||ids[a]===ids[c]?ids[a]:ids[b]===ids[c]?ids[b]:ids[a];
    buckets[material].push(k,k+1,k+2);
    for(let corner=0;corner<3;corner++){
      const source=data.indices[k+corner],target=k+corner;
      for(let j=0;j<3;j++){positions[target*3+j]=p[source*3+j];normals[target*3+j]=n[source*3+j];colors[target*3+j]=tints[source][j];}
      uvs[target*2]=p[source*3+axes[0]]+phase[axes[0]];uvs[target*2+1]=p[source*3+axes[1]]+phase[axes[1]];
    }
  }
  const groups:NonNullable<PlanetPatchData['groups']>=[];let start=0;
  for(let materialIndex=0;materialIndex<buckets.length;materialIndex++){const bucket=buckets[materialIndex];if(!bucket.length)continue;indices.set(bucket,start);groups.push({start,count:bucket.length,materialIndex});start+=bucket.length;}
  return {...data,positions,normals,colors,uvs,indices,groups,byteLength:positions.byteLength+normals.byteLength+colors.byteLength+uvs.byteLength+indices.byteLength};
}
/** Engine material recipes, never downloaded terrain texture packs. Tint remains
 * a smooth biome field; reusable neutral microstructure supplies colour/normal/roughness. */
export function planetSurfaceMaterialRecipes(seed:number,resolution:64|128|256=128):MaterialGeneratorRecipe[]{
  return PLANET_BIOME_IDS.map((id,i)=>({name:'Planet '+id,seed:seed+i,tileMeters:[4,4],color:'#d8d5c8',secondaryColor:'#aaa99b',variation:.24,reliefMeters:.025,roughness:.95,output:{resolution,style:'realistic'},pattern:
    id==='beach'||id==='desert'?{family:'dirt',grainMeters:.018,clumping:.22,moisture:0,stones:.08}:
    id==='alpine'||id==='ocean'?{family:'rock',grainMeters:.18,fractures:.25,layering:.2}:
    id==='taiga'||id==='temperate-forest'||id==='tropical-forest'?{family:'dirt',grainMeters:.05,clumping:.6,moisture:.35,stones:.16}:
    id==='tundra'?{family:'gravel',stoneMeters:.08,roundness:.4,sizeVariation:.7}:{family:'grass',bladeMeters:.035,density:.75,dryness:.15,barePatches:.22}}));
}
export async function bakePlanetSurfaceMaterials(seed:number,resolution:64|128|256=128,signal?:AbortSignal):Promise<GeneratedMaterialPixels[]>{
  const results:GeneratedMaterialPixels[]=[];for(const recipe of planetSurfaceMaterialRecipes(seed,resolution)){if(signal?.aborted)throw Error('Planet surface preparation aborted.');results.push(prepareGeneratedMaterialMipmaps(await generateMaterial(recipe,{signal})));}return results;
}
