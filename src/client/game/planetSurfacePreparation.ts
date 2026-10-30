import type {GeneratedMaterialPixels} from '../../shared/materialGenerator.ts';
/** Generate the nine reusable terrain material recipes outside the render thread. */
export function preparePlanetSurface(seed:number,resolution:64|128|256=128,signal?:AbortSignal):Promise<GeneratedMaterialPixels[]> {
  if(signal?.aborted)return Promise.reject(Error('Planet surface preparation aborted.'));
  const worker=new Worker(new URL('./planetSurfacePreparationWorker.ts',import.meta.url),{type:'module'});
  return new Promise((resolve,reject)=>{
    let done=false;
    const finish=(error?:Error,data?:GeneratedMaterialPixels[])=>{if(done)return;done=true;clearTimeout(timeout);signal?.removeEventListener('abort',abort);worker.terminate();if(error)reject(error);else resolve(data!);};
    const abort=()=>finish(Error('Planet surface preparation aborted.')),timeout=setTimeout(()=>finish(Error('Planet surface preparation exceeded 30 seconds.')),30_000);
    signal?.addEventListener('abort',abort,{once:true});
    worker.onmessage=(event:MessageEvent<{data?:GeneratedMaterialPixels[];error?:string}>)=>event.data.error?finish(Error(event.data.error)):event.data.data?finish(undefined,event.data.data):finish(Error('Planet surface worker returned no materials.'));
    worker.onerror=event=>finish(Error(event.message||'Planet surface worker failed.'));worker.onmessageerror=()=>finish(Error('Planet surface material transfer failed.'));
    try{worker.postMessage({seed,resolution});}catch(error){finish(error instanceof Error?error:Error(String(error)));}
  });
}
