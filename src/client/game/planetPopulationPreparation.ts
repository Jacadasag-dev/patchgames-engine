import type {PlanetRecipe,PlanetTile} from '../../shared/planet.ts';
import type {PlanetBiomeRecipe} from '../../shared/planetBiomes.ts';
import {resolvePlanetPopulationOptions,type PlanetPopulationCell,type ResolvedPlanetPopulationOptions} from '../../shared/planetPopulation.ts';
import type {PlanetPopulationBake,PlanetPopulationSource} from '../../sandbox/planetPopulationView.ts';

/** Initial bounded asset bank. All branch, roof and material work is performed
 * off the render thread; the caller then uploads the completed prototype bank. */
export function preparePlanetPopulation(seed:number,options:{resolution?:number;signal?:AbortSignal}={}):Promise<PlanetPopulationBake>{
  if(options.signal?.aborted)return Promise.reject(Error('Planet population preparation aborted.'));
  if(!Number.isInteger(seed)||seed< -2147483648||seed>2147483647||![32,64,128].includes(options.resolution??64))return Promise.reject(Error('Invalid population preparation seed/resolution.'));
  const worker=new Worker(new URL('./planetPopulationPreparationWorker.ts',import.meta.url),{type:'module'});
  return new Promise((resolve,reject)=>{let done=false;const finish=(error?:Error,data?:PlanetPopulationBake)=>{if(done)return;done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);worker.terminate();if(error)reject(error);else resolve(data!);};
    const abort=()=>finish(Error('Planet population preparation aborted.')),timer=setTimeout(()=>finish(Error('Planet population preparation exceeded 60 seconds.')),60000);
    options.signal?.addEventListener('abort',abort,{once:true});worker.onmessage=(event:MessageEvent<{bake?:PlanetPopulationBake;error?:string}>)=>{if(event.data.error)finish(Error(event.data.error));else if(event.data.bake)finish(undefined,event.data.bake);else finish(Error('Population worker returned no prototype bank.'));};worker.onerror=event=>finish(Error(event.message||'Population worker failed.'));worker.onmessageerror=()=>finish(Error('Population prototype transfer failed.'));
    try{worker.postMessage({type:'bake',seed,resolution:options.resolution??64});}catch(error){finish(error instanceof Error?error:Error(String(error)));}
  });
}

/** One sequential worker with a bounded queue. Planet and biome fields compile
 * once. Cancelled active work must acknowledge before another request starts. */
export function createPlanetPopulationPreparationSource(planet:PlanetRecipe,biomes:PlanetBiomeRecipe):PlanetPopulationSource{
  const worker=new Worker(new URL('./planetPopulationPreparationWorker.ts',import.meta.url),{type:'module'});
  interface Request {id:number;cell:PlanetTile;options:ResolvedPlanetPopulationOptions;signal?:AbortSignal;abort:()=>void;resolve:(data:PlanetPopulationCell)=>void;reject:(error:Error)=>void;cancelled:boolean}
  const queue:Request[]=[];let active:Request|undefined,closed=false,nextId=0,timer:ReturnType<typeof setTimeout>|undefined;
  const finish=(request:Request)=>request.signal?.removeEventListener('abort',request.abort);
  const close=(error:Error)=>{if(closed)return;closed=true;clearTimeout(timer);worker.terminate();if(active){finish(active);active.reject(error);active=undefined;}for(const request of queue){finish(request);request.reject(error);}queue.length=0;};
  const drain=()=>{if(closed||active)return;while(queue.length){const request=queue.shift()!;if(request.cancelled)continue;active=request;timer=setTimeout(()=>close(Error('Population cell preparation exceeded 15 seconds.')),15000);try{worker.postMessage({type:'cell',id:request.id,cell:request.cell,options:request.options});}catch(error){close(error instanceof Error?error:Error(String(error)));}break;}};
  worker.onmessage=(event:MessageEvent<{id?:number;cell?:PlanetPopulationCell;error?:string}>)=>{if(closed)return;const request=active;if(!request||request.id!==event.data.id){close(Error(event.data.error??'Population worker returned an unknown request.'));return;}clearTimeout(timer);active=undefined;finish(request);if(!request.cancelled){if(event.data.error)request.reject(Error(event.data.error));else if(event.data.cell)request.resolve(event.data.cell);else request.reject(Error('Population worker returned no cell.'));}drain();};
  worker.onerror=event=>close(Error(event.message||'Population cell worker failed.'));worker.onmessageerror=()=>close(Error('Population cell transfer failed.'));
  try{worker.postMessage({type:'init',planet,biomes});}catch(error){close(error instanceof Error?error:Error(String(error)));throw error;}
  return{request(cell,options,signal){if(closed)return Promise.reject(Error('Population source is disposed.'));if(signal?.aborted)return Promise.reject(Error('Population cell request aborted.'));if(queue.length+(active?1:0)>=4)return Promise.reject(Error('Population preparation queue exceeds four cells.'));
    return new Promise((resolve,reject)=>{const request:Request={id:++nextId,cell,options:resolvePlanetPopulationOptions(options),signal,resolve,reject,cancelled:false,abort:()=>{if(request.cancelled)return;request.cancelled=true;finish(request);reject(Error('Population cell request aborted.'));const at=queue.indexOf(request);if(at>=0)queue.splice(at,1);}};signal?.addEventListener('abort',request.abort,{once:true});queue.push(request);drain();});},dispose(){close(Error('Population source disposed.'));}};
}
