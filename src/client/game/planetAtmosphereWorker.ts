import {compilePlanetGenerator,type PlanetGeneratorRecipe,type CompiledPlanetGenerator} from '../../shared/planetGenerator.ts';
import {createPlanetAtmosphere} from '../../shared/planetAtmosphere.ts';
import {compileGenerationMaps} from '../../shared/generationMaps.ts';
import {compilePlanet,type PlanetVector} from '../../shared/planet.ts';
import {validatePlanetAtmosphereSnapshot,type PlanetAtmosphereSnapshot} from '../../shared/planetAtmosphereSnapshot.ts';

type Request={type:'initialize';epoch:number;recipe:PlanetGeneratorRecipe;resolution:16|32|64}|{type:'advance';epoch:number;timeSeconds:number;probeDirection?:PlanetVector}|{type:'probe';epoch:number;direction:PlanetVector};
const scope=globalThis as unknown as {onmessage:((event:MessageEvent<Request>)=>void)|null;postMessage(value:unknown,transfer?:Transferable[]):void};
let simulation:ReturnType<typeof createPlanetAtmosphere>|undefined,generator:CompiledPlanetGenerator|undefined,epoch=-1,sequence=0,planetRevision='',probeDirection:PlanetVector=[0,0,1];
function direction(input:PlanetVector):PlanetVector {
  if(!Array.isArray(input)||input.length!==3||!input.every(Number.isFinite))throw Error('Atmosphere probe needs a finite direction.');
  const length=Math.hypot(...input);if(length<1e-9)throw Error('Atmosphere probe direction cannot be zero.');return[input[0]/length,input[1]/length,input[2]/length];
}
function publish(type:'ready'|'update'){
  if(!simulation||!generator)throw Error('Atmosphere is not initialized.');
  const width=128,height=width/2,length=width*height*4,condensate=new Float32Array(length),materialLower=new Float32Array(length),materialUpper=new Float32Array(length),cloudAltitudeMoments=new Float32Array(length);
  const cloudBoundsMeters:[number,number,number,number]=[Infinity,0,Infinity,0];
  for(let y=0;y<height;y++){
    const latitude=((y+.5)/height-.5)*Math.PI,c=Math.cos(latitude),s=Math.sin(latitude);
    for(let x=0;x<width;x++){
      const longitude=((x+.5)/width-.5)*2*Math.PI,index=(y*width+x)*4;
      const sample=simulation.sample(y===0?[0,-1,0]:y===height-1?[0,1,0]:[Math.sin(longitude)*c,s,Math.cos(longitude)*c]);
      condensate.set([sample.liquidLowerKgM2,sample.liquidUpperKgM2,sample.iceUpperKgM2,sample.dustKgM2],index);
      materialLower.set([...sample.materialLower,sample.iceLowerKgM2],index);materialUpper.set([...sample.materialUpper,sample.surfaceHeightMetersAsl],index);
      // Use the transferred (Float32) masses to encode moments. Both renderers
      // blend these with the same weights as mass before recovering altitude.
      const lowerMass=condensate[index]+materialLower[index+3],upperMass=condensate[index+1]+condensate[index+2];
      cloudAltitudeMoments.set([sample.lowerBaseMetersAsl*lowerMass,sample.lowerTopMetersAsl*lowerMass,sample.upperBaseMetersAsl*upperMass,sample.upperTopMetersAsl*upperMass],index);
      for(let layer=0;layer<2;layer++){const mass=layer?upperMass:lowerMass;if(mass<=0)continue;cloudBoundsMeters[layer*2]=Math.min(cloudBoundsMeters[layer*2],cloudAltitudeMoments[index+layer*2]/mass);cloudBoundsMeters[layer*2+1]=Math.max(cloudBoundsMeters[layer*2+1],cloudAltitudeMoments[index+layer*2+1]/mass);}
    }
  }
  const diagnostics=simulation.inspection();
  for(const layer of [0,1])if(!Number.isFinite(cloudBoundsMeters[layer*2]))cloudBoundsMeters[layer*2]=0;
  const snapshot:PlanetAtmosphereSnapshot={kind:'planet-atmosphere-snapshot',version:2,revision:simulation.revision,planetRevision,epoch,sequence:sequence++,timeSeconds:diagnostics.timeSeconds,radiusMeters:generator.recipe.radiusMeters,atmosphereHeightMeters:generator.diagnostics.atmosphereHeightMeters,cloudBoundsMeters,width,height,condensate,materialLower,materialUpper,cloudAltitudeMoments};
  validatePlanetAtmosphereSnapshot(snapshot);
  scope.postMessage({type,epoch,...(type==='ready'?{generator}:{}),update:{snapshot,diagnostics,probe:simulation.sample(probeDirection)}},[condensate.buffer,materialLower.buffer,materialUpper.buffer,cloudAltitudeMoments.buffer]);
}
scope.onmessage=event=>{
  const request=event.data;
  try{
    if(request.type==='initialize'){
      if(simulation)throw Error('An atmosphere worker owns exactly one planet.');
      if(!Number.isSafeInteger(request.epoch)||request.epoch<0)throw Error('Invalid atmosphere epoch.');epoch=request.epoch;
      generator=compilePlanetGenerator(request.recipe);const planet=compilePlanet(generator.planet),fields=compileGenerationMaps(generator.planet.surface.maps);planetRevision=planet.revision;
      simulation=createPlanetAtmosphere({kind:'planet-atmosphere',version:1,seed:generator.recipe.seed,resolution:request.resolution,physics:generator.physics},unit=>{
        const radius=generator!.recipe.radiusMeters,heightMeters=fields.sample(generator!.planet.surface.height,{world:[unit[0]*radius,unit[1]*radius,unit[2]*radius]});
        return{heightMeters,waterFraction:heightMeters<generator!.planet.seaLevelMeters?1:0};
      });publish('ready');return;
    }
    if(!simulation||request.epoch!==epoch)throw Error('Atmosphere request belongs to a different planet.');
    if(request.type==='probe'){probeDirection=direction(request.direction);scope.postMessage({type:'probe',epoch,probe:simulation.sample(probeDirection)});return;}
    if(request.probeDirection)probeDirection=direction(request.probeDirection);
    // Fixed solver ticks are independent of rendering and host speed. A bounded
    // chunk acknowledges actual achieved time; the host can request the rest.
    simulation.advanceTo(request.timeSeconds,32);publish('update');
  }catch(error){scope.postMessage({type:'error',epoch:request.epoch,error:(error instanceof Error?error.message:String(error)).slice(0,1000)});}
};
