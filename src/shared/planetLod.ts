import {planetTileBounds,planetTileChildren,planetTileKey,type CompiledPlanet,type PlanetTile,type PlanetVector} from './planet.ts';

/** Absolute, planet-centred double coordinates. Do not pass rebased GPU positions. */
export interface PlanetLodFrame {position:PlanetVector;viewportHeight:number;fovDegrees:number}
export interface PlanetLodOptions {maxPatches?:number;targetCellPixels?:number}
export interface PlanetLodPlan {tiles:readonly PlanetTile[];visited:number;budgetLimited:boolean;maxLevel:number}

const clamp=(n:number)=>Math.max(-1,Math.min(1,n));
interface Candidate {tile:PlanetTile;score:number;order:number}
/** A stable bounded max heap: evaluating a child never walks the rest of the globe. */
class Candidates {
  private readonly items:Candidate[]=[];
  get length(){return this.items.length;}
  private higher(a:Candidate,b:Candidate){return a.score>b.score||a.score===b.score&&a.order<b.order;}
  push(value:Candidate){const a=this.items;a.push(value);let at=a.length-1;while(at){const parent=(at-1)>>1;if(!this.higher(a[at],a[parent]))break;[a[at],a[parent]]=[a[parent],a[at]];at=parent;}}
  pop(){const a=this.items,first=a[0],last=a.pop()!;if(a.length){a[0]=last;let at=0;for(;;){let next=at;const left=at*2+1,right=left+1;if(left<a.length&&this.higher(a[left],a[next]))next=left;if(right<a.length&&this.higher(a[right],a[next]))next=right;if(next===at)break;[a[at],a[next]]=[a[next],a[at]];at=next;}}return first;}
}

/** Plan a complete six-face quadtree frontier without generating patch meshes.
 * Priority estimates projected tessellation size, NOT a certified geometric-error
 * bound for an arbitrary generation graph. A hidden hemisphere receives no extra
 * detail; its coarse coverage is retained. Call outside render submission (for
 * example at 10 Hz), then prepare requested patches asynchronously. A view must
 * retain its accepted parent until all four replacement children are ready.
 *
 * The clamped 6..512 leaf budget implies at most 678 visited nodes. The planner
 * does not own a residency cache, change authority, or promise that the requested
 * quality can be reached within a caller's patch budget.
 */
export function planPlanetTiles(planet:CompiledPlanet,frame:PlanetLodFrame,options:PlanetLodOptions={}):PlanetLodPlan {
  if(!frame||!Array.isArray(frame.position)||frame.position.length!==3||[0,1,2].some(i=>typeof frame.position[i]!=='number'||!Number.isFinite(frame.position[i])||Math.abs(frame.position[i])>1e12)
    ||!Number.isFinite(frame.viewportHeight)||frame.viewportHeight<1||frame.viewportHeight>32768
    ||!Number.isFinite(frame.fovDegrees)||frame.fovDegrees<1||frame.fovDegrees>175)throw Error('Planet LOD requires finite absolute coordinates, viewport height 1..32768 and vertical FOV 1..175 degrees.');
  const requested=options.maxPatches??192,target=options.targetCellPixels??8;
  if(typeof requested!=='number'||!Number.isFinite(requested)||typeof target!=='number'||!Number.isFinite(target)||target<.25||target>1024)throw Error('Planet LOD requires a finite patch budget and target cell size .25..1024 pixels.');
  const budget=Math.max(6,Math.min(512,Math.floor(requested))),levelLimit=planet.recipe.maxLevel,segments=planet.recipe.segments;
  const inner=planet.radius+planet.minHeight,outer=planet.radius+planet.maxHeight;
  if(!Number.isInteger(levelLimit)||levelLimit<0||levelLimit>24||!Number.isInteger(segments)||segments<1||segments>128||!Number.isFinite(inner)||!Number.isFinite(outer)||inner<=0||outer<inner)throw Error('Planet LOD requires a validated bounded compiled planet.');
  const [px,py,pz]=frame.position,distance=Math.hypot(px,py,pz),direction:PlanetVector=distance?[px/distance,py/distance,pz/distance]:[0,0,0];
  // One deterministic radial query protects near-surface detail even on mountains;
  // subtracting the base radius alone could treat a 2 km peak as distant terrain.
  const surfaceRadius=distance?planet.radius+planet.sample(frame.position).heightMeters:(inner+outer)/2;
  const radialDistance=Math.abs(distance-surfaceRadius),projection=frame.viewportHeight/(2*Math.tan(frame.fovDegrees*Math.PI/360));
  // An inner sphere cannot hide protruding mountains on its own. Include the
  // maximum outer-shell horizon extension before suppressing refinement.
  const horizon=distance>inner?Math.min(Math.PI,Math.acos(clamp(inner/distance))+Math.acos(clamp(inner/outer))):Math.PI;
  const score=(tile:PlanetTile)=>{
    const bounds=planetTileBounds(tile,planet.radius,planet.minHeight,planet.maxHeight),[x,y,z]=bounds.center,length=Math.hypot(x,y,z),nx=x/length,ny=y/length,nz=z/length;
    // atan2 retains small angular separations at Earth radius; acos(dot) loses
    // useful precision when adjacent metre-scale patches have almost equal rays.
    const angle=distance?Math.atan2(Math.hypot(direction[1]*nz-direction[2]*ny,direction[2]*nx-direction[0]*nz,direction[0]*ny-direction[1]*nx),clamp(direction[0]*nx+direction[1]*ny+direction[2]*nz)):0;
    if(angle-bounds.angularRadius>horizon)return 0;
    const tangentDistance=2*surfaceRadius*Math.sin(Math.max(0,angle-bounds.angularRadius)/2);
    const nearest=Math.max(1,Math.hypot(radialDistance,tangentDistance));
    return 2*bounds.angularRadius*outer/segments*projection/nearest;
  };
  const frontier=new Map<string,PlanetTile>(),candidates=new Candidates();let visited=0,order=0,budgetLimited=false;
  const add=(input:PlanetTile)=>{const tile=Object.freeze({...input});frontier.set(planetTileKey(tile),tile);visited++;if(tile.level<levelLimit){const priority=score(tile);if(priority>target)candidates.push({tile,score:priority,order:order++});}};
  for(let face=0;face<6;face++)add({face:face as PlanetTile['face'],level:0,x:0,y:0});
  while(candidates.length){if(frontier.size+3>budget){budgetLimited=true;break;}const next=candidates.pop();frontier.delete(planetTileKey(next.tile));for(const child of planetTileChildren(next.tile))add(child);}
  const tiles=Object.freeze([...frontier.values()].sort((a,b)=>a.face-b.face||a.level-b.level||a.x-b.x||a.y-b.y));
  return Object.freeze({tiles,visited,budgetLimited,maxLevel:tiles.reduce((level,tile)=>Math.max(level,tile.level),0)});
}
