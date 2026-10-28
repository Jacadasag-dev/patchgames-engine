/** Partial cells are only placement footprints. All terrain, including slopes,
 * ridges and cliffs, retains the original center-bed rectangular hydraulics. */
import type {PhysicsScene} from './physics.ts';
import type {WaterBodyManifest} from './waterBody.ts';
import {waterBodyGeometry} from './waterBodyGrid.ts';
import {compileWaterPlacementBoundaryMesh,validateWaterBoundaryMesh,type WaterBoundaryMesh} from './waterBoundaryGeometry.ts';

const cache=new WeakMap<WaterBoundaryMesh,WaterBoundaryMesh>();
const hash=(s:string)=>{let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return(h>>>0).toString(16);};
function freeze<T>(value:T):T{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}

export function compileWaterBodyBoundaryMesh(w:WaterBodyManifest,scene:PhysicsScene,centerBeds?:number[]):WaterBoundaryMesh {
  const beds=centerBeds??waterBodyGeometry(w,scene).bed,placements=compileWaterPlacementBoundaryMesh(w,scene,beds),known=cache.get(placements);
  if(known)return known;
  const regions=placements.regions.map(r=>{
    const x=w.origin.x+Math.floor(r.cell/w.rows)*w.cellSizeX,z=w.origin.z+(r.cell%w.rows)*w.cellSizeZ;
    // The rectangular fast path requires the original corners, not merely an
    // equal-area polygon left by intersecting support footprints.
    const regular=r.polygon.length===4&&r.polygon.every(p=>(p.x===x||p.x===x+w.cellSizeX)&&(p.z===z||p.z===z+w.cellSizeZ));
    return placements.cells[r.cell].length===1&&!r.solid&&r.bedMin===r.bedMax&&regular?{...r,bulk:true}:r;
  });
  const content=`placement-hydraulics-v1:${placements.sourceKey}`,sourceKey=`${hash(content)}-${hash('hydraulic:'+content)}`;
  const mesh:WaterBoundaryMesh=freeze({revision:`water-boundary-${sourceKey}`,sourceKey,placementOnly:true,
    ...(placements.supportLayer===undefined?{}:{supportLayer:placements.supportLayer}),
    regions,cells:placements.cells,faces:placements.faces,surface:{mesh:placements,owners:regions.map((_,i)=>i)}});
  validateWaterBoundaryMesh(w,mesh);cache.set(placements,mesh);return mesh;
}
