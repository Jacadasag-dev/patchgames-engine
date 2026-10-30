import {compilePlanet,type CompiledPlanet,type PlanetRecipe,type PlanetTile} from '../../shared/planet.ts';
import {compilePlanetBiomes,type PlanetBiomeRecipe,type CompiledPlanetBiomes} from '../../shared/planetBiomes.ts';
import {preparePlanetSurfacePatch} from '../../shared/planetSurface.ts';

const scope=globalThis as unknown as {onmessage:((event:MessageEvent<{type:'init';recipe:PlanetRecipe;biomes?:PlanetBiomeRecipe}|{type:'patch';id:number;tile:PlanetTile}>)=>void)|null;postMessage(data:unknown,options?:{transfer:Transferable[]}):void};
let planet:CompiledPlanet|undefined;
let biomes:CompiledPlanetBiomes|undefined;
let initializationError='';
scope.onmessage=event=>{
  const message=event.data;
  if(message.type==='init'){
    try{if(planet||initializationError)throw Error('Planet worker was already initialized.');planet=compilePlanet(message.recipe);if(message.biomes)biomes=compilePlanetBiomes(planet,message.biomes);}
    catch(error){initializationError=error instanceof Error?error.message:String(error);}return;
  }
  try{
    if(!planet)throw Error(initializationError||'Planet worker requires initialization.');
    const patch=planet.patch(message.tile),data=biomes?preparePlanetSurfacePatch(biomes,patch):patch;
    scope.postMessage({id:message.id,data},{transfer:[data.positions.buffer,data.normals.buffer,data.colors.buffer,data.indices.buffer,...(data.uvs?[data.uvs.buffer]:[])] as ArrayBuffer[]});
  }catch(error){scope.postMessage({id:message.id,error:(error instanceof Error?error.message:String(error)).slice(0,1000)});}
};
