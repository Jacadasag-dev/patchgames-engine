import {compilePlanet,type PlanetRecipe,type PlanetVector} from '../../shared/planet.ts';
import {compilePlanetBiomes,type PlanetBiomeRecipe} from '../../shared/planetBiomes.ts';
const scope=globalThis as unknown as {onmessage:((event:MessageEvent<{planet:PlanetRecipe;biomes:PlanetBiomeRecipe;id:string}>)=>void)|null;postMessage(data:unknown):void};
scope.onmessage=event=>{
  try{
    const planet=compilePlanet(event.data.planet),biomes=compilePlanetBiomes(planet,event.data.biomes);let best:PlanetVector|undefined,score=Infinity;
    // Bounded deterministic search for an illustrative district, kept outside
    // rendering. Generation itself is unchanged; the lab only moves its camera.
    for(let i=0;i<4800;i++){
      const y=1-2*(i+.5)/4800,angle=i*2.399963229728653,ring=Math.sqrt(1-y*y),direction:PlanetVector=[Math.cos(angle)*ring,y,Math.sin(angle)*ring];
      const sample=biomes.sample(direction);if(sample.id!==event.data.id)continue;
      const cost=sample.slope+(event.data.id==='beach'?sample.heightMeters/planet.radius*100:Math.abs(sample.heightMeters/planet.radius)*.1);
      if(cost<score){best=direction;score=cost;}if(score<.2)break;
    }
    if(!best)throw Error('No '+event.data.id+' district found in this seed.');scope.postMessage({direction:best});
  }catch(error){scope.postMessage({error:(error instanceof Error?error.message:String(error)).slice(0,1000)});}
};
