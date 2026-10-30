import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createPlanetPreparationSource} from '../src/client/game/planetPreparation.ts';
import {createPlanetRecipe,type PlanetPatchData,type PlanetTile} from '../src/shared/planet.ts';

type Sent={type:string;id?:number;tile?:PlanetTile;recipe?:unknown};
class FakeWorker {
  static instances:FakeWorker[]=[];
  static failInit=false;
  readonly sent:Sent[]=[];
  terminations=0;
  failPatch=false;
  onmessage:((event:MessageEvent)=>void)|null=null;
  onerror:((event:ErrorEvent)=>void)|null=null;
  onmessageerror:(()=>void)|null=null;
  constructor(){FakeWorker.instances.push(this);}
  postMessage(message:Sent){if(message.type==='init'&&FakeWorker.failInit||message.type==='patch'&&this.failPatch)throw Error('test send failed');this.sent.push(message);}
  terminate(){this.terminations++;}
  reply(id:number,data?:PlanetPatchData,error?:string){this.onmessage?.({data:{id,data,error}} as MessageEvent);}
  patches(){return this.sent.filter(m=>m.type==='patch');}
}
const tile=(x=0):PlanetTile=>({face:0,level:1,x,y:0});
const data=(key:string)=>({key}) as PlanetPatchData;
const failure=(request:Promise<PlanetPatchData>)=>request.then(()=>undefined,error=>error as Error);
function source(){const recipe=createPlanetRecipe();const result=createPlanetPreparationSource(recipe);return{source:result,worker:FakeWorker.instances.at(-1)!,recipe};}
beforeEach(()=>{FakeWorker.instances=[];FakeWorker.failInit=false;vi.stubGlobal('Worker',FakeWorker);});
afterEach(()=>vi.unstubAllGlobals());

it('initializes once and sends only one patch to the worker until its reply',async()=>{
  const {source:s,worker:w,recipe}=source(),a=s.request(tile()),b=s.request(tile(1)),first=data('first'),second=data('second');
  expect(FakeWorker.instances).toHaveLength(1);expect(w.sent[0]).toEqual({type:'init',recipe});expect(w.patches()).toEqual([{type:'patch',id:1,tile:tile()}]);
  w.reply(1,first);expect(await a).toBe(first);expect(w.patches()).toHaveLength(2);expect(w.patches()[1]).toEqual({type:'patch',id:2,tile:tile(1)});
  w.reply(2,second);expect(await b).toBe(second);s.dispose();expect(w.terminations).toBe(1);
});

it('rejects an already aborted request without enqueueing or sending work',async()=>{
  const {source:s,worker:w}=source(),abort=new AbortController();abort.abort();
  expect((await failure(s.request(tile(),abort.signal)))?.message).toMatch(/aborted/);expect(w.patches()).toHaveLength(0);s.dispose();
});

it('removes cancelled queued requests instead of computing stale patches later',async()=>{
  const {source:s,worker:w}=source(),first=s.request(tile()),cancel=new AbortController(),queued=failure(s.request(tile(1),cancel.signal)),last=s.request(tile());
  cancel.abort();expect((await queued)?.message).toMatch(/aborted/);expect(w.patches()).toHaveLength(1);
  w.reply(1,data('first'));await first;expect(w.patches().map(m=>m.id)).toEqual([1,3]);w.reply(3,data('last'));expect((await last).key).toBe('last');s.dispose();
});

it('holds an aborted active slot until its reply so repeated travel cannot create a stale worker backlog',async()=>{
  const {source:s,worker:w}=source(),cancel=new AbortController(),first=failure(s.request(tile(),cancel.signal));cancel.abort();expect((await first)?.message).toMatch(/aborted/);
  const next=s.request(tile(1));expect(w.patches()).toHaveLength(1);w.reply(1,data('obsolete'));expect(w.patches().map(m=>m.id)).toEqual([1,2]);w.reply(2,data('current'));expect((await next).key).toBe('current');s.dispose();
});

it('bounds active plus queued work to64 and cancellation releases queued capacity',async()=>{
  const {source:s,worker:w}=source(),active=failure(s.request(tile())),cancels=Array.from({length:63},()=>new AbortController()),queued=cancels.map(cancel=>failure(s.request(tile(),cancel.signal)));
  expect((await failure(s.request(tile())))?.message).toMatch(/64/);expect(w.patches()).toHaveLength(1);
  cancels.forEach(cancel=>cancel.abort());expect((await Promise.all(queued)).every(error=>error?.message.includes('aborted'))).toBe(true);
  const replacement=failure(s.request(tile(1)));expect(w.patches()).toHaveLength(1);s.dispose();expect((await active)?.message).toMatch(/disposed/);expect((await replacement)?.message).toMatch(/disposed/);expect(w.terminations).toBe(1);
});

it('isolates a patch generation failure and continues the next queued request',async()=>{
  const {source:s,worker:w}=source(),first=failure(s.request(tile())),next=s.request(tile(1));w.reply(1,undefined,'bad patch');expect((await first)?.message).toBe('bad patch');expect(w.patches()).toHaveLength(2);w.reply(2,data('valid'));expect((await next).key).toBe('valid');s.dispose();
});

it('rejects a reply with no data while allowing the worker to continue',async()=>{
  const {source:s,worker:w}=source(),first=failure(s.request(tile())),next=s.request(tile(1));w.reply(1);expect((await first)?.message).toMatch(/no patch/);w.reply(2,data('next'));expect((await next).key).toBe('next');s.dispose();
});

it.each(['worker-error','message-error','unknown-reply'] as const)('closes all outstanding requests on fatal %s and rejects new work',async kind=>{
  const {source:s,worker:w}=source(),a=failure(s.request(tile())),b=failure(s.request(tile(1)));
  if(kind==='worker-error')w.onerror?.({message:'worker crashed'} as ErrorEvent);else if(kind==='message-error')w.onmessageerror?.();else w.reply(999,data('unknown'));
  expect(await a).toBeInstanceOf(Error);expect(await b).toBeInstanceOf(Error);expect(w.terminations).toBe(1);expect((await failure(s.request(tile())))?.message).toMatch(/disposed/);s.dispose();expect(w.terminations).toBe(1);
});

it('disposes exactly once, unregisters abort listeners, and ignores late replies',async()=>{
  const {source:s,worker:w}=source(),a=new AbortController(),b=new AbortController(),removeA=vi.spyOn(a.signal,'removeEventListener'),removeB=vi.spyOn(b.signal,'removeEventListener'),first=failure(s.request(tile(),a.signal)),next=failure(s.request(tile(1),b.signal));
  s.dispose();s.dispose();expect((await first)?.message).toMatch(/disposed/);expect((await next)?.message).toMatch(/disposed/);expect(removeA).toHaveBeenCalledWith('abort',expect.any(Function));expect(removeB).toHaveBeenCalledWith('abort',expect.any(Function));w.reply(1,data('late'));a.abort();b.abort();expect(w.terminations).toBe(1);expect(w.patches()).toHaveLength(1);
});

it('closes the source if sending a patch throws instead of leaving an occupied slot forever',async()=>{
  const {source:s,worker:w}=source();w.failPatch=true;
  expect((await failure(s.request(tile())))?.message).toMatch(/send failed/);expect(w.terminations).toBe(1);expect((await failure(s.request(tile(1))))?.message).toMatch(/disposed/);s.dispose();
});

it('terminates a worker whose initialization cannot be sent',()=>{
  FakeWorker.failInit=true;expect(()=>createPlanetPreparationSource(createPlanetRecipe())).toThrow(/send failed/);expect(FakeWorker.instances[0].terminations).toBe(1);
});
