import {generationDataRevision} from './generationMaps.ts';
import {planetCoordinates,planetDirection,type PlanetVector} from './planet.ts';
import {samplePlanetCelestial} from './planetCelestial.ts';
import {planetAtmosphereSaturationSpecificHumidity} from './planetThermodynamics.ts';
import {diagnosePlanetCloudColumn,type PlanetCloudColumnDiagnosis} from './planetCloudColumn.ts';
export {planetAtmosphereSaturationSpecificHumidity} from './planetThermodynamics.ts';

/** A noncondensing background gas plus a dilute water cycle. These are physical
 * boundary conditions, never cloud coverage or a list of prescribed storms. */
export interface PlanetAtmospherePhysics {
  radiusMeters:number;gravityMetersPerSecondSquared:number;rotationPeriodSeconds:number;axialTiltDegrees:number;orbitalPeriodSeconds:number;orbitalPhaseTurns:number;
  stellarFluxWattsPerSquareMeter:number;surfacePressurePascals:number;gas:'earthlike'|'carbon-dioxide';
  meanMolarMassKgPerMol:number;specificHeatJoulesPerKgKelvin:number;surfaceAlbedo:number;greenhouseOpticalDepth:number;
  oceanMixedLayerDepthMeters:number;surfaceMoisture:number;initialRelativeHumidity:number;dustAvailability:number;
  equilibriumTemperatureKelvin:number;scaleHeightMeters:number;
}
export interface PlanetAtmosphereRecipe {kind:'planet-atmosphere';version:1;seed:number;resolution:16|32|64;physics:PlanetAtmospherePhysics}
export interface PlanetAtmosphereSurface {heightMeters:number;waterFraction:number}
export interface PlanetAtmosphereSample extends PlanetCloudColumnDiagnosis {
  liquidLowerKgM2:number;liquidUpperKgM2:number;iceLowerKgM2:number;iceUpperKgM2:number;dustKgM2:number;
  materialLower:PlanetVector;materialUpper:PlanetVector;pressurePascals:number;
  temperatureLowerKelvin:number;temperatureUpperKelvin:number;surfaceTemperatureKelvin:number;
  windLowerMetersPerSecond:PlanetVector;windUpperMetersPerSecond:PlanetVector;relativeHumidityLower:number;
}
export interface PlanetAtmosphereInspection {
  revision:string;timeSeconds:number;tick:number;resolution:number;cellCount:number;edgeCount:number;fixedTickSeconds:number;
  pendingSeconds:number;stateBytes:number;maxCourant:number;maxWindMetersPerSecond:number;
  cloudColumnDiagnosisCount:number;
  airMassKg:number;waterMassKg:number;dustMassKg:number;airMassRelativeError:number;waterMassRelativeError:number;dustMassRelativeError:number;
  condensedWaterKg:number;cloudyAreaFraction:number;meanSurfaceTemperatureKelvin:number;
  absorbedStellarJoules:number;reflectedStellarJoules:number;outgoingRadiationJoules:number;scope:string;
}
/** Mutable independent copy for persistence, not the renderer wire format. */
export interface PlanetAtmosphereStateSnapshot {
  kind:'planet-atmosphere-state';version:1;revision:string;tick:number;timeSeconds:number;
  airMass:Float64Array;momentum:Float64Array;potentialTemperatureMass:Float64Array;
  vapor:Float64Array;liquid:Float64Array;ice:Float64Array;dust:Float64Array;material:Float64Array;
  surfaceWater:Float64Array;surfaceIce:Float64Array;surfaceDust:Float64Array;surfaceTemperature:Float64Array;
  initialTotals:readonly[number,number,number];absorbedStellarJoules:number;reflectedStellarJoules:number;outgoingRadiationJoules:number;
}
export interface PlanetAtmosphereSimulation {
  readonly revision:string;
  advanceTo(targetPhysicalSeconds:number,maxSubsteps?:number):PlanetAtmosphereInspection;
  sample(direction:PlanetVector):PlanetAtmosphereSample;
  snapshot():PlanetAtmosphereStateSnapshot;checkpoint():PlanetAtmosphereStateSnapshot;
  restore(checkpoint:PlanetAtmosphereStateSnapshot):void;inspection():PlanetAtmosphereInspection;
}
export const PLANET_ATMOSPHERE_LIMITS=Object.freeze({resolutions:[16,32,64] as const,maxSubsteps:512,maxPhysicalSeconds:1e12,maxStateBytes:32*1024*1024});
const RU=8.314462618,SIGMA=5.670374419e-8,LV=2.5e6,LF=333700,LS=LV+LF,FREEZE=273.15;
/** Deliberately gray engineering optics, not a replacement for a molecular or
 * particle spectrum. Liquid LW is the NCAR CCM3/CAM coefficient; ice/dust LW
 * use Qabs=1/.1 geometric approximations at the renderer's effective radii. */
export const PLANET_ATMOSPHERE_RADIATION=Object.freeze({
  liquid:{extinctionM2Kg:150,singleScatteringAlbedo:.99,asymmetry:.85,longwaveAbsorptionM2Kg:90.361},
  ice:{extinctionM2Kg:65.43,singleScatteringAlbedo:.99,asymmetry:.75,longwaveAbsorptionM2Kg:3/(4*917*25e-6)},
  dust:{extinctionM2Kg:600,singleScatteringAlbedo:.8,asymmetry:.6,longwaveAbsorptionM2Kg:3*.1/(4*2500*1e-6)},
  shortwaveDiffusivity:2,longwaveDiffusivity:1.66,
});
export interface PlanetAtmosphereRadiativeLayer {temperatureKelvin:number;gasOpticalDepth:number;liquidKgM2:number;iceKgM2:number;dustKgM2:number}
export interface PlanetAtmosphereRadiativeColumn {incidentStellarWm2:number;surfaceAlbedo:number;surfaceTemperatureKelvin:number;lower:PlanetAtmosphereRadiativeLayer;upper:PlanetAtmosphereRadiativeLayer}
export interface PlanetAtmosphereRadiativeBudget {
  surfaceNetWm2:number;lowerNetWm2:number;upperNetWm2:number;surfaceShortwaveWm2:number;lowerShortwaveWm2:number;upperShortwaveWm2:number;
  reflectedStellarWm2:number;outgoingLongwaveWm2:number;lowerEmissivity:number;upperEmissivity:number;energyResidualWm2:number;
}
interface TwoStreamLayer {reflection:number;transmission:number;absorption:number}
function twoStream(depth:number,omega:number,asymmetry:number,out:TwoStreamLayer):TwoStreamLayer {
  const path=depth*PLANET_ATMOSPHERE_RADIATION.shortwaveDiffusivity,a=1-omega*(1+asymmetry)*.5,b=omega*(1-asymmetry)*.5,k=Math.sqrt((1-omega)*(1-omega*asymmetry));
  if(k===0){const denominator=1+a*path;out.reflection=b*path/denominator;out.transmission=1/denominator;out.absorption=0;return out;}
  const x=Math.exp(-k*path),oneMinusX=-Math.expm1(-k*path),oneMinusX2=-Math.expm1(-2*k*path),denominator=2*k+(a-k)*oneMinusX2;
  out.reflection=b*oneMinusX2/denominator;out.transmission=2*k*x/denominator;
  // Positive analytic absorption avoids cancellation for almost conservative,
  // optically thin slabs. No negative-flux clamps or opacity normalization.
  out.absorption=oneMinusX*(k*oneMinusX+(1-omega)*(1+x))/denominator;return out;
}
/** Analytic homogeneous hemispheric two-stream slab. R+T+A=1, including the
 * exactly conservative-scattering and perfect-forward-scattering limits. */
