import {describe,expect,it} from 'vitest';
import {compilePlanet,type PlanetTile} from '../src/shared/planet.ts';
import {planetPopulationCells,planetPopulationCellDirection,planetPopulationCellKey,planetPopulationFrame,planPlanetPopulationCell,resolvePlanetPopulationOptions,type PlanetPopulationBiomeSample,type PlanetPopulationWorld} from '../src/shared/planetPopulation.ts';

const planet=compilePlanet({kind:'planet',version:1,seed:42,radiusMeters:1000,seaLevelMeters:0,surface:{maps:{kind:'generation-maps',version:1,seed:42,maps:{height:{type:'constant',value:20,unit:'metres'}}},height:'height'}});
const base:PlanetPopulationBiomeSample={id:'forest',heightMeters:20,slope:0,temperature:.6,moisture:.6,forestFamily:'temperate',treeDensity:1,buildingSuitability:1};
const world=(patch:Partial<PlanetPopulationBiomeSample>={}):PlanetPopulationWorld=>({planet,biomes:{sample:()=>({...base,...patch})}});
const options=resolvePlanetPopulationOptions();
const cells=planetPopulationCells(planet.radius,[0,0,1020],options);
const dot=(a:readonly number[],b:readonly number[])=>a.reduce((n,v,i)=>n+v*b[i],0);
describe('planet population identities and placement',()=>{
  it('has fixed cell identities through render LOD, origin, stream ordering and seed changes',()=>{
    const a=cells.map(cell=>planPlanetPopulationCell(world(),cell,options)),b=[...cells].reverse().map(cell=>planPlanetPopulationCell(world(),cell,options));
    expect(a).toEqual(b.reverse());expect(new Set(cells.map(planetPopulationCellKey)).size).toBe(cells.length);
    for(const cell of a)for(const item of cell.instances){expect(item.id.startsWith(cell.key)).toBe(true);expect(Math.hypot(...item.up)).toBeCloseTo(1,12);}
  });
  it('crosses cube seams without duplicate or invalid cells and hard bounds every selection',()=>{
    for(const position of [[710,0,710],[590,590,590],[-710,-710,0],[0,1020,0]] as const){const selected=planetPopulationCells(1000,position,options);expect(selected.length).toBeLessThanOrEqual(options.maxCells);expect(new Set(selected.map(planetPopulationCellKey)).size).toBe(selected.length);for(const cell of selected)expect(planetPopulationCellDirection(cell).every(Number.isFinite)).toBe(true);}
    expect(planetPopulationCells(1000,[710,0,710],options).some(cell=>cell.face===0)).toBe(true);expect(planetPopulationCells(1000,[710,0,710],options).some(cell=>cell.face===4)).toBe(true);
  });
  it('rejects oceans, cliffs and snow for settlements and water for all trees',()=>{
    for(const patch of [{heightMeters:-1},{slope:89},{forestFamily:'none' as const,temperature:.1}])expect(cells.flatMap(cell=>planPlanetPopulationCell(world(patch),cell,options).instances)).toHaveLength(0);
    const cold=cells.flatMap(cell=>planPlanetPopulationCell(world({temperature:.1,forestFamily:'conifer'}),cell,options).instances);expect(cold.every(item=>item.kind==='tree')).toBe(true);
  });
  it('selects real biome species and preserves tree density independently from stable candidate positions',()=>{
    for(const [family,allowed]of [['temperate',['oak','maple','birch']],['conifer',['evergreen','pine']],['tropical',['jungle','palm']]] as const){const all=cells.flatMap(cell=>planPlanetPopulationCell(world({forestFamily:family}),cell,options).instances).filter(item=>item.kind==='tree');expect(all.length).toBeGreaterThan(0);expect(all.every(item=>allowed.includes(item.variant as never))).toBe(true);
      const sparse=cells.flatMap(cell=>planPlanetPopulationCell(world({forestFamily:family,treeDensity:.15}),cell,options).instances).filter(item=>item.kind==='tree');expect(sparse.length).toBeLessThan(all.length);for(const item of sparse)expect(all.find(full=>full.id===item.id)).toEqual(item);}
  });
  it('grounds compiled building footprints and rejects uneven support across all nine probes',()=>{
    const buildings=cells.flatMap(cell=>planPlanetPopulationCell(world({treeDensity:0}),cell,options).instances);expect(buildings.length).toBeGreaterThan(0);expect(buildings.every(item=>item.kind==='building'&&item.scale===1&&Math.abs(Math.hypot(...item.position)-1019.98)<.03)).toBe(true);
    const rough:PlanetPopulationWorld={planet,biomes:{sample:d=>({...base,treeDensity:0,heightMeters:20+d[0]*50})}};
    expect(cells.flatMap(cell=>planPlanetPopulationCell(rough,cell,options).instances)).toHaveLength(0);
  });
  it('produces right-handed radial tangent bases at poles and cube seams',()=>{
    for(const up of [[1,0,0],[0,1,0],[0,-1,0],[.5,.5,.5],[-.5,.5,-.5]] as const){const basis=planetPopulationFrame(up);expect(dot(basis.x,basis.y)).toBeCloseTo(0,12);expect(dot(basis.z,basis.y)).toBeCloseTo(0,12);expect(Math.hypot(...basis.x)).toBeCloseTo(1,12);const cross=[basis.x[1]*basis.y[2]-basis.x[2]*basis.y[1],basis.x[2]*basis.y[0]-basis.x[0]*basis.y[2],basis.x[0]*basis.y[1]-basis.x[1]*basis.y[0]];expect(cross).toEqual(basis.z);}
  });
  it('rejects malformed options and invalid cell identities before sampling',()=>{
    expect(()=>resolvePlanetPopulationOptions({maxTrees:50000})).toThrow();expect(()=>resolvePlanetPopulationOptions({radiusMeters:NaN})).toThrow();expect(()=>planPlanetPopulationCell(world(),{face:6,level:5,x:0,y:0} as PlanetTile,options)).toThrow();expect(()=>planetPopulationCells(1000,[0,0,0],options)).toThrow();
  });
});
