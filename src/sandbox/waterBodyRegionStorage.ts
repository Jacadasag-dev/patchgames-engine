/** Exact storage of a connected pool. Submerged terrain contributes one
 * linear term; only pieces intersecting the surface need cut-cell integrals. */
import type {WaterBodyCells} from './waterBodyCells.ts';
import {boundaryRegionLevel,boundaryRegionVolume,boundaryRegionWetArea,type WaterBoundaryRegion} from './waterBoundaryGeometry.ts';

interface Piece {region?:WaterBoundaryRegion;bed:number;occupied:number;low:number;high:number;area:number}
const compiled=new WeakMap<object,Map<string,ReturnType<typeof compileStorage>>>();
const immutableGeometry=new WeakSet<object>();
const capacity=(p:Piece,head:number)=>Math.max(0,(p.region?boundaryRegionVolume(p.region,head):(head-p.bed)*p.area)-p.occupied);
const wetArea=(p:Piece,head:number)=>p.region?(!p.occupied||boundaryRegionVolume(p.region,head)>p.occupied?boundaryRegionWetArea(p.region,head):0):head>p.low?p.area:0;

export function createWaterRegionStorage(c:WaterBodyCells,members:readonly number[]) {
  const immutable=c.mesh&&(immutableGeometry.has(c.mesh)||Object.isFrozen(c.mesh)&&Object.isFrozen(c.mesh.regions)&&c.mesh.regions.every(r=>Object.isFrozen(r)&&Object.isFrozen(r.polygon)&&r.polygon.every(Object.isFrozen)));
  if(immutable)immutableGeometry.add(c.mesh!);
  const key=immutable?members.map(i=>`${i}:${c.solidDepth[i]}`).join(','):undefined;
  let entries=immutable?compiled.get(c.mesh!):undefined;
  if(entries?.has(key!))return entries.get(key!)!;
  // Capture geometry and displacement, never an accessor into an old mutable
  // state. Stable basin descriptors can then survive cloned water checkpoints.
  const pieces=members.map(i=>{
    const source=c.region(i),region=source&&(immutable?source:structuredClone(source)),area=c.area(i),occupied=c.solidDepth[i]*area,bed=c.bed(i),low=region?boundaryRegionLevel(region,occupied):bed+c.solidDepth[i];
    return{region,area,occupied,bed,low,high:region?Math.max(low,...region.polygon.map(p=>p.bed)):low};
  });
  const result=compileStorage(pieces);
  if(immutable){
    if(!entries){entries=new Map();compiled.set(c.mesh!,entries);}
    // Dynamic overtopping can form many unions. Bound reuse without changing
    // the calculation when a descriptor is evicted or never cached.
    if(entries.size>=Math.max(64,Math.min(8192,c.count*2)))entries.delete(entries.keys().next().value!);
    entries.set(key!,result);
  }
  return result;
}

function compileStorage(pieces:Piece[]) {
  const byLow=pieces.slice().sort((a,b)=>a.low-b.low),byHigh=pieces.slice().sort((a,b)=>a.high-b.high);
  const levels=new Float64Array(pieces.length),areas=new Float64Array(pieces.length),volumes=new Float64Array(pieces.length);
  let totalArea=0,totalVolume=0,last=byHigh[0].high;
  for(let k=0;k<byHigh.length;k++){
    const p=byHigh[k];
    // Store each prefix at its own highest bed, using nonnegative increments.
    // A global bed-moment subtraction would lose tiny water volumes far from
    // world zero or above a displaced solid.
    totalVolume+=totalArea*(p.high-last)+capacity(p,p.high);
    totalArea+=p.area;last=p.high;levels[k]=p.high;areas[k]=totalArea;volumes[k]=totalVolume;
  }
  const sample={volume:0,area:0};
  return {
    low:byLow[0].low,high:last,area:totalArea,full:totalVolume,
    evaluate(head:number){
      let lo=0,hi=levels.length;
      while(lo<hi){const mid=(lo+hi)>>>1;if(levels[mid]<=head)lo=mid+1;else hi=mid;}
      const full=lo-1;
      let volume=full<0?0:volumes[full]+areas[full]*(head-levels[full]),area=full<0?0:areas[full];
      // A flat piece (or a fully displaced piece) is still dry exactly at
      // its activation height. Match the storage derivative's convention
      // there, including coincident breakpoints from several pieces.
      for(let k=full;k>=0&&levels[k]===head;k--)area+=wetArea(byHigh[k],head)-byHigh[k].area;
      for(const p of byLow){
        if(p.low>head)break;
        if(p.high<=head)continue;
        const raw=p.region?boundaryRegionVolume(p.region,head):(head-p.bed)*p.area;
        volume+=Math.max(0,raw-p.occupied);area+=p.region?(!p.occupied||raw>p.occupied?boundaryRegionWetArea(p.region,head):0):head>p.low?p.area:0;
      }
      sample.volume=volume;sample.area=area;return sample;
    },
  };
}
