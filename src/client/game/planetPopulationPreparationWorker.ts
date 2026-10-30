import {compilePlanet,type PlanetRecipe,type PlanetTile} from '../../shared/planet.ts';
import {compilePlanetBiomes,type PlanetBiomeRecipe} from '../../shared/planetBiomes.ts';
import {planPlanetPopulationCell,resolvePlanetPopulationOptions,type PlanetPopulationWorld,type ResolvedPlanetPopulationOptions} from '../../shared/planetPopulation.ts';
import {bakePlanetPopulation} from '../../sandbox/planetPopulationView.ts';

type Request={type:'bake';seed:number;resolution:number}|{type:'init';planet:PlanetRecipe;biomes:PlanetBiomeRecipe}|{type:'cell';id:number;cell:PlanetTile;options:ResolvedPlanetPopulationOptions};
const scope=globalThis as unknown as {onmessage:((event:MessageEvent<Request>)=>void)|null;postMessage(data:unknown,options?:{transfer:Transferable[]}):void};
let world:PlanetPopulationWorld|undefined,busy=false,used=false;
function transfers(data:unknown):ArrayBuffer[]{const result=new Set<ArrayBuffer>();const visit=(value:unknown)=>{if(value instanceof ArrayBuffer){result.add(value);return;}if(ArrayBuffer.isView(value)){if(value.buffer instanceof ArrayBuffer)result.add(value.buffer);return;}if(value&&typeof value==='object')for(const child of Object.values(value))visit(child);};visit(data);return[...result];}
scope.onmessage=event=>{const request=event.data;void (async()=>{try{
  if(request.type==='bake'){if(used)throw Error('Population worker was already initialized.');used=true;busy=true;const bake=await bakePlanetPopulation(request.seed,{resolution:request.resolution});busy=false;scope.postMessage({bake},{transfer:transfers(bake)});return;}
  if(request.type==='init'){if(used)throw Error('Population worker was already initialized.');used=true;const planet=compilePlanet(request.planet);world={planet,biomes:compilePlanetBiomes(planet,request.biomes)};return;}
  if(!world||busy)throw Error('Population worker requires non-overlapping initialized cell requests.');busy=true;const cell=planPlanetPopulationCell(world,request.cell,resolvePlanetPopulationOptions(request.options));busy=false;scope.postMessage({id:request.id,cell});
}catch(error){busy=false;scope.postMessage({id:request.type==='cell'?request.id:undefined,error:(error instanceof Error?error.message:String(error)).slice(0,1000)});}})();};
