import type {PlanetGeneratorRecipe,CompiledPlanetGenerator} from '../../shared/planetGenerator.ts';
import {validatePlanetAtmosphereSnapshot,type PlanetAtmosphereSnapshot} from '../../shared/planetAtmosphereSnapshot.ts';
import type {PlanetVector} from '../../shared/planet.ts';

export interface PlanetAtmosphereUpdate {snapshot:PlanetAtmosphereSnapshot;diagnostics:Record<string,unknown>;probe?:Record<string,unknown>}
export interface PlanetAtmosphereSession {
  readonly generator:CompiledPlanetGenerator;
  readonly initial:PlanetAtmosphereUpdate;
  advanceTo(timeSeconds:number,probeDirection?:PlanetVector):void;
  probe(direction:PlanetVector):void;
  latest():PlanetAtmosphereUpdate;
  dispose():void;
}
export interface PlanetAtmosphereSessionOptions {
  epoch?:number;resolution?:16|32|64;signal?:AbortSignal;
  onUpdate?:(update:PlanetAtmosphereUpdate)=>void;onError?:(error:Error)=>void;
}
/** Persistent host-owned worker. No solver work, spin-up or atlas preparation is
 * performed in the render callback. Requests replace one pending target. */
export async function createPlanetAtmosphereSession(recipe:PlanetGeneratorRecipe,options:PlanetAtmosphereSessionOptions={}):Promise<PlanetAtmosphereSession> {
  if(options.signal?.aborted)return Promise.reject(Error('Atmosphere session aborted.'));
  const worker=new Worker(new URL('./planetAtmosphereWorker.ts',import.meta.url),{type:'module'}),epoch=options.epoch??1;
  return new Promise((resolve,reject)=>{
    let closed=false,ready=false,generator:CompiledPlanetGenerator|undefined,latest:PlanetAtmosphereUpdate|undefined,initial:PlanetAtmosphereUpdate|undefined;
    let maximumTarget=0,pendingTarget:number|undefined,pendingProbe:PlanetVector|undefined,inFlight=false,probeInFlight=false,lastPosted=-Infinity,pacing:ReturnType<typeof setTimeout>|undefined,watchdog:ReturnType<typeof setTimeout>|undefined;
    const timeout=setTimeout(()=>close(Error('Planet atmosphere initialization exceeded 30 seconds.')),30000);
    const close=(error?:Error)=>{if(closed)return;closed=true;clearTimeout(timeout);clearTimeout(pacing);clearTimeout(watchdog);options.signal?.removeEventListener('abort',abort);worker.terminate();if(!ready)reject(error??Error('Atmosphere session disposed.'));else if(error)options.onError?.(error);};
    const abort=()=>close(Error('Atmosphere session aborted.'));options.signal?.addEventListener('abort',abort,{once:true});
    const postProbe=()=>{if(closed||!ready||inFlight||probeInFlight||!pendingProbe)return;probeInFlight=true;const direction=pendingProbe;pendingProbe=undefined;try{worker.postMessage({type:'probe',epoch,direction});}catch(error){close(error instanceof Error?error:Error(String(error)));}};
    const post=()=>{if(closed||!ready||inFlight||pendingTarget===undefined)return;const delay=250-(performance.now()-lastPosted);if(delay>0){if(pacing===undefined)pacing=setTimeout(()=>{pacing=undefined;post();},delay);return;}const target=pendingTarget;pendingTarget=undefined;inFlight=true;lastPosted=performance.now();watchdog=setTimeout(()=>close(Error('Atmosphere worker stopped responding for 15 seconds; the last complete weather state was retained.')),15000);try{worker.postMessage({type:'advance',epoch,timeSeconds:target,probeDirection:pendingProbe});pendingProbe=undefined;}catch(error){close(error instanceof Error?error:Error(String(error)));}};
    worker.onmessage=(event:MessageEvent<{type?:string;epoch?:number;generator?:CompiledPlanetGenerator;update?:PlanetAtmosphereUpdate;error?:string;probe?:Record<string,unknown>}>)=>{
      if(closed)return;const data=event.data;if(data.epoch!==epoch){close(Error('Atmosphere worker returned the wrong epoch.'));return;}
      if(data.error){close(Error(data.error));return;}
      if(data.type==='probe'){probeInFlight=false;if(latest&&data.probe)latest={...latest,probe:data.probe};postProbe();return;}
      if(!data.update){close(Error('Atmosphere worker returned no complete snapshot.'));return;}
      try{
        const snapshot=validatePlanetAtmosphereSnapshot(data.update.snapshot,{radiusMeters:recipe.radiusMeters,planetRevision:latest?.snapshot.planetRevision});
        if(snapshot.epoch!==epoch||latest&&(snapshot.sequence<=latest.snapshot.sequence||snapshot.timeSeconds<latest.snapshot.timeSeconds))throw Error('Atmosphere worker returned stale simulation state.');
        latest=data.update;clearTimeout(watchdog);watchdog=undefined;
        if(!ready){if(data.type!=='ready'||!data.generator)throw Error('Atmosphere worker returned no generated planet.');generator=data.generator;initial=latest;ready=true;clearTimeout(timeout);
          resolve({generator,initial,advanceTo(timeSeconds,probeDirection){if(closed)return;if(!Number.isFinite(timeSeconds)||timeSeconds<maximumTarget||timeSeconds>1e9)throw Error('Atmosphere target time must be finite, monotone and within 1e9 seconds.');maximumTarget=timeSeconds;pendingTarget=timeSeconds;if(probeDirection)pendingProbe=probeDirection;post();},probe(direction){pendingProbe=direction;postProbe();},latest(){return latest!;},dispose(){close();}});
        }else options.onUpdate?.(latest);
        // Continue a long request in paced, bounded chunks. Never synthesize
        // missing physical time or spin forever for a fraction of a fixed tick.
        const tick=Number(latest.diagnostics.fixedTickSeconds);
        if(ready&&Number.isFinite(tick)&&tick>0&&maximumTarget-latest.snapshot.timeSeconds>=tick-1e-7)pendingTarget=maximumTarget;
        inFlight=false;post();postProbe();
      }catch(error){close(error instanceof Error?error:Error(String(error)));}
    };
    worker.onerror=event=>close(Error(event.message||'Planet atmosphere worker failed.'));
    worker.onmessageerror=()=>close(Error('Planet atmosphere snapshot transfer failed.'));
    try{worker.postMessage({type:'initialize',epoch,recipe,resolution:options.resolution??16});}catch(error){close(error instanceof Error?error:Error(String(error)));}
  });
}
