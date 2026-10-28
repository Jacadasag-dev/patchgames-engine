/** Hydraulic resolution follows the original grid. Terrain triangles remain
 * exact storage quadrature; only separate drainage basins need separate heads. */
import type {WaterBodyCells,WaterCellFace} from './waterBodyCells.ts';

export interface WaterTerrainPartitions {groups:number[][];cell:number[];pinned:Uint8Array}
const cache=new WeakMap<WaterCellFace[],WaterTerrainPartitions>();

export function waterBodyTerrainPartitions(c:Pick<WaterBodyCells,'count'|'parent'|'polygon'>&Partial<Pick<WaterBodyCells,'region'>>,faces:WaterCellFace[]):WaterTerrainPartitions {
  const saved=cache.get(faces);if(saved)return saved;
  const n=c.count,base=Int32Array.from({length:n},(_,i)=>c.parent(i)),count=Math.max(...base)+1,pinned=new Uint8Array(count),low=Float64Array.from({length:n},(_,i)=>Math.min(...c.polygon(i).map(p=>p.bed))),parent=Int32Array.from({length:n},(_,i)=>i);
  const root=(i:number):number=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  // Preserve placement tips, retaining walls, and actual vertical terrain
  // steps at their existing fine resolution. The tolerance is the geometric
  // plane-join tolerance, not a minimum water depth or a film cutoff.
  const tolerance=(...h:number[])=>1e-10*Math.max(1,...h.map(Math.abs));
  for(const f of faces){
    if(f.barrier){pinned[base[f.a]]=1;if(f.b>=0)pinned[base[f.b]]=1;}
    // A validated bulk region uses the original center-bed storage plane.
    // Its edge offset is hydraulic quadrature, not a physical cliff. The
    // compiler keeps both sides of every actual terrain step non-bulk; its
    // standalone exact-geometry pass has no region accessor and checks all
    // joins. Otherwise this artificial step splits an exact drainage basin
    // back into tiny independent triangles next to an ordinary cell.
    if(f.b>=0&&!c.region?.(f.a)?.bulk&&!c.region?.(f.b)?.bulk
      &&(Math.abs(f.bedA0-f.bedB0)>tolerance(f.bedA0,f.bedB0)||Math.abs(f.bedA1-f.bedB1)>tolerance(f.bedA1,f.bedB1))){pinned[base[f.a]]=pinned[base[f.b]]=1;}
  }
  const usable=(f:WaterCellFace)=>f.b>=0&&base[f.a]===base[f.b]&&!pinned[base[f.a]];
  // A flat minimum may span several triangles. Join it only through an
  // opening at that same minimum; equal-height bowls behind a ridge stay apart.
  for(const f of faces)if(usable(f)){
    const a=root(f.a),b=root(f.b),crest=Math.min(f.start.bed,f.end.bed),eps=tolerance(low[a],low[b],crest);
    if(a!==b&&Math.abs(low[a]-low[b])<=eps&&crest<=Math.max(low[a],low[b])+eps){parent[a]=b;low[b]=Math.min(low[a],low[b]);}
  }
  const downstream=new Int32Array(n).fill(-1),best=new Float64Array(n).fill(Infinity);
  for(const f of faces)if(usable(f))for(let side=0;side<2;side++){
    const a=root(side?f.b:f.a),b=root(side?f.a:f.b),crest=Math.min(f.start.bed,f.end.bed),eps=tolerance(low[a],low[b],crest);
    // Every attached piece drains monotonically into its basin. A local bowl
    // cannot cross a higher saddle merely because another bowl has water.
    if(a!==b&&low[b]<low[a]-eps&&crest<=low[a]+eps&&(low[b]<best[a]||low[b]===best[a]&&b<downstream[a])){downstream[a]=b;best[a]=low[b];}
  }
  const basin=(i:number):number=>{i=root(i);while(downstream[i]>=0)i=downstream[i];return i;},groups=new Map<number,number[]>();
  for(let i=0;i<n;i++){const key=basin(i),members=groups.get(key)??[];members.push(i);groups.set(key,members);}
  const result={groups:[...groups.values()],cell:[...groups.values()].map(m=>base[m[0]]),pinned};cache.set(faces,result);return result;
}
