import {compilePlanetSky,type PlanetSkyRecipe} from '../../shared/planetSky.ts';
const scope=globalThis as unknown as {onmessage:((event:MessageEvent<{recipe:PlanetSkyRecipe;radiusMeters:number}>)=>void)|null;postMessage(data:unknown,options?:{transfer:Transferable[]}):void};
let used=false;
scope.onmessage=event=>{
  try{
    if(used)throw Error('Planet sky worker accepts one preparation request.');used=true;
    const data=compilePlanetSky(event.data.recipe,event.data.radiusMeters).bake();
    scope.postMessage({data},{transfer:[data.noise.data.buffer,data.weather.data.buffer,data.circulation.coverage.data.buffer,data.circulation.environment.data.buffer] as ArrayBuffer[]});
  }catch(error){scope.postMessage({error:(error instanceof Error?error.message:String(error)).slice(0,1000)});}
};
