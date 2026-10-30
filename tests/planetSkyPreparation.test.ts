import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {preparePlanetSky} from '../src/client/game/planetSkyPreparation.ts';
import {compilePlanetSky,type PlanetSkyBake,type PlanetSkyRecipe} from '../src/shared/planetSky.ts';

const recipe:PlanetSkyRecipe={kind:'planet-sky',version:1,seed:123};
const radius=80_000;
const bake=compilePlanetSky(recipe,radius).bake();
class FakeWorker {
  static instances:FakeWorker[]=[];
  static failConstructor=false;
  static failSend=false;
  terminations=0;
  sent:unknown[]=[];
  onmessage:((event:MessageEvent)=>void)|null=null;
  onerror:((event:ErrorEvent)=>void)|null=null;
  onmessageerror:(()=>void)|null=null;
  constructor(){if(FakeWorker.failConstructor)throw Error('worker constructor failed');FakeWorker.instances.push(this);}
  postMessage(message:unknown){if(FakeWorker.failSend)throw Error('worker send failed');this.sent.push(message);}
  terminate(){this.terminations++;}
  reply(data?:PlanetSkyBake,error?:string){this.onmessage?.({data:{data,error}} as MessageEvent);}
}
const failure=(promise:Promise<PlanetSkyBake>)=>promise.then(()=>undefined,error=>error as Error);
beforeEach(()=>{FakeWorker.instances=[];FakeWorker.failConstructor=false;FakeWorker.failSend=false;vi.stubGlobal('Worker',FakeWorker);vi.useFakeTimers();});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

it('does not create a worker for an already-aborted preparation',async()=>{
  const cancel=new AbortController();cancel.abort();
  expect((await failure(preparePlanetSky(recipe,radius,cancel.signal)))?.message).toMatch(/aborted/);
  expect(FakeWorker.instances).toHaveLength(0);expect(vi.getTimerCount()).toBe(0);
});

it('sends only recipe data and resolves its volume bake while releasing its worker and abort listener',async()=>{
  const cancel=new AbortController(),remove=vi.spyOn(cancel.signal,'removeEventListener');
  const result=preparePlanetSky(recipe,radius,cancel.signal),worker=FakeWorker.instances[0];
  expect(worker.sent).toEqual([{recipe,radiusMeters:radius}]);expect(vi.getTimerCount()).toBe(1);
  worker.reply(bake);expect(await result).toBe(bake);
  expect(worker.terminations).toBe(1);expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));expect(vi.getTimerCount()).toBe(0);
  cancel.abort();worker.reply(undefined,'late error');worker.onerror?.({message:'late native error'} as ErrorEvent);
  await vi.advanceTimersByTimeAsync(20_001);expect(worker.terminations).toBe(1);
});

it('cancels an in-flight preparation and ignores late worker completion',async()=>{
  const cancel=new AbortController(),remove=vi.spyOn(cancel.signal,'removeEventListener');
  const result=failure(preparePlanetSky(recipe,radius,cancel.signal)),worker=FakeWorker.instances[0];
  cancel.abort();expect((await result)?.message).toMatch(/aborted/);expect(worker.terminations).toBe(1);
  worker.reply(bake);await vi.advanceTimersByTimeAsync(20_001);
  expect(worker.terminations).toBe(1);expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));expect(vi.getTimerCount()).toBe(0);
});

it('enforces the total20second preparation timeout with exact-once termination',async()=>{
  const cancel=new AbortController(),remove=vi.spyOn(cancel.signal,'removeEventListener');
  const result=failure(preparePlanetSky(recipe,radius,cancel.signal)),worker=FakeWorker.instances[0];
  await vi.advanceTimersByTimeAsync(19_999);expect(worker.terminations).toBe(0);
  await vi.advanceTimersByTimeAsync(1);expect((await result)?.message).toMatch(/20 seconds/);
  expect(worker.terminations).toBe(1);expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));expect(vi.getTimerCount()).toBe(0);
  worker.reply(bake);cancel.abort();expect(worker.terminations).toBe(1);
});

it('rejects a worker-reported generation error without leaving a timeout behind',async()=>{
  const result=failure(preparePlanetSky(recipe,radius)),worker=FakeWorker.instances[0];
  worker.reply(undefined,'invalid weather graph');expect((await result)?.message).toBe('invalid weather graph');
  expect(worker.terminations).toBe(1);expect(vi.getTimerCount()).toBe(0);
});

it('rejects missing volume data',async()=>{
  const result=failure(preparePlanetSky(recipe,radius)),worker=FakeWorker.instances[0];
  worker.reply();expect((await result)?.message).toMatch(/no volume data/);expect(worker.terminations).toBe(1);expect(vi.getTimerCount()).toBe(0);
});

it.each(['error','messageerror'] as const)('releases the worker on a native%s event',async kind=>{
  const result=failure(preparePlanetSky(recipe,radius)),worker=FakeWorker.instances[0];
  if(kind==='error')worker.onerror?.({message:'worker load failed'} as ErrorEvent);else worker.onmessageerror?.();
  expect((await result)?.message).toMatch(kind==='error'?/load failed/:/transfer failed/);
  expect(worker.terminations).toBe(1);expect(vi.getTimerCount()).toBe(0);
  worker.reply(bake);expect(worker.terminations).toBe(1);
});

it('releases the allocated worker when posting the request throws',async()=>{
  FakeWorker.failSend=true;const result=failure(preparePlanetSky(recipe,radius)),worker=FakeWorker.instances[0];
  expect((await result)?.message).toMatch(/send failed/);expect(worker.terminations).toBe(1);expect(vi.getTimerCount()).toBe(0);
});

it('propagates constructor failure without allocating timers or partial worker state',async()=>{
  FakeWorker.failConstructor=true;
  expect((await failure(preparePlanetSky(recipe,radius)))?.message).toMatch(/constructor failed/);
  expect(FakeWorker.instances).toHaveLength(0);expect(vi.getTimerCount()).toBe(0);
});
