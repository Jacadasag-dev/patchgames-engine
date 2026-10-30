import type {PlanetSkyBake,PlanetSkyRecipe} from '../../shared/planetSky.ts';

/** Prepare deterministic volume data in a host-owned worker. Uniform/style edits
 * reuse this bake; no texture generation belongs in an animation callback. */
export async function preparePlanetSky(recipe:PlanetSkyRecipe,radiusMeters:number,signal?:AbortSignal):Promise<PlanetSkyBake> {
  if(signal?.aborted)throw Error('Planet sky preparation aborted.');
  const worker=new Worker(new URL('./planetSkyPreparationWorker.ts',import.meta.url),{type:'module'});
  return new Promise((resolve,reject)=>{
    let done=false;
    const finish=(error?:Error,data?:PlanetSkyBake)=>{
      if(done)return;done=true;clearTimeout(timeout);signal?.removeEventListener('abort',abort);worker.terminate();
      if(error)reject(error);else resolve(data!);
    };
    const abort=()=>finish(Error('Planet sky preparation aborted.'));
    const timeout=setTimeout(()=>finish(Error('Planet sky preparation exceeded 20 seconds.')),20_000);
    signal?.addEventListener('abort',abort,{once:true});
    worker.onmessage=(event:MessageEvent<{data?:PlanetSkyBake;error?:string}>)=>{
      if(event.data?.error)finish(Error(event.data.error));
      else if(event.data?.data)finish(undefined,event.data.data);
      else finish(Error('Planet sky worker returned no volume data.'));
    };
    worker.onerror=event=>finish(Error(event.message||'Planet sky worker failed.'));
    worker.onmessageerror=()=>finish(Error('Planet sky volume transfer failed.'));
    try{worker.postMessage({recipe,radiusMeters});}catch(error){finish(error instanceof Error?error:Error(String(error)));}
  });
}
