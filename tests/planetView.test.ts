import {afterEach,describe,expect,it,vi} from 'vitest';
import {Mesh,MeshStandardMaterial} from 'three';
import {compilePlanet,planetTileKey,type PlanetPatchData,type PlanetTile} from '../src/shared/planet.ts';
import {PlanetView,type PlanetPatchSource} from '../src/sandbox/planetView.ts';

const planet=compilePlanet({kind:'planet',version:1,seed:4,radiusMeters:1000,segments:4,maxLevel:5,
  surface:{maps:{kind:'generation-maps',version:1,seed:4,maps:{height:{type:'constant',value:0,unit:'metres'}}},height:'height'}});
const frame={position:[0,0,1001] as const,viewportHeight:600,fovDegrees:60};
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function service(){
  const pending=new Map<string,{tile:PlanetTile;resolve:(data:PlanetPatchData)=>void;reject:(reason:Error)=>void}>();
  let disposed=0;
  const source:PlanetPatchSource={request(tile){return new Promise((resolve,reject)=>pending.set(planetTileKey(tile),{tile,resolve,reject}));},dispose(){disposed++;}};
  const complete=(key:string)=>{const item=pending.get(key)!;pending.delete(key);item.resolve(planet.patch(item.tile));};
  return{source,pending,complete,get disposed(){return disposed;}};
}
const views:PlanetView[]=[];
afterEach(()=>{for(const view of views)view.dispose();views.length=0;vi.restoreAllMocks();});
function make(source:PlanetPatchSource,extra:ConstructorParameters<typeof PlanetView>[2]={}){
  const view=new PlanetView(planet,source,{maxSelectedPatches:9,maxResidentPatches:32,maxInFlight:2,maxUploadsPerFrame:1,...extra});views.push(view);return view;
}
function visibleArea(view:PlanetView){return view.root.children.filter(child=>child.visible).reduce((area,child)=>area+4**-Number(child.name.split('/')[1]),0);}
async function roots(view:PlanetView,worker:ReturnType<typeof service>){
  for(let i=0;i<20&&view.inspection().rootsReady<6;i++){
    view.update(frame);await settle();
    for(const [key,item] of worker.pending)if(item.tile.level===0)worker.complete(key);
    await settle();
  }
  expect(view.inspection().rootsReady).toBe(6);
}

describe('planet presentation streaming',()=>{
  it('bounds parallel requests and per-update installation while preparing the coarse globe',async()=>{
    const worker=service(),view=make(worker.source,{maxSelectedPatches:6});
    view.update(frame);await settle();expect(worker.pending.size).toBe(2);
    for(const key of [...worker.pending.keys()])worker.complete(key);await settle();
    view.update(frame);expect(view.inspection().installedThisFrame).toBe(1);expect(view.inspection().rootsReady).toBe(1);
    await roots(view,worker);expect(view.inspection().coverageReady).toBe(true);expect(visibleArea(view)).toBe(6);
  });
  it('keeps the parent until all four children are installed, then publishes the quartet together',async()=>{
    const worker=service(),view=make(worker.source);await roots(view,worker);
    let children=0;
    for(let i=0;i<12&&children<3;i++){
      view.update(frame);await settle();
      const next=[...worker.pending.entries()].find(([,item])=>item.tile.level===1);
      if(next){worker.complete(next[0]);children++;await settle();view.update(frame);}
    }
    expect(children).toBe(3);expect(view.inspection().visiblePatches).toBe(6);expect(visibleArea(view)).toBe(6);
    view.update(frame);await settle();const last=[...worker.pending.entries()].find(([,item])=>item.tile.level===1)!;
    worker.complete(last[0]);await settle();view.update(frame);
    expect(view.inspection().visiblePatches).toBe(9);expect(view.inspection().selectedPatches).toBe(9);expect(visibleArea(view)).toBe(6);
  });
  it('retains valid parent coverage after a failed or stale child result',async()=>{
    const worker=service(),view=make(worker.source);await roots(view,worker);view.update(frame);await settle();
    const [key,item]=[...worker.pending.entries()].find(([,item])=>item.tile.level===1)!;
    worker.pending.delete(key);item.resolve({...planet.patch(item.tile),revision:'stale'});await settle();view.update(frame);
    expect(view.inspection().failures).toBe(1);expect(view.inspection().lastError).toMatch(/stale/);
    expect(view.inspection().visiblePatches).toBe(6);expect(visibleArea(view)).toBe(6);
  });
  it('queries the actual coarse triangle and rebases without installing a second batch',async()=>{
    const worker=service(),view=make(worker.source,{maxSelectedPatches:6});await roots(view,worker);
    const direction=[.17,.21,1] as const,source=planet.sample(direction),display=view.displayedSurface(direction)!;
    expect(display.level).toBe(0);expect(display.heightMeters).toBeLessThanOrEqual(source.heightMeters);
    expect(display.heightMeters).toBeGreaterThan(-100);
    const installed=view.inspection().installedThisFrame,mesh=view.root.children.find(child=>child.name==='PlanetPatch:4/0/0/0')!;
    const old=mesh.position.x;view.rebase([10,0,1001]);expect(mesh.position.x).toBeCloseTo(old-10);
    expect(view.inspection().installedThisFrame).toBe(installed);expect(view.displayedSurface(direction)).toEqual(display);
  });
  it('disposes owned resources once and rejects late completions after close',async()=>{
    const worker=service(),material=new MeshStandardMaterial(),view=make(worker.source,{material});await roots(view,worker);
    const materialDispose=vi.spyOn(material,'dispose'),geometries=view.root.children.map(child=>vi.spyOn((child as Mesh).geometry,'dispose'));
    view.update(frame);await settle();const late=[...worker.pending.values()][0];
    view.dispose();view.dispose();late?.resolve(planet.patch(late.tile));await settle();
    expect(worker.disposed).toBe(1);expect(view.root.children).toHaveLength(0);expect(view.inspection().residentBytes).toBe(0);
    for(const dispose of geometries)expect(dispose).toHaveBeenCalledTimes(1);expect(materialDispose).not.toHaveBeenCalled();material.dispose();
  });
  it('bounds residency during repeated long-distance camera changes',async()=>{
    let now=1000;vi.spyOn(performance,'now').mockImplementation(()=>now);
    const source:PlanetPatchSource={request:async tile=>planet.patch(tile),dispose(){}};
    const view=make(source,{maxSelectedPatches:12,maxResidentPatches:32,maxUploadsPerFrame:2});
    for(let i=0;i<180;i++){
      now+=110;const angle=i*.2;view.update({...frame,position:[Math.sin(angle)*1001,0,Math.cos(angle)*1001]});await settle();
      const facts=view.inspection();expect(facts.residentPatches).toBeLessThanOrEqual(32);expect(facts.inFlight).toBeLessThanOrEqual(2);expect(facts.installedThisFrame).toBeLessThanOrEqual(2);
      if(facts.coverageReady)expect(visibleArea(view)).toBe(6);
    }
    expect(view.inspection().coverageReady).toBe(true);expect(view.inspection().evicted).toBeGreaterThan(0);
  });
  it('rejects budgets that cannot retain required fallback ancestors',()=>{
    const worker=service();expect(()=>make(worker.source,{maxSelectedPatches:192,maxResidentPatches:32})).toThrow(/fallback/);
    const large=compilePlanet({...planet.recipe,segments:32});
    expect(()=>new PlanetView(large,worker.source,{maxResidentBytes:256*1024})).toThrow(/six coarse roots/);
  });
});
