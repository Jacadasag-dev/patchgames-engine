import type {PhysicsVector} from './physics.ts';

/** The bounded region, material and boundary of one shallow-water body.
 * Metres, seconds, kilograms. Water itself lives in the body's grid; this only
 * says where it may be, how heavy it is, and where it enters or leaves. */
export const WATER_DOMAIN_VERSION='water-domain-v1';
export const WATER_DOMAIN_LIMITS=Object.freeze({sources:8,drains:16});
export interface WaterBounds {min:PhysicsVector;max:PhysicsVector}
export interface WaterVolume extends WaterBounds {velocity?:PhysicsVector}
/** A steady inflow, cubic metres per second. The box is the outlet; water
 * leaves it with velocity, falls ballistically and enters the body where it
 * lands, carrying that horizontal momentum. */
export interface WaterSource extends WaterVolume {id:string;rate:number}
export interface WaterDomainRecipe {
  id:string;bounds:WaterBounds;restDensity?:number;gravity?:PhysicsVector;
  /** Cap on any resolved water speed, m/s. Default 30. */
  maxSpeed?:number;
  boundary?:'closed'|'open';
  sources?:WaterSource[];
  /** Drains remove the water standing inside them and account for its volume. */
  drains?:WaterBounds[];
}
export interface WaterDomain {
  id:string;revision:string;version:typeof WATER_DOMAIN_VERSION;bounds:WaterBounds;restDensity:number;gravity:PhysicsVector;
  maxSpeed:number;boundary:'closed'|'open';sources:WaterSource[];drains:WaterBounds[];
}
/** Momentum water delivers to a solid. */
export interface LiquidContact {
  colliderId:string;bodyId?:string;point:PhysicsVector;
  /** Momentum delivered TO the solid, N seconds; sum these once per frame. */ impulse:PhysicsVector;
  /** Total angular impulse about the body's actual center of mass, N m seconds.
   * Do not also derive a moment from point when this explicit moment is present. */ angularImpulse?:PhysicsVector;
  /** Mean force over this step, N. Includes resting weight and pressure. */ force:PhysicsVector;
  /** Incident normal kinetic energy, J; resting contacts have little kinetic energy. */ kineticEnergy:number;
  speed:number;
}

const axes=['x','y','z'] as const;
const finite=(v:number,name:string,min=-1e6,max=1e6)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new Error(`Invalid water ${name}`);};
const vector=(v:PhysicsVector,name:string,limit=1e6)=>{if(!v||typeof v!=='object')throw new Error(`Invalid water ${name}`);for(const a of axes)finite(v[a],name,-limit,limit);};
const box=(b:WaterBounds,name:string)=>{vector(b?.min,name);vector(b?.max,name);if(axes.some(a=>b.max[a]<=b.min[a]))throw new Error(`Invalid water ${name}`);};
const inside=(outer:WaterBounds,inner:WaterBounds)=>axes.every(a=>inner.min[a]>=outer.min[a]-1e-9&&inner.max[a]<=outer.max[a]+1e-9);
const hash=(s:string)=>{let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return(h>>>0).toString(16);};
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v)) as T;
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}

export function compileWaterDomain(recipe:WaterDomainRecipe):WaterDomain{
  if(!recipe||typeof recipe!=='object')throw new Error('Invalid water domain');
  if(typeof recipe.id!=='string'||!/^[A-Za-z0-9_.:-]{1,64}$/.test(recipe.id))throw new Error('Invalid water domain id');
  box(recipe.bounds,'domain bounds');
  const domain:WaterDomain={id:recipe.id,revision:'',version:WATER_DOMAIN_VERSION,bounds:clone(recipe.bounds),
    restDensity:recipe.restDensity??1000,gravity:{...(recipe.gravity??{x:0,y:-9.81,z:0})},maxSpeed:recipe.maxSpeed??30,
    boundary:recipe.boundary??'closed',sources:clone(recipe.sources??[]),drains:clone(recipe.drains??[])};
  finite(domain.restDensity,'rest density',1,20000);vector(domain.gravity,'gravity',100);finite(domain.maxSpeed,'max speed',.1,100);
  if(domain.boundary!=='closed'&&domain.boundary!=='open')throw new Error('Invalid water boundary');
  if(!Array.isArray(domain.sources)||domain.sources.length>WATER_DOMAIN_LIMITS.sources)throw new Error('Water sources budget exceeded');
  if(!Array.isArray(domain.drains)||domain.drains.length>WATER_DOMAIN_LIMITS.drains)throw new Error('Water drains budget exceeded');
  const ids=new Set<string>();
  for(const source of domain.sources){
    box(source,'source');if(!inside(domain.bounds,source))throw new Error('Water source must fit within domain');
    if(typeof source.id!=='string'||!source.id||ids.has(source.id))throw new Error('Invalid or duplicate water source');ids.add(source.id);
    finite(source.rate,'source rate',0,1000);if(source.velocity)vector(source.velocity,'source velocity',100);
  }
  for(const drain of domain.drains){box(drain,'drain');if(!inside(domain.bounds,drain))throw new Error('Water drain must fit within domain');}
  domain.revision=`${WATER_DOMAIN_VERSION}:${hash(JSON.stringify(domain))}`;
  return freeze(domain);
}
