import {generationDataRevision} from './generationMaps.ts';
import type {PlanetVector} from './planet.ts';

export interface PlanetCelestialRecipe {
  /** Physical simulation seconds per eastward body rotation. Hosts can speed up their clock. */
  dayLengthSeconds?:number;phaseTurns?:number;axialTiltDegrees?:number;seasonTurns?:number;
  sunEnabled?:boolean;sunAngularRadiusDegrees?:number;sunGlow?:number;
  starsEnabled?:boolean;starDensity?:number;starIntensity?:number;twinkle?:number;
}
export type ResolvedPlanetCelestialRecipe=Required<PlanetCelestialRecipe>;
export interface PlanetCelestialFrame {
  /** Direction toward the star in the planet's body-fixed coordinate system. */
  sunDirection:PlanetVector;
  /** Rotate body-fixed viewing rays by this angle around +Y to query inertial stars. */
  rotationRadians:number;declinationRadians:number;subsolarLongitudeRadians:number;
}
const TAU=2*Math.PI;
const defaults:ResolvedPlanetCelestialRecipe={dayLengthSeconds:86400,phaseTurns:0,axialTiltDegrees:23.44,seasonTurns:0,sunEnabled:true,sunAngularRadiusDegrees:.2666,sunGlow:1,starsEnabled:true,starDensity:.65,starIntensity:1,twinkle:.45};
export function resolvePlanetCelestialRecipe(input:PlanetCelestialRecipe={}):ResolvedPlanetCelestialRecipe {
  generationDataRevision(input);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!Object.prototype.hasOwnProperty.call(defaults,key)))throw Error('Planet celestial recipe has an unsupported field.');
  const r={...defaults,...input};
  const n=(value:number,min:number,max:number,name:string)=>{if(!Number.isFinite(value)||value<min||value>max)throw Error(`Planet celestial ${name} must be finite within ${min}..${max}.`);};
  n(r.dayLengthSeconds,10,1e9,'day length');n(r.phaseTurns,0,1,'phase');n(r.axialTiltDegrees,0,90,'axial tilt');n(r.seasonTurns,0,1,'season');n(r.sunAngularRadiusDegrees,.01,5,'sun angular radius');n(r.sunGlow,0,10,'sun glow');n(r.starDensity,0,1,'star density');n(r.starIntensity,0,20,'star intensity');n(r.twinkle,0,1,'twinkle');
  if(typeof r.sunEnabled!=='boolean'||typeof r.starsEnabled!=='boolean')throw Error('Planet celestial visibility flags must be boolean.');
  return Object.freeze(r);
}
export function createPlanetCelestialRecipe():ResolvedPlanetCelestialRecipe{return resolvePlanetCelestialRecipe();}
/** A body-fixed world never rotates millions of mesh vertices. The light and
 * inertial sky rotate instead, preserving generation identities and physics coordinates. */
export function samplePlanetCelestial(input:PlanetCelestialRecipe,timeSeconds:number):PlanetCelestialFrame {
  const r=resolvePlanetCelestialRecipe(input);if(!Number.isFinite(timeSeconds)||Math.abs(timeSeconds)>1e9)throw Error('Planet celestial time must be finite within ±1e9 seconds.');
  const turns=((timeSeconds%r.dayLengthSeconds)/r.dayLengthSeconds-r.phaseTurns)%1,rotationRadians=TAU*turns;
  const declinationRadians=Math.asin(Math.sin(r.axialTiltDegrees*Math.PI/180)*Math.sin(TAU*r.seasonTurns)),longitude=-rotationRadians,c=Math.cos(declinationRadians);
  return {sunDirection:[Math.sin(longitude)*c,Math.sin(declinationRadians),Math.cos(longitude)*c],rotationRadians,declinationRadians,subsolarLongitudeRadians:longitude};
}
/** Direct solar attenuation for the scene's directional light. The raymarch
 * performs its own full view/sun transport; this prevents an unreddened white
 * sun lighting nearby terrain during sunset or below the horizon. */
export function samplePlanetSunlight(up:PlanetVector,sun:PlanetVector):{elevationRadians:number;visibility:number;color:PlanetVector} {
  const u=Math.hypot(...up),s=Math.hypot(...sun);if(!Number.isFinite(u*s)||u<1e-12||s<1e-12)throw Error('Sunlight needs finite nonzero radial and light directions.');
  const cosine=Math.max(-1,Math.min(1,up.reduce((n,v,i)=>n+v*sun[i],0)/(u*s))),elevationRadians=Math.asin(cosine),degrees=elevationRadians*180/Math.PI;
  const visibility=Math.max(0,Math.min(1,(degrees+1)/3)),airmass=1/(Math.max(0,cosine)+.50572*(Math.max(.1,degrees)+6.07995)**-1.6364);
  // RGB wavelength-dependent optical depth, normalized to the noon star colour.
  const color=[.055,.13,.30].map(beta=>Math.exp(-beta*Math.max(0,airmass-1))) as [number,number,number];
  return {elevationRadians,visibility,color};
}
