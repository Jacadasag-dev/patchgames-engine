import {planetCoordinates,planetDirection,type CompiledPlanet,type PlanetTile,type PlanetVector} from './planet.ts';

/** Population cells are recipe-space identities, never terrain LOD tiles. */
export interface PlanetPopulationBiomeSample {
  id:string; heightMeters:number; slope:number; temperature:number; moisture:number;
  forestFamily:'temperate'|'conifer'|'tropical'|'none'; treeDensity:number; buildingSuitability:number;
}
export interface PlanetPopulationBiomes {sample(direction:PlanetVector):PlanetPopulationBiomeSample}
export interface PlanetPopulationWorld {planet:CompiledPlanet;biomes:PlanetPopulationBiomes}
export interface PlanetPopulationInstance {
  id:string; kind:'tree'|'building'; variant:string; position:PlanetVector; up:PlanetVector; yaw:number; scale:number;
}
export interface PlanetPopulationCell {key:string;cell:PlanetTile;instances:PlanetPopulationInstance[]}
export interface PlanetPopulationOptions {
  cellMeters?:number; radiusMeters?:number; maxCells?:number; maxTrees?:number; maxBuildings?:number;
  maxAltitudeMeters?:number; treesPerCell?:number;
}
export interface ResolvedPlanetPopulationOptions {
  cellMeters:number;radiusMeters:number;maxCells:number;maxTrees:number;maxBuildings:number;maxAltitudeMeters:number;treesPerCell:number;
}
export const PLANET_POPULATION_LIMITS=Object.freeze({maxCells:64,maxTrees:1024,maxBuildings:64,treesPerCell:48,maxInFlight:2,maxVariantTrees:7,maxVariantBuildings:2});
function option(value:number|undefined,fallback:number,min:number,max:number,name:string,integer=false){const n=value??fallback;if(!Number.isFinite(n)||n<min||n>max||integer&&!Number.isInteger(n))throw Error(`Planet population ${name} must be ${integer?'an integer':'finite'} within ${min}..${max}.`);return n;}
export function resolvePlanetPopulationOptions(options:PlanetPopulationOptions={}):ResolvedPlanetPopulationOptions{return{
  cellMeters:option(options.cellMeters,128,32,2048,'cell size'),radiusMeters:option(options.radiusMeters,420,32,8192,'radius'),
  maxCells:option(options.maxCells,25,1,64,'cells',true),maxTrees:option(options.maxTrees,320,0,1024,'trees',true),
  maxBuildings:option(options.maxBuildings,24,0,64,'buildings',true),maxAltitudeMeters:option(options.maxAltitudeMeters,1800,32,20000,'altitude'),treesPerCell:option(options.treesPerCell,24,0,48,'cell trees',true),
};}
export function planetPopulationCellLevel(radius:number,cellMeters=128):number{return Math.max(0,Math.min(24,Math.ceil(Math.log2(2*radius/cellMeters))));}
export function planetPopulationCellKey(cell:PlanetTile):string{return `population:${cell.face}/${cell.level}/${cell.x}/${cell.y}`;}
const normalize=(p:PlanetVector):[number,number,number]=>{const n=Math.hypot(...p);if(!Number.isFinite(n)||n<1e-12)throw Error('Population direction requires a finite nonzero vector.');return[p[0]/n,p[1]/n,p[2]/n];};
const dot=(a:PlanetVector,b:PlanetVector)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a:PlanetVector,b:PlanetVector):[number,number,number]=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
/** Stable right-handed tangent frame, with local +Y exactly radial. */
export function planetPopulationFrame(up:PlanetVector):{x:PlanetVector;y:PlanetVector;z:PlanetVector}{const y=normalize(up),x=normalize(cross(Math.abs(y[1])<.95?[0,1,0]:[0,0,1],y));return{x,y,z:cross(x,y)};}
function cubeDirection(face:number,u:number,v:number):PlanetVector{return normalize(face===0?[1,v,-u]:face===1?[-1,v,u]:face===2?[u,1,-v]:face===3?[u,-1,v]:face===4?[u,v,1]:[-u,v,-1]);}
export function planetPopulationCellDirection(cell:PlanetTile,u=.5,v=.5):PlanetVector{const width=2**cell.level;if(!Number.isInteger(cell.face)||cell.face<0||cell.face>5||!Number.isInteger(cell.level)||cell.level<0||cell.level>24||![cell.x,cell.y].every(n=>Number.isInteger(n)&&n>=0&&n<width)||![u,v].every(n=>Number.isFinite(n)&&n>=0&&n<=1))throw Error('Invalid population cell.');return planetDirection(cell.face,(cell.x+u)/width*2-1,(cell.y+v)/width*2-1);}
/** Search crosses cube seams through canonical directions; no wrapped duplicate IDs. */
export function planetPopulationCells(radius:number,cameraPosition:PlanetVector,options:ResolvedPlanetPopulationOptions):PlanetTile[]{
  const direction=normalize(cameraPosition),level=planetPopulationCellLevel(radius,options.cellMeters),width=2**level,source=planetCoordinates(direction),ix=Math.min(width-1,Math.floor((source.u+1)*width/2)),iy=Math.min(width-1,Math.floor((source.v+1)*width/2));
  const span=Math.min(32,Math.ceil(options.radiusMeters/(2*radius/width)*2)+2),cells=new Map<string,{cell:PlanetTile;distance:number}>();
  for(let dx=-span;dx<=span;dx++)for(let dy=-span;dy<=span;dy++){
    const d=cubeDirection(source.face,(ix+dx+.5)/width*2-1,(iy+dy+.5)/width*2-1),canonical=planetCoordinates(d),cell={face:canonical.face,level,x:Math.min(width-1,Math.max(0,Math.floor((canonical.u+1)*width/2))),y:Math.min(width-1,Math.max(0,Math.floor((canonical.v+1)*width/2)))};
    const center=planetPopulationCellDirection(cell),distance=radius*Math.hypot(...center.map((n,i)=>n-direction[i]));
    if(distance<=options.radiusMeters+options.cellMeters)cells.set(planetPopulationCellKey(cell),{cell,distance});
  }
  return [...cells.values()].sort((a,b)=>a.distance-b.distance||planetPopulationCellKey(a.cell).localeCompare(planetPopulationCellKey(b.cell))).slice(0,options.maxCells).map(value=>value.cell);
}
function random(key:string):number{let h=2166136261;for(let i=0;i<key.length;i++)h=Math.imul(h^key.charCodeAt(i),16777619);h=Math.imul(h^(h>>>16),0x7feb352d);h=Math.imul(h^(h>>>15),0x846ca68b);return ((h^(h>>>16))>>>0)/4294967296;}
const point=(direction:PlanetVector,radius:number):PlanetVector=>[direction[0]*radius,direction[1]*radius,direction[2]*radius];
const trees={temperate:['oak','maple','birch'],conifer:['evergreen','pine'],tropical:['jungle','palm'],none:[]} as const;
/** Pure bounded placement work. Hosts run this in the same preparation worker as
 * the global biome fields. No asset compiler or material baker runs per cell. */
