/** Shared physical cell access. Refined regions own water; rectangular arrays
 * remain conservative summaries for old diagnostics and authoring tools. */
import type { WaterBodyManifest, WaterBodyState } from './waterBody.ts';
import type { WaterBodyBarrier, WaterBodyBarrierSpan, WaterBodyGeometry } from './waterBodyGrid.ts';
import { boundaryRegionLevel, boundaryRegionVolume, boundaryRegionWetArea, type BoundaryPoint, type WaterBoundaryRegion, type WaterBoundaryMesh } from './waterBoundaryGeometry.ts';
import { syncBoundarySummary } from './waterBoundary.ts';
const refinedFaces=new WeakMap<object,WaterCellFace[]>();
const movingFaces=new WeakMap<object,{mesh:object;faces:WaterCellFace[]}>();
const bedPlanes=new WeakMap<WaterBoundaryRegion,{x:number;z:number}>();
const levelCaches=new WeakMap<object,{mesh:object;volume:Float64Array;head:Float64Array}>();
const immutableGeometry=new WeakSet<WaterBoundaryMesh>();
function hasImmutableGeometry(mesh:WaterBoundaryMesh):boolean {
  if(immutableGeometry.has(mesh))return true;
  if(!Object.isFrozen(mesh)||!Object.isFrozen(mesh.regions)||!mesh.regions.every(r=>Object.isFrozen(r)&&Object.isFrozen(r.center)&&(!r.solid||Object.isFrozen(r.solid))&&Object.isFrozen(r.polygon)&&r.polygon.every(Object.isFrozen))
    ||!Object.isFrozen(mesh.faces)||!mesh.faces.every(f=>Object.isFrozen(f)&&Object.isFrozen(f.start)&&Object.isFrozen(f.end))||!Object.isFrozen(mesh.cells)||!mesh.cells.every(Object.isFrozen))return false;
  immutableGeometry.add(mesh);return true;
}

