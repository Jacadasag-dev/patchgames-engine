import type {PlanetRecipe,PlanetTile,PlanetPatchData} from '../../shared/planet.ts';
import type {PlanetPatchSource} from '../../sandbox/planetView.ts';

/** Bundler-owned worker entry. Authored callbacks are never sent to this worker. */
export function createPlanetPreparationSource(recipe:PlanetRecipe):PlanetPatchSource {
  const worker=new Worker(new URL('./planetPreparationWorker.ts',import.meta.url),{type:'module'});
  type Request={id:number;tile:PlanetTile;resolve:(data:PlanetPatchData)=>void;reject:(error:Error)=>void;signal?:AbortSignal;abort:()=>void;cancelled:boolean};
  let nextId=0,active:Request|undefined,closed=false;
  const queue:Request[]=[];
  const error=(message:string)=>new Error(message);
  const finish=(request:Request)=>request.signal?.removeEventListener('abort',request.abort);
  function drain(){
    if(closed||active)return;
    while(queue.length){const item=queue.shift()!;if(item.cancelled)continue;active=item;try{worker.postMessage({type:'patch',id:item.id,tile:item.tile});}catch(reason){close(error(reason instanceof Error?reason.message:String(reason)));}break;}
  }
  function close(reason:Error){
    if(closed)return;closed=true;worker.terminate();
    if(active){active.reject(reason);finish(active);active=undefined;}
    for(const request of queue){request.reject(reason);finish(request);}queue.length=0;
  }
  worker.onmessage=(event:MessageEvent<{id?:number;data?:PlanetPatchData;error?:string}>)=>{
    if(closed)return;const request=active;
    if(!request||event.data.id!==request.id){close(error(event.data.error??'Planet worker returned an unknown request.'));return;}
    active=undefined;finish(request);
    if(!request.cancelled){if(event.data.error)request.reject(error(event.data.error));else if(event.data.data)request.resolve(event.data.data);else request.reject(error('Planet worker returned no patch.'));}
    drain();
  };
  worker.onerror=event=>close(error(event.message||'Planet worker failed.'));
  worker.onmessageerror=()=>close(error('Planet worker transfer failed.'));
  try{worker.postMessage({type:'init',recipe});}catch(reason){close(error(reason instanceof Error?reason.message:String(reason)));throw reason;}
  return{
    request(tile,signal){
      if(closed)return Promise.reject(error('Planet preparation source is disposed.'));
      if(signal?.aborted)return Promise.reject(error('Planet patch request aborted.'));
      if(queue.length+(active?1:0)>=64)return Promise.reject(error('Planet preparation queue exceeds 64 patches.'));
      return new Promise((resolve,reject)=>{
        const request:Request={id:++nextId,tile,resolve,reject,signal,cancelled:false,abort:()=>{
          request.cancelled=true;request.reject(error('Planet patch request aborted.'));finish(request);
          const index=queue.indexOf(request);if(index>=0)queue.splice(index,1);
          // An active worker must reply before another request starts. Aborting
          // cannot silently accumulate unbounded stale computation behind it.
        }};
        signal?.addEventListener('abort',request.abort,{once:true});queue.push(request);drain();
      });
    },
    dispose(){close(error('Planet preparation source disposed.'));},
  };
}
