import type {FoliageModel} from './foliageGenerator.ts';
import {generationIdentitySeed} from './generationMaps.ts';

export interface FoliageLodTier {
  level:number;radialSegments:number;axialToleranceMeters:number;
  leafIndices:readonly number[];leafScale:number;leafSegments:readonly[number,number];
  flowerIndices:readonly number[];petals:number;error:number;
}
/** Keep the complete canopy at every distance. Only card tessellation changes:
 * a far leaf is still the same leaf with the same anchor, size and orientation.
 * Stable ordering is retained for batching; no seed or topology is rerolled. */
export function prepareFoliageLod(model:FoliageModel):readonly FoliageLodTier[]{
  if(!model||!Array.isArray(model.leaves)||model.leaves.length>16000||!Array.isArray(model.branches)||model.branches.length>8192
    ||!Array.isArray(model.flowers)||model.flowers.length>256)throw Error('Foliage LOD requires a bounded compiled foliage model.');
  const r=model.recipe,rank=(id:string)=>generationIdentitySeed(r.seed,id,'lod-coverage')>>>0;
  const sorted=model.leaves.map((leaf,index)=>({index,rank:rank(leaf.id),cell:leaf.anchor.map((v,i)=>Math.max(0,Math.min(3,Math.floor((v-model.bounds.min[i])/Math.max(.001,model.bounds.max[i]-model.bounds.min[i])*4)))).join(':')})).sort((a,b)=>a.rank-b.rank||a.index-b.index);
  const cells=new Set<string>(),representatives:number[]=[],rest:number[]=[];
  for(const entry of sorted){if(!cells.has(entry.cell)){cells.add(entry.cell);representatives.push(entry.index);}else rest.push(entry.index);}
  const order=Object.freeze([...representatives,...rest]),flowers=Object.freeze(model.flowers.map((flower,index)=>({index,rank:rank('flower:'+flower.branch+':'+flower.t)})).sort((a,b)=>a.rank-b.rank||a.index-b.index).map(e=>e.index));
  const radius=Math.max(.001,Math.hypot(...model.bounds.max.map((v,i)=>(v-model.bounds.min[i])/2))),sides={low:5,medium:8,high:12}[r.quality];
  const maxLeafScale=Math.max(1,...model.leaves.map(l=>l.sizeScale));
  return Object.freeze([0,1,2,3].map(level=>{
    return Object.freeze({level,radialSegments:Math.max(3,Math.round(sides*[1,.72,.5,.32][level])),axialToleranceMeters:r.heightMeters*[0,.0004,.0015,.004][level],
      leafIndices:order,leafScale:1,leafSegments:Object.freeze((level===0?[2,4]:level===1?[1,2]:[1,1]) as [number,number]),
      flowerIndices:flowers,petals:r.flowers.petals,
      // Flattening can remove the source card's small bend, never its coverage.
      // The renderer refines this bound with the actual canopy sphere.
      error:level===0||!model.leaves.length?0:r.leafSizeMeters*maxLeafScale*.09/radius,
    });
  }));
}

/** Error-bounded polyline simplification. Start/end rings always remain, and
 * source UV distance is retained by the renderer for continuous bark density. */
export function foliageLodPathIndices(points:readonly (readonly number[])[],tolerance:number):number[]{
  if(!Number.isFinite(tolerance)||tolerance<0||points.length<2||points.length>17||points.some(p=>p.length!==3||p.some(v=>!Number.isFinite(v))))throw Error('Invalid bounded foliage LOD path.');
  if(tolerance===0)return points.map((_,i)=>i);
  const result=new Set([0,points.length-1]),pending:[[number,number]]=[[0,points.length-1]];
  while(pending.length){const [a,b]=pending.pop()!,axis=points[b].map((v,i)=>v-points[a][i]),length=axis.reduce((n,v)=>n+v*v,0);let furthest=-1,error=tolerance*tolerance;
    for(let j=a+1;j<b;j++){const offset=points[j].map((v,i)=>v-points[a][i]),t=Math.max(0,Math.min(1,offset.reduce((n,v,i)=>n+v*axis[i],0)/(length||1))),distance=offset.reduce((n,v,i)=>n+(v-t*axis[i])**2,0);if(distance>error){error=distance;furthest=j;}}
    if(furthest>=0){result.add(furthest);pending.push([a,furthest],[furthest,b]);}
  }
  return [...result].sort((a,b)=>a-b);
}
