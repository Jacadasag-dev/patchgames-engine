import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createPlanetPopulationPreparationSource,preparePlanetPopulation} from '../src/client/game/planetPopulationPreparation.ts';
import {createPlanetRecipe} from '../src/shared/planet.ts';
import {createPlanetBiomeRecipe} from '../src/shared/planetBiomes.ts';
import {planetPopulationCellKey,resolvePlanetPopulationOptions,type PlanetPopulationCell} from '../src/shared/planetPopulation.ts';
import type {PlanetPopulationBake} from '../src/sandbox/planetPopulationView.ts';

class FakeWorker{
  static all:FakeWorker[]=[];sent:Record<string,unknown>[]=[];terminations=0;onmessage:((event:MessageEvent)=>void)|null=null;onerror:((event:ErrorEvent)=>void)|null=null;onmessageerror:(()=>void)|null=null;
  constructor(){FakeWorker.all.push(this);}postMessage(data:Record<string,unknown>){this.sent.push(data);}terminate(){this.terminations++;}reply(data:unknown){this.onmessage?.({data}as MessageEvent);}
}
const planet=createPlanetRecipe(42,1000),biomes=createPlanetBiomeRecipe(42,1000),options=resolvePlanetPopulationOptions(),cell={face:4,level:4,x:8,y:8};
const data:PlanetPopulationCell={key:planetPopulationCellKey(cell),cell,instances:[]};
beforeEach(()=>{FakeWorker.all=[];vi.stubGlobal('Worker',FakeWorker);vi.useFakeTimers();});afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('prepares only serialized recipes and releases the one-shot bake worker on success or abort',async()=>{
  const promise=preparePlanetPopulation(42,{resolution:32}),worker=FakeWorker.all[0];expect(worker.sent).toEqual([{type:'bake',seed:42,resolution:32}]);const bank={version:1} as PlanetPopulationBake;worker.reply({bake:bank});expect(await promise).toBe(bank);expect(worker.terminations).toBe(1);expect(vi.getTimerCount()).toBe(0);
  const abort=new AbortController(),failure=preparePlanetPopulation(42,{signal:abort.signal}).catch(error=>error as Error),next=FakeWorker.all[1];abort.abort();expect((await failure as Error).message).toMatch(/aborted/);next.reply({bake:bank});expect(next.terminations).toBe(1);expect(vi.getTimerCount()).toBe(0);
});
it('sends one cell at a time, forwards the view options, and waits for cancelled active acknowledgments',async()=>{
  const source=createPlanetPopulationPreparationSource(planet,biomes),worker=FakeWorker.all[0],abort=new AbortController();expect(worker.sent).toEqual([{type:'init',planet,biomes}]);
  const first=source.request(cell,options,abort.signal).catch(error=>error as Error),second=source.request({...cell,x:9},options);expect(worker.sent).toHaveLength(2);expect(worker.sent[1]).toMatchObject({type:'cell',cell,options});abort.abort();expect((await first as Error).message).toMatch(/aborted/);expect(worker.sent).toHaveLength(2);
  worker.reply({id:1,cell:data});expect(worker.sent).toHaveLength(3);worker.reply({id:2,cell:{...data,key:'next'}});expect((await second).key).toBe('next');source.dispose();source.dispose();expect(worker.terminations).toBe(1);expect(vi.getTimerCount()).toBe(0);
});
it('hard bounds the request queue and rejects all outstanding work on timeout without stale reopening',async()=>{
  const source=createPlanetPopulationPreparationSource(planet,biomes),worker=FakeWorker.all[0],requests=Array.from({length:4},()=>source.request(cell,options).catch(error=>error as Error));await expect(source.request(cell,options)).rejects.toThrow(/four/);await vi.advanceTimersByTimeAsync(15000);for(const request of requests)expect((await request as Error).message).toMatch(/15 seconds/);expect(worker.terminations).toBe(1);worker.reply({id:1,cell:data});await expect(source.request(cell,options)).rejects.toThrow(/disposed/);source.dispose();expect(worker.terminations).toBe(1);expect(vi.getTimerCount()).toBe(0);
});
it('refuses pre-aborted or malformed asset preparation without constructing a worker',async()=>{
  const abort=new AbortController();abort.abort();await expect(preparePlanetPopulation(42,{signal:abort.signal})).rejects.toThrow(/aborted/);await expect(preparePlanetPopulation(1.5)).rejects.toThrow(/seed/);expect(FakeWorker.all).toHaveLength(0);
});
