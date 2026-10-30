import {compileGenerationMaps,generationDataRevision} from './generationMaps.ts';
import {compilePlanet,createPlanetRecipe,type ResolvedPlanetRecipe,type PlanetVector} from './planet.ts';
import {compilePlanetSky,type ResolvedPlanetSkyRecipe} from './planetSky.ts';
import {createPlanetWeatherRecipe} from './planetWeather.ts';

export type PlanetGeneratorPreset='earthlike'|'marslike'|'stormworld';
export interface PlanetGeneratorRecipe {
  kind:'planet-generator';version:1;seed:number;
  radiusMeters:number;gravityMetersPerSecondSquared:number;rotationPeriodSeconds:number;axialTiltDegrees:number;
  orbitalPeriodSeconds:number;orbitalPhaseTurns:number;
  stellarFluxWattsPerSquareMeter:number;surfacePressurePascals:number;gas:'earthlike'|'carbon-dioxide';
  waterCoverage:number;surfaceMoisture:number;initialRelativeHumidity:number;
  surfaceAlbedo:number;greenhouseOpticalDepth:number;oceanMixedLayerDepthMeters:number;dustAvailability:number;terrainReliefMeters:number;
}
export type ResolvedPlanetGeneratorRecipe=Readonly<PlanetGeneratorRecipe>;
export interface PlanetGeneratorPhysics extends Readonly<PlanetGeneratorRecipe> {
  meanMolarMassKgPerMol:number;specificHeatJoulesPerKgKelvin:number;
  equilibriumTemperatureKelvin:number;scaleHeightMeters:number;surfaceDensityKgPerCubicMeter:number;
}
export interface CompiledPlanetGenerator {
  recipe:ResolvedPlanetGeneratorRecipe;revision:string;planet:ResolvedPlanetRecipe;sky:ResolvedPlanetSkyRecipe;physics:PlanetGeneratorPhysics;
  diagnostics:{waterCoverageRequested:number;waterCoverageMeasured:number;hypsometrySamples:number;sourceSeaLevelMeters:number;atmosphereHeightMeters:number;centrifugalGravityRatio:number;scope:string};
}
const R_GAS=8.314462618,SIGMA=5.670374419e-8,EARTH=6371000;
const finite=(n:number,name:string,min:number,max:number)=>{if(!Number.isFinite(n)||n<min||n>max)throw Error(`Planet generator ${name} must be within ${min}..${max}.`);return n;};
export function createPlanetGeneratorRecipe(preset:PlanetGeneratorPreset='earthlike',seed=412):PlanetGeneratorRecipe {
  const earth:PlanetGeneratorRecipe={kind:'planet-generator',version:1,seed,radiusMeters:EARTH,gravityMetersPerSecondSquared:9.80665,rotationPeriodSeconds:86164,axialTiltDegrees:23.44,orbitalPeriodSeconds:31558149,orbitalPhaseTurns:0,stellarFluxWattsPerSquareMeter:1361,surfacePressurePascals:101325,gas:'earthlike',waterCoverage:.71,surfaceMoisture:.45,initialRelativeHumidity:.60,surfaceAlbedo:.30,greenhouseOpticalDepth:.85,oceanMixedLayerDepthMeters:50,dustAvailability:.08,terrainReliefMeters:12000};
  if(preset==='earthlike')return earth;
  if(preset==='marslike')return{...earth,radiusMeters:3389500,gravityMetersPerSecondSquared:3.73,rotationPeriodSeconds:88642,axialTiltDegrees:25.19,orbitalPeriodSeconds:59355072,stellarFluxWattsPerSquareMeter:586.2,surfacePressurePascals:636,gas:'carbon-dioxide',waterCoverage:0,surfaceMoisture:.001,initialRelativeHumidity:.01,surfaceAlbedo:.25,greenhouseOpticalDepth:.05,oceanMixedLayerDepthMeters:1,dustAvailability:.85,terrainReliefMeters:24000};
  if(preset==='stormworld')return{...earth,radiusMeters:7200000,gravityMetersPerSecondSquared:10.2,rotationPeriodSeconds:43200,stellarFluxWattsPerSquareMeter:1450,surfacePressurePascals:180000,waterCoverage:.90,surfaceMoisture:.8,initialRelativeHumidity:.8,surfaceAlbedo:.28,greenhouseOpticalDepth:1.05,oceanMixedLayerDepthMeters:70,dustAvailability:.01,terrainReliefMeters:9000};
  throw Error('Unknown planet generator preset.');
}
export function resolvePlanetGeneratorRecipe(input:PlanetGeneratorRecipe):ResolvedPlanetGeneratorRecipe {
  generationDataRevision(input);
  const keys=Object.keys(createPlanetGeneratorRecipe());
  if(input.kind!=='planet-generator'||input.version!==1||Object.keys(input).some(k=>!keys.includes(k))||keys.some(k=>!(k in input)))throw Error('Use a complete version 1 planet-generator recipe.');
  if(!Number.isInteger(input.seed))throw Error('Planet generator seed must be an integer.');
  finite(input.seed,'seed',-2147483648,2147483647);
  finite(input.radiusMeters,'radius',500000,100000000);finite(input.gravityMetersPerSecondSquared,'gravity',.3,50);
  finite(input.rotationPeriodSeconds,'rotation period',3600,1e9);finite(input.axialTiltDegrees,'axial tilt',0,90);
  finite(input.orbitalPeriodSeconds,'orbital period',86400,1e12);finite(input.orbitalPhaseTurns,'orbital phase',0,1);
  finite(input.stellarFluxWattsPerSquareMeter,'stellar flux',10,5000);finite(input.surfacePressurePascals,'surface pressure',1,2000000);
  if(!['earthlike','carbon-dioxide'].includes(input.gas))throw Error('Use an earthlike or carbon-dioxide background gas.');
  for(const key of ['waterCoverage','surfaceMoisture','initialRelativeHumidity','surfaceAlbedo','dustAvailability'] as const)finite(input[key],key,0,1);
  finite(input.greenhouseOpticalDepth,'greenhouse optical depth',0,10);finite(input.oceanMixedLayerDepthMeters,'mixed layer depth',1,200);
  finite(input.terrainReliefMeters,'terrain relief',1,input.radiusMeters*.05);
  const centrifugal=(2*Math.PI/input.rotationPeriodSeconds)**2*input.radiusMeters;
  if(centrifugal>input.gravityMetersPerSecondSquared*.5)throw Error('Rotation is outside the spherical-planet approximation: centrifugal acceleration exceeds half of gravity.');
  return Object.freeze({...input});
}

