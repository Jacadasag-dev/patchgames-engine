import {afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {InstancedMesh,Matrix4,MeshStandardMaterial,Vector3} from 'three';
import {compilePlanet,type PlanetTile} from '../src/shared/planet.ts';
import {planetPopulationCellKey,planPlanetPopulationCell,type PlanetPopulationCell,type PlanetPopulationWorld,type ResolvedPlanetPopulationOptions} from '../src/shared/planetPopulation.ts';
import {bakePlanetPopulation,createPreparedPlanetPopulation,PlanetPopulationView,type PlanetPopulationBake,type PlanetPopulationSource} from '../src/sandbox/planetPopulationView.ts';

const planet=compilePlanet({kind:'planet',version:1,seed:42,radiusMeters:1000,seaLevelMeters:0,surface:{maps:{kind:'generation-maps',version:1,seed:42,maps:{height:{type:'constant',value:20,unit:'metres'}}},height:'height'}});
const world:PlanetPopulationWorld={planet,biomes:{sample:()=>({id:'forest',heightMeters:20,slope:0,temperature:.6,moisture:.6,forestFamily:'temperate',treeDensity:1,buildingSuitability:1})}};
let bake:PlanetPopulationBake;
beforeAll(async()=>{bake=await bakePlanetPopulation(42,{resolution:32});});
afterEach(()=>vi.restoreAllMocks());
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function source(){const pending:{cell:PlanetTile;options:ResolvedPlanetPopulationOptions;resolve:(data:PlanetPopulationCell)=>void;signal?:AbortSignal}[]=[];const dispose=vi.fn();const value:PlanetPopulationSource={request(cell,options,signal){return new Promise(resolve=>pending.push({cell,options,resolve,signal}));},dispose};return{value,pending,dispose,complete(){for(const item of pending.splice(0))item.resolve(planPlanetPopulationCell(world,item.cell,item.options));}};}
describe('prepared radial planet population',()=>{
  it('prepares seven real foliage families and compiler-owned enclosed buildings, all textured with native materials',()=>{
    const library=createPreparedPlanetPopulation(bake);expect(library.variants.size).toBe(9);expect(bake.trees.every(tree=>tree.bake.model.leaves.length>100&&tree.bake.model.leaves.length<=1800)).toBe(true);
    for(const entry of bake.buildings){expect(entry.manifest.diagnostics.valid).toBe(true);expect(entry.manifest.parts.some(part=>part.kind==='roof')).toBe(true);expect(entry.manifest.parts.some(part=>part.kind==='door')).toBe(true);}
    for(const variant of library.variants.values()){let textured=0;for(const part of variant.parts){expect(part.geometry.attributes.uv).toBeDefined();for(const material of Array.isArray(part.material)?part.material:[part.material]){expect(material).toBeInstanceOf(MeshStandardMaterial);if((material as MeshStandardMaterial).map)textured++;else expect(variant.kind).toBe('building');}if(variant.kind==='tree')expect(part.levels.length).toBe(4);}expect(textured).toBeGreaterThan(0);}
    library.dispose();
  });
  it('bounds cell requests, adoption and visible populations while using only prepared GPU resources',async()=>{
    const library=createPreparedPlanetPopulation(bake),worker=source(),view=new PlanetPopulationView(world,library,worker.value,{maxCells:8,maxTrees:20,maxBuildings:2,maxUploadsPerFrame:1,maxAnimatedTrees:0});
    for(let frame=0;frame<10;frame++){view.update([0,0,1025],[0,0,1025],frame/60);expect(worker.pending.length).toBeLessThanOrEqual(2);worker.complete();await settle();expect(view.inspection().trees).toBeLessThanOrEqual(20);expect(view.inspection().buildings).toBeLessThanOrEqual(2);expect(view.inspection().residentCells).toBeLessThanOrEqual(8);expect(view.inspection().installedThisFrame).toBeLessThanOrEqual(1);}
    expect(view.inspection().trees).toBe(20);expect(view.inspection().drawCalls).toBeGreaterThan(0);expect(view.inspection().drawCalls).toBeLessThanOrEqual(100);view.dispose();library.dispose();
  });
  it('aligns +Y radially and subtracts the double precision render origin before GPU matrices',async()=>{
    const library=createPreparedPlanetPopulation(bake),worker=source(),view=new PlanetPopulationView(world,library,worker.value,{maxCells:1,maxTrees:1,maxBuildings:0,maxAnimatedTrees:0});
    const origin=[1000,20,0] as const;view.update([1025,0,0],origin,0);const cell=worker.pending[0];const expected=planPlanetPopulationCell(world,cell.cell,cell.options).instances.filter(item=>item.kind==='tree').sort((a,b)=>Math.hypot(a.position[0]-1025,a.position[1],a.position[2])-Math.hypot(b.position[0]-1025,b.position[1],b.position[2]))[0];worker.complete();await settle();view.update([1025,0,0],origin,.1);
    const mesh=view.root.children.find(child=>child instanceof InstancedMesh&&child.count&&child.name.startsWith('planet:'+expected.variant+':')) as InstancedMesh,matrix=new Matrix4();expect(mesh).toBeTruthy();mesh.getMatrixAt(0,matrix);const variant=library.variants.get(expected.variant)!,part=variant.parts.find(part=>part.geometry===mesh.geometry||part.levels.includes(mesh.geometry))!;matrix.multiply(part.local.clone().invert());const up=new Vector3(0,1,0).transformDirection(matrix);expect(up.dot(new Vector3(...expected.up))).toBeCloseTo(1,6);const position=new Vector3().setFromMatrixPosition(matrix);expect(position.x).toBeCloseTo(expected.position[0]-origin[0],4);expect(position.z).toBeCloseTo(expected.position[2]-origin[2],4);view.dispose();library.dispose();
  });
  it('rejects stale worker cells during rapid travel and disables local populations from orbit',async()=>{
    const library=createPreparedPlanetPopulation(bake),worker=source(),view=new PlanetPopulationView(world,library,worker.value,{maxCells:3,maxTrees:8,maxBuildings:1});
    view.update([0,0,1025],[0,0,1025],0);const old=worker.pending.map(item=>planetPopulationCellKey(item.cell));view.update([0,0,-1025],[0,0,-1025],1);expect(worker.pending.every(item=>item.signal!.aborted)).toBe(true);worker.complete();await settle();expect(view.inspection().staleResults).toBe(2);view.update([0,0,-1025],[0,0,-1025],2);expect(worker.pending.every(item=>!old.includes(planetPopulationCellKey(item.cell)))).toBe(true);
    view.update([0,0,1_000_000],[0,0,1_000_000],3);expect(view.root.visible).toBe(false);expect(view.inspection().residentCells).toBe(0);expect(view.inspection().trees).toBe(0);expect(view.inspection().buildings).toBe(0);worker.complete();await settle();view.dispose();library.dispose();
  });
  it('keeps residency, immutable prototypes and instance buffers bounded through repeated planet-wide travel',async()=>{
    const library=createPreparedPlanetPopulation(bake),worker=source(),view=new PlanetPopulationView(world,library,worker.value,{maxCells:6,maxTrees:32,maxBuildings:2}),meshes=[...view.root.children] as InstancedMesh[],geometry=meshes.map(mesh=>mesh.geometry),capacity=meshes.map(mesh=>mesh.instanceMatrix.count);
    for(let frame=0;frame<48;frame++){const angle=frame*.63,latitude=Math.sin(frame*.37)*1.3,p=[Math.cos(latitude)*Math.cos(angle)*1025,Math.sin(latitude)*1025,Math.cos(latitude)*Math.sin(angle)*1025] as const;view.update(p,p,frame);worker.complete();await settle();view.update(p,p,frame+.01);expect(view.inspection().residentCells).toBeLessThanOrEqual(6);expect(view.inspection().inFlight).toBeLessThanOrEqual(2);expect(view.inspection().trees).toBeLessThanOrEqual(32);expect(view.inspection().buildings).toBeLessThanOrEqual(2);expect(worker.pending.length).toBeLessThanOrEqual(2);}
    expect(view.root.children).toEqual(meshes);expect(meshes.map(mesh=>mesh.geometry)).toEqual(geometry);expect(meshes.map(mesh=>mesh.instanceMatrix.count)).toEqual(capacity);view.dispose();library.dispose();worker.complete();await settle();
  });
  it('waits for outstanding geometry loans and disposes each shared resource and source exactly once',async()=>{
    const library=createPreparedPlanetPopulation(bake),geometry=library.variants.get('oak')!.parts[0].geometry,release=vi.spyOn(geometry,'dispose'),worker=source(),view=new PlanetPopulationView(world,library,worker.value);
    library.dispose();library.dispose();expect(release).not.toHaveBeenCalled();expect(()=>library.borrow()).toThrow(/retired/);view.update([0,0,1025],[0,0,1025],0);view.dispose();view.dispose();expect(worker.dispose).toHaveBeenCalledTimes(1);expect(release).toHaveBeenCalledTimes(1);worker.complete();await settle();expect(view.root.children).toHaveLength(0);expect(release).toHaveBeenCalledTimes(1);
  });
  it('does not replace accepted cells when one later request fails or returns another cell identity',async()=>{
    const library=createPreparedPlanetPopulation(bake),worker=source(),view=new PlanetPopulationView(world,library,worker.value,{maxCells:4,maxTrees:8,maxBuildings:1});view.update([0,0,1025],[0,0,1025],0);worker.complete();await settle();view.update([0,0,1025],[0,0,1025],.1);expect(view.inspection().trees).toBeGreaterThan(0);const broken=worker.pending.splice(0);for(const item of broken)item.resolve({key:'wrong',cell:item.cell,instances:[]});await settle();view.update([0,0,1025],[0,0,1025],.2);expect(view.inspection().failed).toBe(2);expect(view.inspection().trees).toBeGreaterThan(0);view.dispose();library.dispose();
  });
});