export function planetAtmosphereTwoStreamLayer(opticalDepth:number,singleScatteringAlbedo:number,asymmetry:number):TwoStreamLayer {
  bounded(opticalDepth,'solar optical depth',0,1e12);bounded(singleScatteringAlbedo,'single scattering albedo',0,1);bounded(asymmetry,'asymmetry',-1,1);
  return twoStream(opticalDepth,singleScatteringAlbedo,asymmetry,{reflection:0,transmission:1,absorption:0});
}
function solarLayer(layer:PlanetAtmosphereRadiativeLayer,out:TwoStreamLayer):TwoStreamLayer {
  const optics=PLANET_ATMOSPHERE_RADIATION,l=layer.liquidKgM2*optics.liquid.extinctionM2Kg,i=layer.iceKgM2*optics.ice.extinctionM2Kg,d=layer.dustKgM2*optics.dust.extinctionM2Kg,total=l+i+d;
  if(total===0){out.reflection=0;out.transmission=1;out.absorption=0;return out;}
  const sl=l*optics.liquid.singleScatteringAlbedo,si=i*optics.ice.singleScatteringAlbedo,sd=d*optics.dust.singleScatteringAlbedo,scatter=sl+si+sd;
  return twoStream(total,scatter/total,(sl*optics.liquid.asymmetry+si*optics.ice.asymmetry+sd*optics.dust.asymmetry)/scatter,out);
}
const radiativeBudget=():PlanetAtmosphereRadiativeBudget=>({surfaceNetWm2:0,lowerNetWm2:0,upperNetWm2:0,surfaceShortwaveWm2:0,lowerShortwaveWm2:0,upperShortwaveWm2:0,reflectedStellarWm2:0,outgoingLongwaveWm2:0,lowerEmissivity:0,upperEmissivity:0,energyResidualWm2:0});
function radiativeColumn(input:PlanetAtmosphereRadiativeColumn,out:PlanetAtmosphereRadiativeBudget,lower:TwoStreamLayer,upper:TwoStreamLayer):PlanetAtmosphereRadiativeBudget {
  solarLayer(input.lower,lower);solarLayer(input.upper,upper);
  const albedo=input.surfaceAlbedo,incident=input.incidentStellarWm2,surfaceDenominator=1-lower.reflection*albedo;
  // Adding lower atmosphere to the surface sums all repeated reflections.
  const belowReflection=lower.reflection+lower.transmission*lower.transmission*albedo/surfaceDenominator;
  const downBetween=upper.transmission*incident/(1-upper.reflection*belowReflection),upBetween=belowReflection*downBetween,downSurface=lower.transmission*downBetween/surfaceDenominator,upSurface=albedo*downSurface;
  out.surfaceShortwaveWm2=(1-albedo)*downSurface;out.lowerShortwaveWm2=lower.absorption*(downBetween+upSurface);out.upperShortwaveWm2=upper.absorption*(incident+upBetween);out.reflectedStellarWm2=upper.reflection*incident+upper.transmission*upBetween;
  const optics=PLANET_ATMOSPHERE_RADIATION,emissivity=(layer:PlanetAtmosphereRadiativeLayer)=>-Math.expm1(-(layer.gasOpticalDepth+optics.longwaveDiffusivity*(layer.liquidKgM2*optics.liquid.longwaveAbsorptionM2Kg+layer.iceKgM2*optics.ice.longwaveAbsorptionM2Kg+layer.dustKgM2*optics.dust.longwaveAbsorptionM2Kg)));
  const e0=emissivity(input.lower),e1=emissivity(input.upper),surface=SIGMA*input.surfaceTemperatureKelvin**4,emit0=e0*SIGMA*input.lower.temperatureKelvin**4,emit1=e1*SIGMA*input.upper.temperatureKelvin**4;
  out.lowerEmissivity=e0;out.upperEmissivity=e1;out.surfaceNetWm2=out.surfaceShortwaveWm2+emit0+(1-e0)*emit1-surface;out.lowerNetWm2=out.lowerShortwaveWm2+e0*(surface+emit1)-2*emit0;out.upperNetWm2=out.upperShortwaveWm2+e1*((1-e0)*surface+emit0)-2*emit1;
  out.outgoingLongwaveWm2=(1-e1)*((1-e0)*surface+emit0)+emit1;out.energyResidualWm2=out.surfaceNetWm2+out.lowerNetWm2+out.upperNetWm2+out.outgoingLongwaveWm2+out.reflectedStellarWm2-incident;return out;
}
/** Conservative two-stream solar adding + two-layer thermal emission. The sum
 * of three net heating rates equals absorbed stellar minus escaping infrared. */
export function planetAtmosphereRadiativeColumn(input:PlanetAtmosphereRadiativeColumn):PlanetAtmosphereRadiativeBudget {
  bounded(input.incidentStellarWm2,'incident solar flux',0,5000);bounded(input.surfaceAlbedo,'surface albedo',0,1);bounded(input.surfaceTemperatureKelvin,'surface radiation temperature',80,600);
  for(const layer of [input.lower,input.upper]){bounded(layer.temperatureKelvin,'layer radiation temperature',80,600);bounded(layer.gasOpticalDepth,'gas optical depth',0,100);for(const key of ['liquidKgM2','iceKgM2','dustKgM2'] as const)bounded(layer[key],'radiative column '+key,0,1e8);}
  return radiativeColumn(input,radiativeBudget(),{reflection:0,transmission:1,absorption:0},{reflection:0,transmission:1,absorption:0});
}
type Vec=[number,number,number];
const dot=(a:PlanetVector,b:PlanetVector)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a:PlanetVector,b:PlanetVector):Vec=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=(a:PlanetVector):Vec=>{if(!a||a.length!==3||!Number.isFinite(a[0])||!Number.isFinite(a[1])||!Number.isFinite(a[2]))throw Error('Atmosphere direction needs three finite coordinates.');const d=Math.hypot(...a);if(!Number.isFinite(d)||d<1e-20)throw Error('Atmosphere direction must be finite and nonzero.');return[a[0]/d,a[1]/d,a[2]/d];};
const bounded=(n:number,key:string,min:number,max:number)=>{if(!Number.isFinite(n)||n<min||n>max)throw Error(`Atmosphere ${key} must be within ${min}..${max}.`);return n;};
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
/** Shared physical clock for atmospheric heating and the visible sun. */
export function samplePlanetAtmosphereCelestial(physics:PlanetAtmospherePhysics,timeSeconds:number) {
  bounded(timeSeconds,'celestial time',0,PLANET_ATMOSPHERE_LIMITS.maxPhysicalSeconds);
  const seasonTurns=(physics.orbitalPhaseTurns+(timeSeconds%physics.orbitalPeriodSeconds)/physics.orbitalPeriodSeconds)%1;
  return samplePlanetCelestial({dayLengthSeconds:physics.rotationPeriodSeconds,axialTiltDegrees:physics.axialTiltDegrees,seasonTurns},timeSeconds%physics.rotationPeriodSeconds);
}
/** Exact local inertial rotation; drag and pressure forces are separate. */
export function rotatePlanetAtmosphereCoriolis(velocity:PlanetVector,direction:PlanetVector,rotationRadiansPerSecond:number,seconds:number):Vec {
  const n=unit(direction),f=2*rotationRadiansPerSecond*n[1],angle=-f*seconds,c=Math.cos(angle),s=Math.sin(angle),vCross=cross(n,velocity),radial=dot(n,velocity);
  return[velocity[0]*c+vCross[0]*s+n[0]*radial*(1-c),velocity[1]*c+vCross[1]*s+n[1]*radial*(1-c),velocity[2]*c+vCross[2]*s+n[2]*radial*(1-c)];
}
interface Edge {a:number;b:number;length:number;normal:Vec;normalA:Vec;normalB:Vec}
interface Grid {count:number;directions:Float64Array;areas:Float64Array;edges:Edge[];perimeters:Float64Array;neighbors:number[][]}
const sphericalTriangle=(a:PlanetVector,b:PlanetVector,c:PlanetVector)=>2*Math.atan2(Math.abs(dot(a,cross(b,c))),1+dot(a,b)+dot(b,c)+dot(c,a));
function buildGrid(n:number,radius:number):Grid {
  const count=6*n*n,directions=new Float64Array(count*3),areas=new Float64Array(count),perimeters=new Float64Array(count),neighbors:number[][]=Array.from({length:count},()=>[]),edges:Edge[]=[];
  const open=new Map<string,{cell:number;a:PlanetVector;b:PlanetVector}>();
  const cube=(face:number,u:number,v:number):Vec=>face===0?[n,v,-u]:face===1?[-n,v,u]:face===2?[u,n,-v]:face===3?[u,-n,v]:face===4?[u,v,n]:[-u,v,-n];
  const project=(normal:PlanetVector,d:PlanetVector):Vec=>{const radial=dot(normal,d);return[normal[0]-radial*d[0],normal[1]-radial*d[1],normal[2]-radial*d[2]];};
  for(let face=0;face<6;face++)for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const cell=face*n*n+y*n+x,d=planetDirection(face,-1+2*(x+.5)/n,-1+2*(y+.5)/n);directions.set(d,cell*3);
    const ints=[cube(face,2*x-n,2*y-n),cube(face,2*x+2-n,2*y-n),cube(face,2*x+2-n,2*y+2-n),cube(face,2*x-n,2*y+2-n)];
    const corners=ints.map(unit);areas[cell]=(sphericalTriangle(corners[0],corners[1],corners[2])+sphericalTriangle(corners[0],corners[2],corners[3]))*radius*radius;
    for(let side=0;side<4;side++){
      const next=(side+1)%4,ka=ints[side].join(','),kb=ints[next].join(','),key=ka<kb?ka+'|'+kb:kb+'|'+ka,prior=open.get(key);
      if(!prior){open.set(key,{cell,a:corners[side],b:corners[next]});continue;}
      open.delete(key);const a=prior.cell,b=cell,da:[number,number,number]=[directions[a*3],directions[a*3+1],directions[a*3+2]],db=d,normal=unit(cross(prior.a,prior.b));
      if(dot(normal,[db[0]-da[0],db[1]-da[1],db[2]-da[2]])<0)for(let k=0;k<3;k++)normal[k]*=-1;
      const length=Math.atan2(Math.hypot(...cross(prior.a,prior.b)),dot(prior.a,prior.b))*radius;
      edges.push({a,b,length,normal,normalA:project(normal,da),normalB:project(normal,db)});perimeters[a]+=length;perimeters[b]+=length;neighbors[a].push(b);neighbors[b].push(a);
    }
  }
  if(open.size||edges.length!==count*2||neighbors.some(v=>v.length!==4))throw Error('Atmosphere cubed-sphere topology is not closed.');
  return{count,directions,areas,edges,perimeters,neighbors};
}
function resolveRecipe(recipe:PlanetAtmosphereRecipe):PlanetAtmosphereRecipe {
  if(!recipe||recipe.kind!=='planet-atmosphere'||recipe.version!==1||![16,32,64].includes(recipe.resolution)||!Number.isInteger(recipe.seed))throw Error('Use a version 1 atmosphere recipe with bounded C16, C32 or C64 resolution.');
  generationDataRevision(recipe);const p=recipe.physics;
  bounded(recipe.seed,'seed',-2147483648,2147483647);
  bounded(p.radiusMeters,'radius',500000,100000000);bounded(p.gravityMetersPerSecondSquared,'gravity',.3,50);bounded(p.rotationPeriodSeconds,'rotation',3600,1e9);
  bounded(p.axialTiltDegrees,'tilt',0,90);bounded(p.stellarFluxWattsPerSquareMeter,'stellar flux',0,5000);bounded(p.surfacePressurePascals,'surface pressure',1,2000000);
  bounded(p.orbitalPeriodSeconds,'orbital period',3600,1e12);bounded(p.orbitalPhaseTurns,'orbital phase',0,1);
  bounded(p.meanMolarMassKgPerMol,'molar mass',.002,.2);bounded(p.specificHeatJoulesPerKgKelvin,'specific heat',500,10000);
  bounded(p.equilibriumTemperatureKelvin,'equilibrium temperature',120,450);bounded(p.scaleHeightMeters,'scale height',10,p.radiusMeters*.011);
  bounded(p.surfaceAlbedo,'albedo',0,1);bounded(p.greenhouseOpticalDepth,'optical depth',0,10);bounded(p.oceanMixedLayerDepthMeters,'mixed layer',1,200);
  for(const key of ['surfaceMoisture','initialRelativeHumidity','dustAvailability'] as const)bounded(p[key],key,0,1);
  if(!['earthlike','carbon-dioxide'].includes(p.gas))throw Error('Unsupported atmosphere background gas.');
  if((2*Math.PI/p.rotationPeriodSeconds)**2*p.radiusMeters>p.gravityMetersPerSecondSquared*.5)throw Error('Atmosphere rotation exceeds spherical-gravity approximation.');
  const h=RU*p.equilibriumTemperatureKelvin/(p.meanMolarMassKgPerMol*p.gravityMetersPerSecondSquared);
  if(Math.abs(h/p.scaleHeightMeters-1)>1e-6)throw Error('Atmosphere scale height must agree with temperature, molar mass and gravity.');
  return{...recipe,physics:{...p}};
}