/** Compile in a preparation worker. Ocean extent is solved from source terrain,
 * while clouds and storms are intentionally absent from the authoring recipe. */
export function compilePlanetGenerator(input:PlanetGeneratorRecipe):CompiledPlanetGenerator {
  const recipe=resolvePlanetGeneratorRecipe(input),r=recipe.radiusMeters;
  const molar=recipe.gas==='carbon-dioxide'?.04401:.02897,cp=recipe.gas==='carbon-dioxide'?846:1004;
  const temperature=(Math.max(.01,recipe.stellarFluxWattsPerSquareMeter*(1-recipe.surfaceAlbedo))*(1+.75*recipe.greenhouseOpticalDepth)/(4*SIGMA))**.25;
  finite(temperature,'equilibrium temperature for this water-cycle model',120,450);
  const scaleHeight=R_GAS*temperature/(molar*recipe.gravityMetersPerSecondSquared),height=scaleHeight*9.21;
  if(height>r*.1)throw Error('Atmosphere is too extended for this thin spherical atmosphere model; increase radius/gravity or lower thermal forcing.');
  const physics=Object.freeze({...recipe,meanMolarMassKgPerMol:molar,specificHeatJoulesPerKgKelvin:cp,equilibriumTemperatureKelvin:temperature,scaleHeightMeters:scaleHeight,surfaceDensityKgPerCubicMeter:recipe.surfacePressurePascals*molar/(R_GAS*temperature)});
  const raw=createPlanetRecipe(recipe.seed,r),rawFields=compileGenerationMaps(raw.surface.maps),range=rawFields.output(raw.surface.height).range;
  const maps={...raw.surface.maps.maps,generatorRelief:{type:'remap' as const,input:raw.surface.height,from:[range[0],range[1]] as [number,number],to:[-.4*recipe.terrainReliefMeters,.6*recipe.terrainReliefMeters] as [number,number],unit:'metres' as const}};
  const fields=compileGenerationMaps({...raw.surface.maps,maps}),samples:number[]=[],count=4096;
  for(let i=0;i<count;i++){const y=1-2*(i+.5)/count,a=i*Math.PI*(3-Math.sqrt(5)),ring=Math.sqrt(1-y*y),world:PlanetVector=[Math.sin(a)*ring*r,y*r,Math.cos(a)*ring*r];samples.push(fields.sample('generatorRelief',{world}));}
  samples.sort((a,b)=>a-b);
  const index=Math.floor(recipe.waterCoverage*count),sea=recipe.waterCoverage===0?-.4*recipe.terrainReliefMeters-.001:recipe.waterCoverage===1?.6*recipe.terrainReliefMeters+.001:(samples[Math.max(0,index-1)]+samples[Math.min(count-1,index)])/2;
  // Shift the source height field so the one shared sea/reference sphere is R.
  // Terrain, water, atmosphere and solver then agree about altitude zero.
  const shifted={...maps,generatorHeight:{type:'remap' as const,input:'generatorRelief',from:[-.4*recipe.terrainReliefMeters,.6*recipe.terrainReliefMeters] as [number,number],to:[-.4*recipe.terrainReliefMeters-sea,.6*recipe.terrainReliefMeters-sea] as [number,number],unit:'metres' as const}};
  const planet=compilePlanet({...raw,seaLevelMeters:0,surface:{maps:{...raw.surface.maps,maps:shifted},height:'generatorHeight'},...(recipe.gas==='carbon-dioxide'?{colors:{ocean:'#233b49',lowland:'#925236',highland:'#b87550',snow:'#e0d4ca'}}:{})}).recipe;
  const densityRatio=physics.surfaceDensityKgPerCubicMeter/1.225,scale=r/EARTH;
  if(densityRatio*scale>10)throw Error('Atmospheric optical depth exceeds the current renderer range for this radius and pressure.');
  // Physical cloud bounds arrive with each atmosphere snapshot. Disabled tiny
  // authored spans satisfy the separate art-mode recipe contract only.
  const sky=compilePlanetSky({kind:'planet-sky',version:1,seed:recipe.seed,surface:planet,celestial:{dayLengthSeconds:recipe.rotationPeriodSeconds,axialTiltDegrees:recipe.axialTiltDegrees,seasonTurns:recipe.orbitalPhaseTurns},atmosphere:{enabled:recipe.surfacePressurePascals>0,heightMeters:height,rayleighScaleHeightMeters:scaleHeight,mieScaleHeightMeters:scaleHeight*.15,rayleighStrength:densityRatio*scale,mieStrength:densityRatio*scale*.3},clouds:{enabled:recipe.surfacePressurePascals>0,density:1,coverage:.67,shapeScaleMeters:scaleHeight*.18,detailScaleMeters:Math.max(.1,scaleHeight*.03),windMetersPerSecond:[0,0,0],circulation:{...createPlanetWeatherRecipe(recipe.seed),resolution:128,coverageTarget:0,cycloneCount:0},layers:{fog:{enabled:false,bottomMeters:0,thicknessMeters:.1,density:1},cumulus:{enabled:false,bottomMeters:.1,thicknessMeters:.1,density:1},cirrus:{enabled:false,bottomMeters:.2,thicknessMeters:.1,density:1}}}},r).recipe;
  return {recipe,revision:generationDataRevision({algorithm:'planet-generator-2-local-cloud-altitudes',recipe}),planet,sky,physics,diagnostics:{waterCoverageRequested:recipe.waterCoverage,waterCoverageMeasured:samples.filter(h=>h<sea).length/count,hypsometrySamples:count,sourceSeaLevelMeters:sea,atmosphereHeightMeters:height,centrifugalGravityRatio:(2*Math.PI/recipe.rotationPeriodSeconds)**2*r/recipe.gravityMetersPerSecondSquared,scope:'Coarse terrestrial atmosphere with water phase and dust; not a scientific climate prediction or gas-giant interior model.'}};
}