export function planPlanetPopulationCell(world:PlanetPopulationWorld,cell:PlanetTile,options:ResolvedPlanetPopulationOptions):PlanetPopulationCell{
  planetPopulationCellDirection(cell);const key=planetPopulationCellKey(cell),seed=world.planet.recipe.seed,instances:PlanetPopulationInstance[]=[];
  const sample=(id:string)=>planetPopulationCellDirection(cell,.04+random(`${seed}:${id}:u`)*.92,.04+random(`${seed}:${id}:v`)*.92);
  // Building candidacy is independent of the tree budget and streaming order.
  const id=key+':building',direction=sample(id),biome=world.biomes.sample(direction);
  if(biome.heightMeters>world.planet.recipe.seaLevelMeters+1&&biome.slope<=8&&biome.temperature>.15&&biome.buildingSuitability>0&&random(`${seed}:${id}:present`)<.25*biome.buildingSuitability){
    const frame=planetPopulationFrame(direction),yaw=random(`${seed}:${id}:yaw`)*Math.PI*2,c=Math.cos(yaw),s=Math.sin(yaw),heights:number[]=[];
    // Test the full 10m footprint, including corners and edge midpoints. A thick
    // compiler-owned foundation sinks below every accepted support point.
    for(const [x,z]of [[0,0],[-5,-5],[-5,5],[5,-5],[5,5],[-5,0],[5,0],[0,-5],[0,5]]){
      const dx=x*c+z*s,dz=z*c-x*s,d=normalize(direction.map((n,i)=>n+(frame.x[i]*dx+frame.z[i]*dz)/world.planet.radius) as [number,number,number]),b=world.biomes.sample(d);
      if(b.heightMeters<=world.planet.recipe.seaLevelMeters+1||b.slope>8||b.temperature<=.15){heights.length=0;break;}
      const p=point(d,world.planet.radius+b.heightMeters);heights.push(dot(p,direction)-world.planet.radius);
    }
    if(heights.length===9&&Math.max(...heights)-Math.min(...heights)<=.35)instances.push({id,kind:'building',variant:random(`${seed}:${id}:variant`)<.5?'cottage':'lodge',position:point(direction,world.planet.radius+Math.max(...heights)-.02),up:direction,yaw,scale:1});
  }
  for(let i=0;i<options.treesPerCell;i++){
    const id=key+':tree:'+i,direction=sample(id),b=world.biomes.sample(direction),variants=trees[b.forestFamily];
    if(!variants?.length||b.heightMeters<=world.planet.recipe.seaLevelMeters+.8||b.slope>38||random(`${seed}:${id}:density`)>Math.max(0,Math.min(1,b.treeDensity)))continue;
    const position=point(direction,world.planet.radius+b.heightMeters-.04);
    if(instances.some(item=>item.kind==='building'&&Math.hypot(...position.map((n,j)=>n-item.position[j]))<12))continue;
    instances.push({id,kind:'tree',variant:variants[Math.min(variants.length-1,Math.floor(random(`${seed}:${id}:variant`)*variants.length))],position,up:direction,yaw:random(`${seed}:${id}:yaw`)*Math.PI*2,scale:.8+random(`${seed}:${id}:scale`)*.4});
  }
  return{key,cell:{...cell},instances};
}