/** A one-dimensional diffusive energy-balance *initial condition*, not a storm
 * prescription. Daily mean insolation, gray outgoing IR and eddy heat transport
 * produce a latitude/season dependent temperature before prognostic ticks start.
 * The mixing length shrinks with rotation; rotation never multiplies wind speed. */
function initialClimate(p:PlanetAtmospherePhysics):Float64Array {
  const count=64,delta=Math.PI/count,temperature=new Float64Array(count).fill(p.equilibriumTemperatureKelvin),forcing=new Float64Array(count),low=new Float64Array(count),high=new Float64Array(count),diagonal=new Float64Array(count),rhs=new Float64Array(count);
  const declination=samplePlanetAtmosphereCelestial(p,0).declinationRadians,c=Math.sqrt(p.gravityMetersPerSecondSquared*p.scaleHeightMeters),rotation=2*Math.PI/p.rotationPeriodSeconds,mixingLength=Math.min(p.radiusMeters,c/Math.max(2*rotation,c/p.radiusMeters));
  const diffusivity=.003*c*mixingLength,transport=p.specificHeatJoulesPerKgKelvin*p.surfacePressurePascals/p.gravityMetersPerSecondSquared*diffusivity/(p.radiusMeters*p.radiusMeters),radiation=SIGMA/(1+.75*p.greenhouseOpticalDepth);
  for(let i=0;i<count;i++){
    const lat=-Math.PI*.5+(i+.5)*delta,a=Math.sin(lat)*Math.sin(declination),b=Math.cos(lat)*Math.cos(declination),hourAngle=Math.acos(clamp(-a/Math.max(1e-15,b),-1,1));
    forcing[i]=p.stellarFluxWattsPerSquareMeter*(1-p.surfaceAlbedo)/Math.PI*(hourAngle*a+Math.sin(hourAngle)*b);
    const south=-Math.PI*.5+i*delta,north=south+delta,area=Math.sin(north)-Math.sin(south);
    low[i]=i===0?0:-transport*Math.cos(south)/(delta*area);high[i]=i===count-1?0:-transport*Math.cos(north)/(delta*area);
  }
  for(let iteration=0;iteration<12;iteration++){
    for(let i=0;i<count;i++){diagonal[i]=-low[i]-high[i]+4*radiation*temperature[i]**3;rhs[i]=forcing[i]+3*radiation*temperature[i]**4;}
    for(let i=1;i<count;i++){const factor=low[i]/diagonal[i-1];diagonal[i]-=factor*high[i-1];rhs[i]-=factor*rhs[i-1];}
    temperature[count-1]=rhs[count-1]/diagonal[count-1];for(let i=count-2;i>=0;i--)temperature[i]=(rhs[i]-high[i]*temperature[i+1])/diagonal[i];
  }
  for(const t of temperature)bounded(t,'initial energy balance temperature',80,600);
  return temperature;
}

/** Persistent finite-volume two-layer moist rotating shallow atmosphere. Call in
 * a preparation worker; render sampling does not advance or regenerate weather. */