export interface WaterCellFace {
  a: number; b: number; nx: number; nz: number; length: number; distance: number;
  start: BoundaryPoint; end: BoundaryPoint; barrier?: WaterBodyBarrier;
  /** Unshifted bed on each side, independent of the face's barrier crest. */
  bedA0:number;bedA1:number;bedB0:number;bedB1:number;
  /** Actual tangential contact spans of a coarse retaining-sheet proxy. */
  loads?: WaterBodyBarrierSpan[];
}
export interface WaterCellBounds { min: { x: number; z: number }; max: { x: number; z: number } }
export function waterBodyCells(w: WaterBodyManifest, s: WaterBodyState) {
  const boundary = s.boundary, mesh = boundary?.mesh, count = mesh?.regions.length ?? s.depth.length;
  const area = (i: number) => mesh?.regions[i].area ?? w.cellArea;
  const parent = (i: number) => mesh?.regions[i].cell ?? i;
  const center = (i: number) => mesh?.regions[i].center ?? { x: w.origin.x + (Math.floor(i / w.rows) + .5) * w.cellSizeX, z: w.origin.z + (i % w.rows + .5) * w.cellSizeZ };
  const volume = (i: number) => boundary ? boundary.volume[i] : s.depth[i] * w.cellArea;
  const depth = (i: number) => boundary ? boundary.volume[i] / area(i) : s.depth[i];
  const solidDepth = (boundary ? boundary.solidDepth : s.solidDepth) ?? Array(count).fill(0);
  const immutable=mesh&&hasImmutableGeometry(mesh);
  let levelCache=boundary&&immutable?levelCaches.get(boundary):undefined;
  if(boundary&&mesh&&immutable&&levelCache?.mesh!==mesh){levelCache={mesh,volume:new Float64Array(count).fill(NaN),head:new Float64Array(count)};levelCaches.set(boundary,levelCache);}
  // Many feature stages read the same surface repeatedly. Cache by the exact
  // occupied volume, so pours, drains, hull displacement and remaps invalidate
  // naturally without a dirty flag or a stale coarse-cell approximation.
  const levelAtVolume = (i:number,v:number) => {
    if(!mesh)return s.bed[i]+v/area(i)+solidDepth[i];
    const occupied=v+solidDepth[i]*area(i);
    if(levelCache?.volume[i]===occupied)return levelCache.head[i];
    const head=boundaryRegionLevel(mesh.regions[i],occupied);
    if(levelCache){levelCache.volume[i]=occupied;levelCache.head[i]=head;}return head;
  };
  const level = (i: number) => levelAtVolume(i,volume(i));
  const bed = (i: number) => mesh?.regions[i].bedMin ?? s.bed[i];
  const bedAt = (i: number, x: number, z: number) => {
    if (!mesh) return s.bed[i];
    const region=mesh.regions[i],p=region.polygon,a=p[0];let plane=bedPlanes.get(region);
    if(!plane){let largest=0;
    for (let k = 1; k + 1 < p.length; k++) {
      const b = p[k], c = p[k + 1], det = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
      if(Math.abs(det)>largest){largest=Math.abs(det);plane={x:((b.bed-a.bed)*(c.z-a.z)-(c.bed-a.bed)*(b.z-a.z))/det,z:((b.x-a.x)*(c.bed-a.bed)-(c.x-a.x)*(b.bed-a.bed))/det};}
    }
    if(plane&&Object.isFrozen(region)&&Object.isFrozen(p)&&p.every(Object.isFrozen))bedPlanes.set(region,plane);}
    return plane?a.bed+plane.x*(x-a.x)+plane.z*(z-a.z):bed(i);
  };
  const polygon = (i: number): BoundaryPoint[] => {
    if (mesh) return mesh.regions[i].polygon;
    const x = w.origin.x + Math.floor(i / w.rows) * w.cellSizeX, z = w.origin.z + (i % w.rows) * w.cellSizeZ, b = s.bed[i];
    return [{ x, z, bed: b }, { x: x + w.cellSizeX, z, bed: b }, { x: x + w.cellSizeX, z: z + w.cellSizeZ, bed: b }, { x, z: z + w.cellSizeZ, bed: b }];
  };
  const inCell = (i: number) => mesh ? mesh.cells[i] : [i];
  const locate = (p: { x: number; z: number }): number | undefined => {
    const u=(p.x-w.origin.x)/w.cellSizeX,v=(p.z-w.origin.z)/w.cellSizeZ;
    if(!Number.isFinite(u)||!Number.isFinite(v)||u<0||v<0||u>w.columns||v>w.rows)return;
    const x=Math.min(w.columns-1,Math.floor(u)),z=Math.min(w.rows-1,Math.floor(v));
    let found:number|undefined,foundBed:number|undefined;
    for(const i of inCell(x*w.rows+z)){
      const poly = polygon(i); let sign = 0;
      let inside=true;
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k], b = poly[(k + 1) % poly.length], cross = (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
        if (Math.abs(cross) > 1e-10) { if (sign && Math.sign(cross) !== sign) {inside=false;break;} sign = Math.sign(cross); }
      }
      if(!inside)continue;
      if(found===undefined){found=i;continue;}
      const candidateBed=bedAt(i,p.x,p.z);foundBed??=bedAt(found,p.x,p.z);
      if(candidateBed>foundBed){found=i;foundBed=candidateBed;}
    }
    return found;
  };
  function indices(bounds: WaterCellBounds): number[] {
    const result: number[] = [], x0 = Math.max(0, Math.floor((bounds.min.x - w.origin.x) / w.cellSizeX)), x1 = Math.min(w.columns - 1, Math.floor((bounds.max.x - w.origin.x) / w.cellSizeX));
    const z0 = Math.max(0, Math.floor((bounds.min.z - w.origin.z) / w.cellSizeZ)), z1 = Math.min(w.rows - 1, Math.floor((bounds.max.z - w.origin.z) / w.cellSizeZ));
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (const i of inCell(x * w.rows + z)) result.push(i);
    return result;
  }
  function faces(geometry?: WaterBodyGeometry): WaterCellFace[] {
    const saved = (value: string): WaterBodyBarrier | undefined => {
      if (!value) return;
      const parts=value.split('|'),top=Number(parts.pop()),bottom=Number(parts.pop());
      let id=parts.join('|'),dynamic=false,domain=false;if(id.startsWith('@moving|')){dynamic=true;id=id.slice(8);}else if(id.startsWith('@domain|')){domain=true;id=id.slice(8);}else if(id.startsWith('@fixed|'))id=id.slice(7);
      // Old checkpoints with only an id retain their closed-face meaning.
      return Number.isFinite(top)&&Number.isFinite(bottom)?{id,top,bottom,dynamic,...(domain?{domain:true as const}:{})}:{id:value,bottom:-Infinity,top:Infinity};
    };
    if (mesh) {const cached=geometry&&immutable?movingFaces.get(geometry):undefined;if(cached?.mesh===mesh)return cached.faces;
      let result=refinedFaces.get(mesh);if(!result){result=mesh.faces.map(f => {
      const a = center(f.a), b = f.b < 0 ? a : center(f.b), solid = f.b < 0 ? undefined : mesh.regions[f.a].solid ?? mesh.regions[f.b].solid;
      const bedA0=bedAt(f.a,f.start.x,f.start.z),bedA1=bedAt(f.a,f.end.x,f.end.z),bedB0=f.b<0?bedA0:bedAt(f.b,f.start.x,f.start.z),bedB1=f.b<0?bedA1:bedAt(f.b,f.end.x,f.end.z);
      if(f.closed)return{...f,bedA0,bedA1,bedB0,bedB1,distance:Math.max(Math.min(w.cellSizeX,w.cellSizeZ)*.05,Math.abs((b.x-a.x)*f.nx+(b.z-a.z)*f.nz)),barrier:{id:'water-support-interface',bottom:-10000,top:10001,domain:true as const},loads:[],start:{...f.start,bed:10001},end:{...f.end,bed:10001}};
      return { ...f, bedA0,bedA1,bedB0,bedB1,distance: Math.max(Math.min(w.cellSizeX, w.cellSizeZ) * .05, Math.abs((b.x - a.x) * f.nx + (b.z - a.z) * f.nz)), ...(solid ? { barrier: { id: solid.id, bottom: solid.bottom, top: solid.top } } : {}) };
      });if(immutable)refinedFaces.set(mesh,result);}
      // Preserve the existing retaining-sheet proxy for moving/tilted sheets
      // that are handled by volumetric coupling. Exact embedded static walls
      // must never acquire an additional coarse wall on a nearby grid face.
      const embedded=new Set([...mesh.regions.flatMap(r=>r.solid?[r.solid.id]:[]),...(mesh.supportLayer===undefined?[]:w.placementSupports?.patches.flatMap(p=>p.colliderId?[p.colliderId]:[])??[])]),bx=geometry?.x??s.barrierX.map(saved),bz=geometry?.z??s.barrierZ.map(saved);
      if([...bx,...bz].some(b=>b&&(b.dynamic||!embedded.has(b.id))))result=result.map(f=>{
        if(f.barrier?.domain)return f;
        const x=(f.start.x+f.end.x)*.5,z=(f.start.z+f.end.z)*.5,u=(x-w.origin.x)/w.cellSizeX,v=(z-w.origin.z)/w.cellSizeZ;
        let proxy:WaterBodyBarrier|undefined,loads:WaterBodyBarrierSpan[]|undefined;
        if(Math.abs(f.nx)>1-1e-9&&Math.abs(u-Math.round(u))<1e-8){const i=Math.round(u)*w.rows+Math.min(w.rows-1,Math.floor(v));proxy=bx[i];loads=geometry?.loadsX[i];}
        if(Math.abs(f.nz)>1-1e-9&&Math.abs(v-Math.round(v))<1e-8){const i=Math.min(w.columns-1,Math.floor(u))*(w.rows+1)+Math.round(v);proxy=bz[i];loads=geometry?.loadsZ[i];}
        if(!proxy||!proxy.dynamic&&embedded.has(proxy.id)||proxy.top<Math.min(f.start.bed,f.end.bed))return f;
        const lo=Math.min(Math.abs(f.nx)>.5?f.start.z:f.start.x,Math.abs(f.nx)>.5?f.end.z:f.end.x),hi=Math.max(Math.abs(f.nx)>.5?f.start.z:f.start.x,Math.abs(f.nx)>.5?f.end.z:f.end.x);
        loads=loads?.map(load=>({...load,start:Math.max(lo,load.start),end:Math.min(hi,load.end)})).filter(load=>load.end>load.start);
        return{...f,barrier:proxy,...(proxy.domain?{loads:[]}:loads?{loads}:{}),start:{...f.start,bed:Math.max(f.start.bed,proxy.top)},end:{...f.end,bed:Math.max(f.end.bed,proxy.top)}};
      });
      if(geometry&&immutable)movingFaces.set(geometry,{mesh,faces:result});return result;
    }
    const result: WaterCellFace[] = [];
    const add = (a: number, b: number, nx: number, nz: number, x: number, z: number, length: number, distance: number, barrier?: WaterBodyBarrier) => {
      const height = Math.max(a < 0 ? -Infinity : bed(a), b < 0 ? -Infinity : bed(b), barrier?.top ?? -Infinity);
      const own=bed(a<0?b:a),other=a<0||b<0?own:bed(b);
      result.push({ a: a < 0 ? b : a, b: a < 0 ? -1 : b, nx: a < 0 ? -nx : nx, nz: a < 0 ? -nz : nz, length, distance, start: { x: x - nz * length / 2, z: z - nx * length / 2, bed: height }, end: { x: x + nz * length / 2, z: z + nx * length / 2, bed: height }, bedA0:own,bedA1:own,bedB0:other,bedB1:other,barrier });
    };
    for (let x = 0; x <= w.columns; x++) for (let z = 0; z < w.rows; z++) add(x ? (x - 1) * w.rows + z : -1, x < w.columns ? x * w.rows + z : -1, 1, 0, w.origin.x + x * w.cellSizeX, w.origin.z + (z + .5) * w.cellSizeZ, w.cellSizeZ, w.cellSizeX, geometry?geometry.x[x * w.rows + z]:saved(s.barrierX[x*w.rows+z]));
    for (let x = 0; x < w.columns; x++) for (let z = 0; z <= w.rows; z++) add(z ? x * w.rows + z - 1 : -1, z < w.rows ? x * w.rows + z : -1, 0, 1, w.origin.x + (x + .5) * w.cellSizeX, w.origin.z + z * w.cellSizeZ, w.cellSizeX, w.cellSizeZ, geometry?geometry.z[x * (w.rows + 1) + z]:saved(s.barrierZ[x*(w.rows+1)+z]));
    return result;
  }
  return { count, area, parent, center, volume, depth, bed, bedAt, level, levelAtVolume, polygon, inCell, locate, indices, faces, solidDepth,
    /** Geometry identity for immutable compiled storage/partition caches. */
    mesh,region:(i:number)=>mesh?.regions[i],
    flowX: boundary?.flowX ?? s.flowX, flowZ: boundary?.flowZ ?? s.flowZ,
    capacityAtHead: (i: number, head: number) => {
      if(mesh){const volume=boundaryRegionVolume(mesh.regions[i],head);return solidDepth[i]?Math.max(0,volume-solidDepth[i]*mesh.regions[i].area):volume;}
      return Math.max(0,(head-s.bed[i])*w.cellArea-solidDepth[i]*w.cellArea);
    },
    wetAreaAtHead: (i:number,head:number) => {
      if(!mesh)return head>s.bed[i]+solidDepth[i]?w.cellArea:0;
      // Riverbeds have no displaced solid volume. Their exact derivative
      // needs no second volume integral during every shoreline Newton step.
      if(!solidDepth[i])return boundaryRegionWetArea(mesh.regions[i],head);
      return boundaryRegionVolume(mesh.regions[i],head)>solidDepth[i]*mesh.regions[i].area?boundaryRegionWetArea(mesh.regions[i],head):0;
    },
    setVolume(i: number, v: number) { if (boundary) boundary.volume[i] = v; else s.depth[i] = v / w.cellArea; },
    wake(i: number) { s.sleeping[parent(i)] = false; s.quietTime[parent(i)] = 0; },
    commit() { if (boundary) { boundary.solidDepth=solidDepth;syncBoundarySummary(w, s); const coarse = s.solidDepth ??= Array(w.columns * w.rows).fill(0); coarse.fill(0); for (let i = 0; i < count; i++) coarse[parent(i)] += solidDepth[i] * area(i) / w.cellArea; } else if(s.solidDepth||solidDepth.some(v=>v!==0))s.solidDepth=solidDepth; },
  };
}
export type WaterBodyCells = ReturnType<typeof waterBodyCells>;
