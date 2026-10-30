import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createPlanetAtmosphereSession} from '../src/client/game/planetAtmospherePreparation.ts';
import {createPlanetGeneratorRecipe,compilePlanetGenerator} from '../src/shared/planetGenerator.ts';
import type {PlanetAtmosphereSnapshot} from '../src/shared/planetAtmosphereSnapshot.ts';

const recipe=createPlanetGeneratorRecipe(),generator=compilePlanetGenerator(recipe);
class FakeWorker {
  static instances:FakeWorker[]=[];terminated=0;sent:Record<string,unknown>[]=[];
  onmessage:((event:MessageEvent)=>void)|null=null;onerror:((event:ErrorEvent)=>void)|null=null;onmessageerror:(()=>void)|null=null;
  constructor(){FakeWorker.instances.push(this);}
  postMessage(message:Record<string,unknown>){this.sent.push(message);}
  terminate(){this.terminated++;}
  reply(sequence:number,timeSeconds:number,epoch=7){
    const plane=()=>new Float32Array(64*32*4);
    const snapshot:PlanetAtmosphereSnapshot={kind:'planet-atmosphere-snapshot',version:1,epoch,sequence,timeSeconds,revision:'physics',planetRevision:'surface',radiusMeters:recipe.radiusMeters,width:64,height:32,condensate:plane(),materialLower:plane(),materialUpper:plane()};
    this.onmessage?.({data:{type:sequence?'update':'ready',epoch,generator,update:{snapshot,diagnostics:{fixedTickSeconds:30,timeSeconds}}}} as MessageEvent);
  }
}
beforeEach(()=>{FakeWorker.instances=[];vi.stubGlobal('Worker',FakeWorker);vi.useFakeTimers();});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
it('coalesces requests and continues a long target in paced chunks without changing the physical clock',async()=>{
  const promise=createPlanetAtmosphereSession(recipe,{epoch:7}),worker=FakeWorker.instances[0];worker.reply(0,0);const session=await promise;
  session.advanceTo(5000);session.advanceTo(6000);session.advanceTo(7000);
  expect(worker.sent.filter(m=>m.type==='advance').map(m=>m.timeSeconds)).toEqual([5000]);
  worker.reply(1,960);await vi.advanceTimersByTimeAsync(249);expect(worker.sent).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);expect(worker.sent.at(-1)?.timeSeconds).toBe(7000);
  worker.reply(2,1920);await vi.advanceTimersByTimeAsync(250);expect(worker.sent.at(-1)?.timeSeconds).toBe(7000);
  expect(session.latest().snapshot.timeSeconds).toBe(1920);
  worker.reply(3,6990);await vi.advanceTimersByTimeAsync(1000);expect(worker.sent).toHaveLength(4);
  expect(()=>session.advanceTo(6999)).toThrow(/monotone/);session.dispose();expect(worker.terminated).toBe(1);
});
it('rejects another planet epoch and ignores late messages after releasing the worker',async()=>{
  const error=vi.fn(),promise=createPlanetAtmosphereSession(recipe,{epoch:7,onError:error}),worker=FakeWorker.instances[0];worker.reply(0,0);const session=await promise;
  worker.reply(1,30,8);expect(error).toHaveBeenCalledOnce();expect(error.mock.calls[0][0].message).toMatch(/epoch/);expect(worker.terminated).toBe(1);
  worker.reply(2,60);expect(session.latest().snapshot.timeSeconds).toBe(0);session.dispose();expect(worker.terminated).toBe(1);
});
it('rejects stale snapshots rather than rolling the displayed weather backward',async()=>{
  const error=vi.fn(),promise=createPlanetAtmosphereSession(recipe,{epoch:7,onError:error}),worker=FakeWorker.instances[0];worker.reply(0,0);const session=await promise;
  worker.reply(1,60);worker.reply(1,30);expect(error.mock.calls[0][0].message).toMatch(/stale/);expect(session.latest().snapshot.timeSeconds).toBe(60);expect(worker.terminated).toBe(1);
});
it('cancels initialization and pending continuation without leaking a worker or timer',async()=>{
  const abort=new AbortController(),promise=createPlanetAtmosphereSession(recipe,{epoch:7,signal:abort.signal}).catch(error=>error as Error),worker=FakeWorker.instances[0];abort.abort();expect((await promise as Error).message).toMatch(/aborted/);worker.reply(0,0);expect(worker.terminated).toBe(1);expect(vi.getTimerCount()).toBe(0);
  const next=createPlanetAtmosphereSession(recipe,{epoch:7}),second=FakeWorker.instances[1];second.reply(0,0);const session=await next;session.advanceTo(5000);second.reply(1,960);session.dispose();await vi.advanceTimersByTimeAsync(30000);expect(second.sent).toHaveLength(2);expect(second.terminated).toBe(1);expect(vi.getTimerCount()).toBe(0);
});
it('bounds probe traffic and terminates a hung advance while retaining its last complete snapshot',async()=>{
  const error=vi.fn(),promise=createPlanetAtmosphereSession(recipe,{epoch:7,onError:error}),worker=FakeWorker.instances[0];worker.reply(0,0);const session=await promise;
  session.advanceTo(5000);for(let i=0;i<100;i++)session.probe([1,0,0]);
  expect(worker.sent).toHaveLength(2);await vi.advanceTimersByTimeAsync(15000);
  expect(error.mock.calls[0][0].message).toMatch(/stopped responding/);expect(worker.terminated).toBe(1);expect(session.latest().snapshot.timeSeconds).toBe(0);expect(vi.getTimerCount()).toBe(0);
});