export function createPlanetAtmosphere(input:PlanetAtmosphereRecipe,sampleSurface?:(direction:PlanetVector)=>PlanetAtmosphereSurface):PlanetAtmosphereSimulation {
  const recipe=resolveRecipe(input),p=recipe.physics,grid=buildGrid(recipe.resolution,p.radiusMeters),n=grid.count,L=n*2,g=p.gravityMetersPerSecondSquared,H=p.scaleHeightMeters,cp=p.specificHeatJoulesPerKgKelvin;
  const rho=p.surfacePressurePascals/(g*H),rGas=RU/p.meanMolarMassKgPerMol,kappa=rGas/cp,omega=2*Math.PI/p.rotationPeriodSeconds;
  let revision='';
  const airMass=new Float64Array(L),momentum=new Float64Array(L*3),potentialTemperatureMass=new Float64Array(L),vapor=new Float64Array(L),liquid=new Float64Array(L),ice=new Float64Array(L),dust=new Float64Array(L),material=new Float64Array(L*3);
  const surfaceWater=new Float64Array(n),surfaceIce=new Float64Array(n),surfaceDust=new Float64Array(n),surfaceTemperature=new Float64Array(n),waterFraction=new Float64Array(n),bottom=new Float64Array(n),heatCapacity=new Float64Array(n);
  const surfaceAltitude=new Float64Array(n),cloudColumnCache=new Array<PlanetCloudColumnDiagnosis|undefined>(n),cloudColumnStamp=new Float64Array(n).fill(-1);
  const fluxMass=new Float64Array(L),fluxMomentum=new Float64Array(L*3),fluxTheta=new Float64Array(L),fluxVapor=new Float64Array(L),fluxLiquid=new Float64Array(L),fluxIce=new Float64Array(L),fluxDust=new Float64Array(L),fluxMaterial=new Float64Array(L*3),phi0=new Float64Array(n),phi1=new Float64Array(n),temperature=new Float64Array(L),exner=new Float64Array(L);
  let tick=0,pendingSeconds=0,maxCourant=0,absorbedStellarJoules=0,reflectedStellarJoules=0,outgoingRadiationJoules=0;
  let cloudColumnEpoch=0,cloudColumnDiagnosisCount=0;
  let seed=recipe.seed>>>0;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const dir=(i:number):Vec=>[grid.directions[i*3],grid.directions[i*3+1],grid.directions[i*3+2]];
  let minColumn=Infinity,surfaceHash=2166136261;const hashBuffer=new ArrayBuffer(8),hashView=new DataView(hashBuffer);
  for(let i=0;i<n;i++){
    const d=dir(i),surface=sampleSurface?.(d)??{heightMeters:0,waterFraction:1};
    bounded(surface.heightMeters,'surface height',-p.radiusMeters*.05,p.radiusMeters*.05);bounded(surface.waterFraction,'water fraction',0,1);
    const altitude=Math.max(0,surface.heightMeters);if(altitude>H*8)throw Error('Atmosphere terrain exceeds eight scale heights.');waterFraction[i]=surface.waterFraction;surfaceAltitude[i]=altitude;
    for(const value of [surface.heightMeters,surface.waterFraction]){hashView.setFloat64(0,value,true);for(let byte=0;byte<8;byte++)surfaceHash=Math.imul(surfaceHash^hashView.getUint8(byte),16777619)>>>0;}
    bottom[i]=H*(1-Math.exp(-altitude/H));const column=H-bottom[i];minColumn=Math.min(minColumn,column);
    surfaceTemperature[i]=p.equilibriumTemperatureKelvin+(.5-random())*.0002;
    const reservoir=surface.waterFraction*1000*p.oceanMixedLayerDepthMeters+(1-surface.waterFraction)*p.surfaceMoisture*30;
    (surfaceTemperature[i]<FREEZE?surfaceIce:surfaceWater)[i]=reservoir;surfaceDust[i]=20*p.dustAvailability*(1-surface.waterFraction);
    heatCapacity[i]=surface.waterFraction*1000*4184*p.oceanMixedLayerDepthMeters+(1-surface.waterFraction)*2e6;
  }
  revision=generationDataRevision({algorithm:'persistent-moist-atmosphere-3-mixed-phase-dissipation',recipe,surfaceHash});
  const climate=initialClimate(p);
  for(let i=0;i<n;i++){
    const coordinate=(Math.asin(grid.directions[i*3+1])/Math.PI+.5)*climate.length-.5,lo=clamp(Math.floor(coordinate),0,climate.length-1),hi=Math.min(climate.length-1,lo+1),blend=clamp(coordinate-lo,0,1);
    surfaceTemperature[i]=climate[lo]*(1-blend)+climate[hi]*blend+(surfaceTemperature[i]-p.equilibriumTemperatureKelvin);
    const reservoir=surfaceWater[i]+surfaceIce[i];surfaceWater[i]=surfaceTemperature[i]<FREEZE?0:reservoir;surfaceIce[i]=surfaceTemperature[i]<FREEZE?reservoir:0;
  }
  // Constant upper pseudoheight makes both reference pressure potentials exactly
  // balanced over topography. h is mass/rho, not the rendered cloud altitude.
  const upperH=Math.min(H*.28,minColumn*.45),upperFraction=upperH/H,thetaReference:[number,number]=[(p.equilibriumTemperatureKelvin-8)/(((1+upperFraction)*.5)**kappa),(p.equilibriumTemperatureKelvin-48)/((upperFraction*.5)**kappa)];
  for(let i=0;i<n;i++){
    const h1=upperH,h0=H-bottom[i]-h1;airMass[i]=rho*h0;airMass[n+i]=rho*h1;
    const pressures=[g*(airMass[n+i]+airMass[i]*.5),g*airMass[n+i]*.5];
    for(let layer=0;layer<2;layer++){
      const j=i+layer*n,e=(pressures[layer]/p.surfacePressurePascals)**kappa,t=thetaReference[layer]*e*surfaceTemperature[i]/p.equilibriumTemperatureKelvin*(1+(.5-random())*1e-7);
      exner[j]=e;temperature[j]=t;potentialTemperatureMass[j]=airMass[j]*t/e;
      vapor[j]=airMass[j]*planetAtmosphereSaturationSpecificHumidity(t,pressures[layer],p.meanMolarMassKgPerMol)*p.initialRelativeHumidity*(layer?.5:1);
      for(let k=0;k<3;k++)material[j*3+k]=airMass[j]*grid.directions[i*3+k];
    }
  }
  const alpha=Math.max(1.01,thetaReference[1]/thetaReference[0]),waveSpeed=Math.sqrt(g*H*(1+alpha));
  let minLength=Infinity;for(let i=0;i<n;i++)minLength=Math.min(minLength,grid.areas[i]/grid.perimeters[i]);
  let minimumAirMass=Infinity;for(const mass of airMass)minimumAirMass=Math.min(minimumAirMass,mass);
  // Thin air can radiatively adjust much faster than an acoustic crossing.
  // Bound explicit thermal updates using ε<=1 and the supported 600K ceiling;
  // low-pressure worlds spend more worker ticks instead of hiding a large jump.
  const radiativeTickSeconds=.2*cp*minimumAirMass/(4*SIGMA*600**3);
  const fixedTickSeconds=Math.min(30,minLength*.4/(waveSpeed+300),radiativeTickSeconds);
  const allArrays=[airMass,momentum,potentialTemperatureMass,vapor,liquid,ice,dust,material,surfaceWater,surfaceIce,surfaceDust,surfaceTemperature];
  const massArrays=[airMass,potentialTemperatureMass,vapor,liquid,ice,dust,surfaceWater,surfaceIce,surfaceDust];
  const tracerFields=[potentialTemperatureMass,vapor,liquid,ice,dust],tracerDeltas=[fluxTheta,fluxVapor,fluxLiquid,fluxIce,fluxDust],waterDustFields=[vapor,liquid,ice,dust],vectorFields=[momentum,material],fluxArrays=[fluxMass,fluxMomentum,fluxTheta,fluxVapor,fluxLiquid,fluxIce,fluxDust,fluxMaterial];
  const stateBytes=allArrays.reduce((sum,a)=>sum+a.byteLength,0)+[fluxMass,fluxMomentum,fluxTheta,fluxVapor,fluxLiquid,fluxIce,fluxDust,fluxMaterial,phi0,phi1,temperature,exner,grid.directions,grid.areas,grid.perimeters,waterFraction,bottom,heatCapacity,surfaceAltitude,cloudColumnStamp].reduce((sum,a)=>sum+a.byteLength,0)+grid.edges.length*160+n*(64+256);
  if(stateBytes>PLANET_ATMOSPHERE_LIMITS.maxStateBytes)throw Error('Atmosphere state exceeds memory budget.');
  const totals=():[number,number,number]=>{let air=0,water=0,dirt=0;for(let i=0;i<n;i++){const a=grid.areas[i];air+=(airMass[i]+airMass[n+i])*a;water+=(vapor[i]+liquid[i]+ice[i]+vapor[n+i]+liquid[n+i]+ice[n+i]+surfaceWater[i]+surfaceIce[i])*a;dirt+=(dust[i]+dust[n+i]+surfaceDust[i])*a;}return[air,water,dirt];};
  const initialTotals=totals();
  const refreshThermal=()=>{for(let i=0;i<n;i++)for(let layer=0;layer<2;layer++){const j=i+layer*n,pressure=layer?g*airMass[n+i]*.5:g*(airMass[n+i]+airMass[i]*.5);exner[j]=(pressure/p.surfacePressurePascals)**kappa;temperature[j]=potentialTemperatureMass[j]/airMass[j]*exner[j];}};
  const heat=(j:number,joulesPerM2:number)=>{potentialTemperatureMass[j]+=joulesPerM2/(cp*exner[j]);temperature[j]+=joulesPerM2/(cp*airMass[j]);};
  const move=(from:number,to:number,amount:number)=>{if(amount<=0)return;const fraction=amount/airMass[from];for(const field of tracerFields){const q=field[from]*fraction;field[from]-=q;field[to]+=q;}for(const field of vectorFields)for(let k=0;k<3;k++){const q=field[from*3+k]*fraction;field[from*3+k]-=q;field[to*3+k]+=q;}airMass[from]-=amount;airMass[to]+=amount;};
  const radiationInput:PlanetAtmosphereRadiativeColumn={incidentStellarWm2:0,surfaceAlbedo:p.surfaceAlbedo,surfaceTemperatureKelvin:p.equilibriumTemperatureKelvin,lower:{temperatureKelvin:280,gasOpticalDepth:p.greenhouseOpticalDepth*.65,liquidKgM2:0,iceKgM2:0,dustKgM2:0},upper:{temperatureKelvin:240,gasOpticalDepth:p.greenhouseOpticalDepth*.35,liquidKgM2:0,iceKgM2:0,dustKgM2:0}},radiationResult=radiativeBudget(),lowerSolar:TwoStreamLayer={reflection:0,transmission:1,absorption:0},upperSolar:TwoStreamLayer={reflection:0,transmission:1,absorption:0};
  const remapPressureLayers=(i:number)=>{
    const upper=i+n,referenceFraction=upperH/(H-bottom[i]),target=referenceFraction*(airMass[i]+airMass[upper]),upward=target-airMass[upper];
    if(upward>0)move(i,upper,upward);else move(upper,i,-upward);
  };
  function step():void {
    const dt=fixedTickSeconds;refreshThermal();
    for(const a of fluxArrays)a.fill(0);
    let stepCourant=0;
    for(let i=0;i<n;i++){
      const h0=airMass[i]/rho,h1=airMass[n+i]/rho;
      phi0[i]=g*(bottom[i]+h0+h1);phi1[i]=g*(bottom[i]+h0+alpha*h1);
    }
    for(const edge of grid.edges){
      const {a,b,length,normal,normalA,normalB}=edge;
      for(let layer=0;layer<2;layer++){
        const ia=a+layer*n,ib=b+layer*n,ma=airMass[ia],mb=airMass[ib],ua=(momentum[ia*3]*normal[0]+momentum[ia*3+1]*normal[1]+momentum[ia*3+2]*normal[2])/ma,ub=(momentum[ib*3]*normal[0]+momentum[ib*3+1]*normal[1]+momentum[ib*3+2]*normal[2])/mb;
        const c=Math.sqrt(g*Math.max((airMass[a]+alpha*airMass[n+a])/rho,(airMass[b]+alpha*airMass[n+b])/rho)),speed=Math.max(Math.abs(ua),Math.abs(ub))+c;
        const ba=layer?0:bottom[a],bb=layer?0:bottom[b],raised=Math.max(ba,bb),ra=Math.max(0,ma-rho*(raised-ba)),rb=Math.max(0,mb-rho*(raised-bb));
        const f=(.5*(ra*ua+rb*ub)-.5*speed*(rb-ra))*length,donor=f>=0?ia:ib,donorMass=airMass[donor];
        const wa=dt/grid.areas[a],wb=dt/grid.areas[b];fluxMass[ia]-=f*wa;fluxMass[ib]+=f*wb;
        for(let channel=0;channel<tracerFields.length;channel++){const q=f*tracerFields[channel][donor]/donorMass,delta=tracerDeltas[channel];delta[ia]-=q*wa;delta[ib]+=q*wb;}
        // Surface pressure is set by column mass. Hydrostatic expansion of a
        // warm column first changes upper-level pressure, allowing upper
        // divergence and lower convergence rather than blowing surface air
        // away from every warm surface cell.
        const potential=layer?phi1:phi0,thermal=layer?.5*g*H*((potentialTemperatureMass[b]/airMass[b]-potentialTemperatureMass[a]/airMass[a])/thetaReference[0]+(potentialTemperatureMass[ib]/mb-potentialTemperatureMass[ia]/ma)/thetaReference[1]):0,gradient=.5*(potential[b]-potential[a]+thermal)*length;
        for(let k=0;k<3;k++){
          const advect=f*momentum[donor*3+k]/donorMass,diffusion=.25*speed*Math.min(ra,rb)*(momentum[ib*3+k]/mb-momentum[ia*3+k]/ma)*length;
          fluxMomentum[ia*3+k]+=(-advect+diffusion-ma*gradient*normalA[k])*wa;
          fluxMomentum[ib*3+k]+=(advect-diffusion-mb*gradient*normalB[k])*wb;
          const label=f*material[donor*3+k]/donorMass;fluxMaterial[ia*3+k]-=label*wa;fluxMaterial[ib*3+k]+=label*wb;
        }
        stepCourant=Math.max(stepCourant,speed*dt*grid.perimeters[a]/grid.areas[a],speed*dt*grid.perimeters[b]/grid.areas[b]);
      }
    }
    if(stepCourant>.45)throw Error(`Atmosphere CFL exceeded (${stepCourant}); checkpoint and use finer physical ticks.`);
    maxCourant=Math.max(maxCourant,stepCourant);
    for(let j=0;j<L;j++){
      airMass[j]+=fluxMass[j];potentialTemperatureMass[j]+=fluxTheta[j];vapor[j]+=fluxVapor[j];liquid[j]+=fluxLiquid[j];ice[j]+=fluxIce[j];dust[j]+=fluxDust[j];
      for(let k=0;k<3;k++){momentum[j*3+k]+=fluxMomentum[j*3+k];material[j*3+k]+=fluxMaterial[j*3+k];}
      const i=j%n,dx=grid.directions[i*3],dy=grid.directions[i*3+1],dz=grid.directions[i*3+2],radial=momentum[j*3]*dx+momentum[j*3+1]*dy+momentum[j*3+2]*dz;
      const x=momentum[j*3]-radial*dx,y=momentum[j*3+1]-radial*dy,z=momentum[j*3+2]-radial*dz,angle=-2*omega*dy*dt,cos=Math.cos(angle),sin=Math.sin(angle),drag=Math.exp(-dt/(j<n?86400:864000));
      momentum[j*3]=(x*cos+(dy*z-dz*y)*sin)*drag;momentum[j*3+1]=(y*cos+(dz*x-dx*z)*sin)*drag;momentum[j*3+2]=(z*cos+(dx*y-dy*x)*sin)*drag;
    }
    // Conservative sigma-coordinate remapping. Different horizontal layer
    // divergences diagnose interlayer ascent/subsidence; no atmospheric mass
    // is created and moisture only rises with the actually transported air.
    for(let i=0;i<n;i++)remapPressureLayers(i);
    refreshThermal();
    const sun=samplePlanetAtmosphereCelestial(p,tick*dt).sunDirection;
    for(let i=0;i<n;i++){
      const upper=n+i,ts=surfaceTemperature[i],speed=Math.hypot(momentum[i*3],momentum[i*3+1],momentum[i*3+2])/airMass[i],bulkSpeed=Math.hypot(speed,1),columnPressure=g*(airMass[i]+airMass[upper]);
      const solar=p.stellarFluxWattsPerSquareMeter*Math.max(0,grid.directions[i*3]*sun[0]+grid.directions[i*3+1]*sun[1]+grid.directions[i*3+2]*sun[2]);
      radiationInput.incidentStellarWm2=solar;radiationInput.surfaceTemperatureKelvin=ts;radiationInput.lower.temperatureKelvin=temperature[i];radiationInput.upper.temperatureKelvin=temperature[upper];
      radiationInput.lower.liquidKgM2=liquid[i];radiationInput.lower.iceKgM2=ice[i];radiationInput.lower.dustKgM2=dust[i];radiationInput.upper.liquidKgM2=liquid[upper];radiationInput.upper.iceKgM2=ice[upper];radiationInput.upper.dustKgM2=dust[upper];
      const radiation=radiativeColumn(radiationInput,radiationResult,lowerSolar,upperSolar);
      const localRho=columnPressure/(rGas*temperature[i]),sensible=localRho*cp*.0012*bulkSpeed*(ts-temperature[i]);
      const surfaceQ=radiation.surfaceNetWm2-sensible;
      surfaceTemperature[i]+=surfaceQ*dt/heatCapacity[i];heat(i,(radiation.lowerNetWm2+sensible)*dt);heat(upper,radiation.upperNetWm2*dt);
      absorbedStellarJoules+=(solar-radiation.reflectedStellarWm2)*dt*grid.areas[i];reflectedStellarJoules+=radiation.reflectedStellarWm2*dt*grid.areas[i];outgoingRadiationJoules+=radiation.outgoingLongwaveWm2*dt*grid.areas[i];
      const frozen=surfaceTemperature[i]<FREEZE,reservoir=frozen?surfaceIce:surfaceWater,latent=frozen?LS:LV;
      const deficit=planetAtmosphereSaturationSpecificHumidity(surfaceTemperature[i],columnPressure,p.meanMolarMassKgPerMol)-vapor[i]/airMass[i];
      const moisture=waterFraction[i]+(1-waterFraction[i])*p.surfaceMoisture;
      const evaporation=Math.min(reservoir[i],Math.max(0,deficit)*localRho*.0012*bulkSpeed*moisture*dt,Math.max(0,surfaceTemperature[i]-90)*heatCapacity[i]/latent);
      reservoir[i]-=evaporation;vapor[i]+=evaporation;surfaceTemperature[i]-=latent*evaporation/heatCapacity[i];
      // Equal air parcels exchange heat/tracers: boundary-layer diffusion plus
      // faster convective adjustment when potential temperature is unstable.
      const theta0=potentialTemperatureMass[i]/airMass[i],theta1=potentialTemperatureMass[upper]/airMass[upper],unstable=Math.max(0,(theta0-theta1)/Math.max(1,theta1));
      let shearSquared=1;for(let k=0;k<3;k++)shearSquared+=(momentum[i*3+k]/airMass[i]-momentum[upper*3+k]/airMass[upper])**2;
      const richardson=Math.max(0,g*H*.5*(theta1-theta0)/((theta0+theta1)*.5*shearSquared));
      const fraction=1-Math.exp(-dt*(1/(172800*(1+5*richardson))+Math.min(1,unstable*10)/1800)),parcel=Math.min(airMass[i],airMass[upper])*fraction;
      for(const field of waterDustFields){const q=parcel*(field[i]/airMass[i]-field[upper]/airMass[upper]);field[i]-=q;field[upper]+=q;}
      const commonTheta=(airMass[i]*temperature[i]+airMass[upper]*temperature[upper])/(airMass[i]*exner[i]+airMass[upper]*exner[upper]);
      const energy=fraction*cp*airMass[i]*(commonTheta*exner[i]-temperature[i]);heat(i,energy);heat(upper,-energy);
      for(const field of vectorFields)for(let k=0;k<3;k++){const q=parcel*(field[i*3+k]/airMass[i]-field[upper*3+k]/airMass[upper]);field[i*3+k]-=q;field[upper*3+k]+=q;}
      for(let layer=0;layer<2;layer++){
        const j=i+layer*n,pressure=g*(layer?airMass[upper]*.5:airMass[upper]+airMass[i]*.5),m=airMass[j],t=temperature[j],qs=planetAtmosphereSaturationSpecificHumidity(t,pressure,p.meanMolarMassKgPerMol);
        const available=vapor[j],condensate=liquid[j]+ice[j];
        if(available>m*qs){
          const latentHeat=t<FREEZE?LS:LV;let lo=0,hi=available;
          for(let iteration=0;iteration<20;iteration++){const q=(lo+hi)*.5,target=m*planetAtmosphereSaturationSpecificHumidity(t+latentHeat*q/(cp*m),pressure,p.meanMolarMassKgPerMol);if(available-q>target)lo=q;else hi=q;}
          const amount=(lo+hi)*.5*(1-Math.exp(-dt/120));vapor[j]-=amount;(t<FREEZE?ice:liquid)[j]+=amount;heat(j,latentHeat*amount);
        }else if(condensate>0){
          // Both phases share the relaxation time. Solve their combined vapor
          // demand and latent cooling, then remove each in proportion to its
          // inventory. Selecting just liquid whenever any exists lets tiny
          // advected liquid traces indefinitely shield ice from sublimation.
          const liquidFraction=liquid[j]/condensate,iceFraction=ice[j]/condensate,latentHeat=LV*liquidFraction+LS*iceFraction;let lo=0,hi=Math.min(condensate,Math.max(0,t-90)*cp*m/latentHeat);
          for(let iteration=0;iteration<20;iteration++){const q=(lo+hi)*.5,target=m*planetAtmosphereSaturationSpecificHumidity(t-latentHeat*q/(cp*m),pressure,p.meanMolarMassKgPerMol);if(available+q<target)lo=q;else hi=q;}
          const amount=(lo+hi)*.5*(1-Math.exp(-dt/120)),liquidLoss=amount*liquidFraction,iceLoss=amount*iceFraction;
          liquid[j]-=liquidLoss;ice[j]-=iceLoss;vapor[j]+=liquidLoss+iceLoss;heat(j,-LV*liquidLoss-LS*iceLoss);
        }
        if(temperature[j]<FREEZE&&liquid[j]>0){const freeze=Math.min(liquid[j],(FREEZE-temperature[j])*cp*m/LF);liquid[j]-=freeze;ice[j]+=freeze;heat(j,LF*freeze);}
        else if(temperature[j]>FREEZE&&ice[j]>0){const melt=Math.min(ice[j],(temperature[j]-FREEZE)*cp*m/LF);ice[j]-=melt;liquid[j]+=melt;heat(j,-LF*melt);}
        // All condensate sediments, including trace ice. A threshold-only ice
        // sink gives thin cirrus an infinite lifetime and eventually fills the
        // entire atmosphere by numerical/material transport. Stokes velocities
        // use the same 10um liquid /25um ice radii as the optical model; larger
        // precipitating particles are represented by excess-mass conversion.
        const viscosity=(p.gas==='carbon-dioxide'?1.37e-5:1.8e-5)*(temperature[j]/273.15)**.7,path=H*(layer?.5:.25);
        const liquidVelocity=2*1000*g*1e-10/(9*viscosity),iceVelocity=2*917*g*6.25e-10/(9*viscosity);
        const rain=Math.min(liquid[j],liquid[j]*(1-Math.exp(-dt*liquidVelocity/path))+Math.max(0,liquid[j]-.25)*(1-Math.exp(-dt/1800)));
        const snow=Math.min(ice[j],ice[j]*(1-Math.exp(-dt*iceVelocity/path))+Math.max(0,ice[j]-.10)*(1-Math.exp(-dt/7200)));
        liquid[j]-=rain;ice[j]-=snow;if(layer){liquid[i]+=rain;ice[i]+=snow;}else{surfaceWater[i]+=rain;surfaceIce[i]+=snow;}
      }
      const settling=dust[i]*(1-Math.exp(-dt*.01*(g/9.80665)/H)),frictionVelocity=Math.sqrt(.0025)*speed,threshold=.35*Math.sqrt(1.225/Math.max(1e-9,localRho));
      const pickup=Math.min(surfaceDust[i],Math.max(0,frictionVelocity-threshold)**2*2e-6*(1-moisture)*dt);surfaceDust[i]+=settling-pickup;dust[i]+=pickup-settling;
      if(surfaceTemperature[i]<FREEZE&&surfaceWater[i]>0){const q=Math.min(surfaceWater[i],(FREEZE-surfaceTemperature[i])*heatCapacity[i]/LF);surfaceWater[i]-=q;surfaceIce[i]+=q;surfaceTemperature[i]+=LF*q/heatCapacity[i];}
      else if(surfaceTemperature[i]>FREEZE&&surfaceIce[i]>0){const q=Math.min(surfaceIce[i],(surfaceTemperature[i]-FREEZE)*heatCapacity[i]/LF);surfaceIce[i]-=q;surfaceWater[i]+=q;surfaceTemperature[i]-=LF*q/heatCapacity[i];}
    }
    tick++;cloudColumnEpoch++;validateState();
  }
  function validateState():void {
    for(const field of allArrays)for(const v of field)if(!Number.isFinite(v))throw Error('Atmosphere produced a nonfinite state; restore a checkpoint.');
    for(const field of massArrays)for(const v of field)if(v<0)throw Error('Atmosphere produced negative conserved mass; restore a checkpoint.');
    for(let j=0;j<L;j++)if(airMass[j]<=rho*H*1e-8)throw Error('Atmosphere layer collapsed outside the two-layer approximation.');
    refreshThermal();for(const t of temperature)bounded(t,'evolving air temperature',80,600);for(const t of surfaceTemperature)bounded(t,'evolving surface temperature',80,600);
  }
  function inspection():PlanetAtmosphereInspection {
    const total=totals();let wind=0,cloudy=0,condensed=0,area=0,surfaceMean=0;
    for(let i=0;i<n;i++){const a=grid.areas[i],q=liquid[i]+liquid[n+i]+ice[i]+ice[n+i];condensed+=q*a;if(q>.0001)cloudy+=a;area+=a;surfaceMean+=surfaceTemperature[i]*a;for(let layer=0;layer<2;layer++){const j=i+layer*n;wind=Math.max(wind,Math.hypot(momentum[j*3],momentum[j*3+1],momentum[j*3+2])/airMass[j]);}}
    const error=(v:number,initial:number)=>initial===0?v:Math.abs(v/initial-1);
    return{revision,timeSeconds:tick*fixedTickSeconds,tick,resolution:recipe.resolution,cellCount:n,edgeCount:grid.edges.length,fixedTickSeconds,pendingSeconds,stateBytes,maxCourant,maxWindMetersPerSecond:wind,cloudColumnDiagnosisCount,airMassKg:total[0],waterMassKg:total[1],dustMassKg:total[2],airMassRelativeError:error(total[0],initialTotals[0]),waterMassRelativeError:error(total[1],initialTotals[1]),dustMassRelativeError:error(total[2],initialTotals[2]),condensedWaterKg:condensed,cloudyAreaFraction:cloudy/area,meanSurfaceTemperatureKelvin:surfaceMean/area,absorbedStellarJoules,reflectedStellarJoules,outgoingRadiationJoules,scope:'Persistent coarse two-layer moist shallow atmosphere; resolved circulation and condensate, parameterized convection/radiation/precipitation. Hurricane eyes, vertical turbulence, CO2 frost and scientific climate prediction are outside this model.'};
  }
  function snapshot():PlanetAtmosphereStateSnapshot{return{kind:'planet-atmosphere-state',version:1,revision,tick,timeSeconds:tick*fixedTickSeconds,airMass:airMass.slice(),momentum:momentum.slice(),potentialTemperatureMass:potentialTemperatureMass.slice(),vapor:vapor.slice(),liquid:liquid.slice(),ice:ice.slice(),dust:dust.slice(),material:material.slice(),surfaceWater:surfaceWater.slice(),surfaceIce:surfaceIce.slice(),surfaceDust:surfaceDust.slice(),surfaceTemperature:surfaceTemperature.slice(),initialTotals:[...initialTotals],absorbedStellarJoules,reflectedStellarJoules,outgoingRadiationJoules};}
  function restore(s:PlanetAtmosphereStateSnapshot):void {
    if(!s||s.kind!=='planet-atmosphere-state'||s.version!==1||s.revision!==revision||!Number.isSafeInteger(s.tick)||s.tick<0||!Number.isFinite(s.timeSeconds)||s.timeSeconds<0||s.timeSeconds>PLANET_ATMOSPHERE_LIMITS.maxPhysicalSeconds||s.timeSeconds!==s.tick*fixedTickSeconds)throw Error('Atmosphere checkpoint identity or physical clock mismatch.');
    const entries={airMass,momentum,potentialTemperatureMass,vapor,liquid,ice,dust,material,surfaceWater,surfaceIce,surfaceDust,surfaceTemperature};
    for(const [key,destination]of Object.entries(entries)){const source=s[key as keyof typeof entries];if(!(source instanceof Float64Array)||source.length!==destination.length||source.some(v=>!Number.isFinite(v)))throw Error('Atmosphere checkpoint has invalid field '+key);}
    for(const key of ['airMass','potentialTemperatureMass','vapor','liquid','ice','dust','surfaceWater','surfaceIce','surfaceDust'] as const)if(s[key].some(v=>v<0))throw Error('Atmosphere checkpoint has negative mass.');
    if(s.airMass.some(v=>v<=rho*H*1e-8)||s.surfaceTemperature.some(v=>v<80||v>600)||!Array.isArray(s.initialTotals)||s.initialTotals.length!==3||s.initialTotals.some(v=>!Number.isFinite(v)||v<0)||s.initialTotals[0]<=0||!Number.isFinite(s.absorbedStellarJoules)||s.absorbedStellarJoules<0||!Number.isFinite(s.reflectedStellarJoules)||s.reflectedStellarJoules<0||!Number.isFinite(s.outgoingRadiationJoules)||s.outgoingRadiationJoules<0)throw Error('Atmosphere checkpoint is outside physical bounds.');
    for(let j=0;j<L;j++){
      const i=j%n,m=s.airMass[j],pressure=g*(j<n?s.airMass[n+i]+s.airMass[i]*.5:s.airMass[n+i]*.5),t=s.potentialTemperatureMass[j]/m*(pressure/p.surfacePressurePascals)**kappa;
      if(t<80||t>600)throw Error('Atmosphere checkpoint has invalid thermal state.');
      if(Math.hypot(s.material[j*3],s.material[j*3+1],s.material[j*3+2])>m*(1+1e-8))throw Error('Atmosphere checkpoint material labels violate conservative parcel bounds.');
      const magnitude=Math.hypot(s.momentum[j*3],s.momentum[j*3+1],s.momentum[j*3+2]),radial=s.momentum[j*3]*grid.directions[i*3]+s.momentum[j*3+1]*grid.directions[i*3+1]+s.momentum[j*3+2]*grid.directions[i*3+2];
      if(Math.abs(radial)>Math.max(1,magnitude)*1e-8)throw Error('Atmosphere checkpoint momentum must be tangent to its spherical cell.');
      const speed=magnitude/m+Math.sqrt(g*(s.airMass[i]+alpha*s.airMass[n+i])/rho);
      if(speed*fixedTickSeconds*grid.perimeters[i]/grid.areas[i]>.45)throw Error('Atmosphere checkpoint exceeds the physical-tick CFL budget.');
    }
    const restoredTotals:[number,number,number]=[0,0,0];
    for(let i=0;i<n;i++){const a=grid.areas[i];restoredTotals[0]+=(s.airMass[i]+s.airMass[n+i])*a;restoredTotals[1]+=(s.vapor[i]+s.liquid[i]+s.ice[i]+s.vapor[n+i]+s.liquid[n+i]+s.ice[n+i]+s.surfaceWater[i]+s.surfaceIce[i])*a;restoredTotals[2]+=(s.dust[i]+s.dust[n+i]+s.surfaceDust[i])*a;}
    for(let k=0;k<3;k++)if(Math.abs(s.initialTotals[k]-initialTotals[k])/Math.max(1,initialTotals[k])>1e-12||Math.abs(restoredTotals[k]-initialTotals[k])/Math.max(1,initialTotals[k])>1e-10)throw Error('Atmosphere checkpoint conserved inventories do not match this planet.');
    for(const [key,destination]of Object.entries(entries))destination.set(s[key as keyof typeof entries]);tick=s.tick;absorbedStellarJoules=s.absorbedStellarJoules;reflectedStellarJoules=s.reflectedStellarJoules;outgoingRadiationJoules=s.outgoingRadiationJoules;pendingSeconds=0;cloudColumnEpoch++;validateState();
  }
  function cloudColumn(i:number):PlanetCloudColumnDiagnosis {
    if(cloudColumnStamp[i]!==cloudColumnEpoch){
      cloudColumnCache[i]=diagnosePlanetCloudColumn({physics:p,surfaceHeightMetersAsl:surfaceAltitude[i],surfaceTemperatureKelvin:surfaceTemperature[i],lower:{airMassKgM2:airMass[i],temperatureKelvin:temperature[i],vaporKgM2:vapor[i],liquidKgM2:liquid[i],iceKgM2:ice[i]},upper:{airMassKgM2:airMass[n+i],temperatureKelvin:temperature[n+i],vaporKgM2:vapor[n+i],liquidKgM2:liquid[n+i],iceKgM2:ice[n+i]}});
      cloudColumnStamp[i]=cloudColumnEpoch;cloudColumnDiagnosisCount++;
    }
    return cloudColumnCache[i]!;
  }
  function sample(direction:PlanetVector):PlanetAtmosphereSample {
    const d=unit(direction),c=planetCoordinates(d),resolution=recipe.resolution,px=(c.u+1)*resolution*.5-.5,py=(c.v+1)*resolution*.5-.5,x0=Math.floor(px),y0=Math.floor(py),fx=px-x0,fy=py-y0;
    // Reproject each virtual neighbor across cube seams. Sampling is pure and
    // independent of view altitude; no new clouds are synthesized on descent.
    const indices:number[]=[],weights:number[]=[];
    for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
      const x=x0+dx,y=y0+dy,weight=(dx?fx:1-fx)*(dy?fy:1-fy);let face=c.face,sx=x,sy=y;
      if((x<0||x>=resolution)&&(y<0||y>=resolution)){
        // A cube vertex has three incident cells, not a privileged face. The
        // virtual diagonal must contribute symmetrically to all three, giving
        // a 1/3,1/3,1/3 limit whichever face owns an approaching query.
        const u=x<0?-1:1,v=y<0?-1:1,vertex:Vec=face===0?[1,v,-u]:face===1?[-1,v,u]:face===2?[u,1,-v]:face===3?[u,-1,v]:face===4?[u,v,1]:[-u,v,-1];
        for(const incident of [vertex[0]>0?0:1,vertex[1]>0?2:3,vertex[2]>0?4:5]){
          const cu=incident===0?-vertex[2]:incident===1?vertex[2]:incident===5?-vertex[0]:vertex[0],cv=incident===2?-vertex[2]:incident===3?vertex[2]:vertex[1];
          indices.push(incident*resolution*resolution+(cv>0?resolution-1:0)*resolution+(cu>0?resolution-1:0));weights.push(weight/3);
        }
        continue;
      }
      if(x<0||x>=resolution||y<0||y>=resolution){
        const u=-1+2*(x+.5)/resolution,v=-1+2*(y+.5)/resolution,cube:Vec=face===0?[1,v,-u]:face===1?[-1,v,u]:face===2?[u,1,-v]:face===3?[u,-1,v]:face===4?[u,v,1]:[-u,v,-1],next=planetCoordinates(cube);face=next.face;sx=Math.floor((next.u+1)*resolution*.5);sy=Math.floor((next.v+1)*resolution*.5);
      }
      indices.push(face*resolution*resolution+clamp(sy,0,resolution-1)*resolution+clamp(sx,0,resolution-1));weights.push(weight);
    }
    const value=(field:Float64Array,layer=0)=>indices.reduce((sum,i,k)=>sum+field[i+layer*n]*weights[k],0);
    const vector=(field:Float64Array,layer:number,normalize:boolean):Vec=>{const out:Vec=[0,0,0];for(let q=0;q<indices.length;q++){const j=indices[q]+layer*n,m=airMass[j];for(let k=0;k<3;k++)out[k]+=weights[q]*field[j*3+k]/m;}if(normalize)return Math.hypot(...out)<1e-12?[...d]:unit(out);const radial=dot(out,d);return[out[0]-radial*d[0],out[1]-radial*d[1],out[2]-radial*d[2]];};
    const lowerMass=value(airMass),upperMass=value(airMass,1),pressure=g*(lowerMass+upperMass),t0=value(potentialTemperatureMass)/lowerMass*(g*(upperMass+lowerMass*.5)/p.surfacePressurePascals)**kappa,t1=value(potentialTemperatureMass,1)/upperMass*(g*upperMass*.5/p.surfacePressurePascals)**kappa;
    const geometry:PlanetCloudColumnDiagnosis={surfaceHeightMetersAsl:value(surfaceAltitude),lowerBaseMetersAsl:0,lowerTopMetersAsl:0,upperBaseMetersAsl:0,upperTopMetersAsl:0,lclHeightMetersAgl:0,lclWithinAtmosphere:true,geometryClipped:false,lowerCloudOrigin:'clear',upperCloudOrigin:'clear'};
    let lowerCondensate=0,upperCondensate=0,lowerCenter=0,upperCenter=0,lowerOriginWeight=0,upperOriginWeight=0;
    for(let q=0;q<indices.length;q++){
      const i=indices[q],w=weights[q];if(w===0)continue;const column=cloudColumn(i),lowerWeight=w*(liquid[i]+ice[i]),upperWeight=w*(liquid[n+i]+ice[n+i]);
      lowerCondensate+=lowerWeight;upperCondensate+=upperWeight;geometry.lowerBaseMetersAsl+=column.lowerBaseMetersAsl*lowerWeight;geometry.lowerTopMetersAsl+=column.lowerTopMetersAsl*lowerWeight;geometry.upperBaseMetersAsl+=column.upperBaseMetersAsl*upperWeight;geometry.upperTopMetersAsl+=column.upperTopMetersAsl*upperWeight;
      lowerCenter+=w*(column.lowerBaseMetersAsl+column.lowerTopMetersAsl)*.5;upperCenter+=w*(column.upperBaseMetersAsl+column.upperTopMetersAsl)*.5;geometry.lclHeightMetersAgl+=w*column.lclHeightMetersAgl;geometry.lclWithinAtmosphere&&=column.lclWithinAtmosphere;geometry.geometryClipped||=column.geometryClipped;
      if(lowerWeight>lowerOriginWeight){lowerOriginWeight=lowerWeight;geometry.lowerCloudOrigin=column.lowerCloudOrigin;}if(upperWeight>upperOriginWeight){upperOriginWeight=upperWeight;geometry.upperCloudOrigin=column.upperCloudOrigin;}
    }
    if(lowerCondensate>0){geometry.lowerBaseMetersAsl/=lowerCondensate;geometry.lowerTopMetersAsl/=lowerCondensate;}else geometry.lowerBaseMetersAsl=geometry.lowerTopMetersAsl=lowerCenter;
    if(upperCondensate>0){geometry.upperBaseMetersAsl/=upperCondensate;geometry.upperTopMetersAsl/=upperCondensate;}else geometry.upperBaseMetersAsl=geometry.upperTopMetersAsl=upperCenter;
    return{...geometry,liquidLowerKgM2:value(liquid),liquidUpperKgM2:value(liquid,1),iceLowerKgM2:value(ice),iceUpperKgM2:value(ice,1),dustKgM2:value(dust)+value(dust,1),materialLower:vector(material,0,true),materialUpper:vector(material,1,true),pressurePascals:pressure,temperatureLowerKelvin:t0,temperatureUpperKelvin:t1,surfaceTemperatureKelvin:value(surfaceTemperature),windLowerMetersPerSecond:vector(momentum,0,false),windUpperMetersPerSecond:vector(momentum,1,false),relativeHumidityLower:value(vapor)/lowerMass/Math.max(1e-20,planetAtmosphereSaturationSpecificHumidity(t0,g*(upperMass+lowerMass*.5),p.meanMolarMassKgPerMol))};
  }
  validateState();
  return{revision,inspection,snapshot,checkpoint:snapshot,restore,sample,advanceTo(targetPhysicalSeconds,maxSubsteps=32){bounded(targetPhysicalSeconds,'target time',0,PLANET_ATMOSPHERE_LIMITS.maxPhysicalSeconds);if(!Number.isInteger(maxSubsteps)||maxSubsteps<0||maxSubsteps>PLANET_ATMOSPHERE_LIMITS.maxSubsteps)throw Error('Atmosphere maxSubsteps must be an integer from 0 to 512.');if(targetPhysicalSeconds<tick*fixedTickSeconds-1e-8)throw Error('Atmosphere cannot rewind without a checkpoint.');const goal=Math.floor(targetPhysicalSeconds/fixedTickSeconds+1e-10);if(!Number.isSafeInteger(goal))throw Error('Atmosphere target exceeds safe physical tick precision.');for(let work=0;work<maxSubsteps&&tick<goal;work++)step();pendingSeconds=Math.max(0,targetPhysicalSeconds-tick*fixedTickSeconds);return inspection();}};
}
