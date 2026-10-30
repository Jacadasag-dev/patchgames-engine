import {describe,expect,it} from 'vitest';
import {compilePlanet,type PlanetTile} from '../src/shared/planet.ts';
import {compilePlanetBiomes,createPlanetBiomeRecipe,PLANET_BIOME_IDS} from '../src/shared/planetBiomes.ts';
import {bakePlanetSurfaceMaterials,planetSurfaceMaterialRecipes,preparePlanetSurfacePatch} from '../src/shared/planetSurface.ts';

const planet=compilePlanet({kind:'planet',version:1,seed:42,radiusMeters:6371000,seaLevelMeters:0,segments:32,surface:{maps:{kind:'generation-maps',version:1,seed:42,maps:{height:{type:'constant',value:500,unit:'metres'}}},height:'height'}}),biomes=compilePlanetBiomes(planet,createPlanetBiomeRecipe());
describe('renderer-neutral planet texture preparation',()=>{
  it('keeps expanded indexed geometry bounded and partitions every triangle exactly once by valid material',()=>{
    for(const tile of [{face:0,level:16,x:30000,y:30000},{face:4,level:16,x:32000,y:32000}]){const source=planet.patch(tile),prepared=preparePlanetSurfacePatch(biomes,source);expect(source.uvs).toBeUndefined();expect(prepared.positions.length).toBe(source.indices.length*3);expect(prepared.uvs!.length).toBe(source.indices.length*2);expect(prepared.positions.length/3).toBeLessThan(65536);expect(new Set(prepared.indices).size).toBe(source.indices.length);expect(prepared.groups!.reduce((sum,group)=>sum+group.count,0)).toBe(prepared.indices.length);
      let next=0;for(const group of prepared.groups!){expect(group.start).toBe(next);expect(group.count%3).toBe(0);expect(group.materialIndex).toBeGreaterThanOrEqual(0);expect(group.materialIndex).toBeLessThan(PLANET_BIOME_IDS.length);next+=group.count;}
      const bytes=prepared.positions.byteLength+prepared.normals.byteLength+prepared.colors.byteLength+prepared.uvs!.byteLength+prepared.indices.byteLength;expect(prepared.byteLength).toBe(bytes);expect(prepared.uvs!.every(Number.isFinite)).toBe(true);expect(prepared.normals.every(Number.isFinite)).toBe(true);expect(prepared.colors.every(n=>Number.isFinite(n)&&n>=0&&n<=1)).toBe(true);
    }
  });
  it('retains shared indexed source buffers and one tint-only draw for orbital/coarse patches',()=>{
    const factors={ocean:.5,beach:.46,grassland:.48,'temperate-forest':.44,taiga:.44,'tropical-forest':.44,desert:.46,tundra:.52,alpine:.5};
    for(const tile of [{face:0,level:0,x:0,y:0},{face:4,level:8,x:100,y:100}]){const source=planet.patch(tile),prepared=preparePlanetSurfacePatch(biomes,source);expect(prepared.positions).toBe(source.positions);expect(prepared.normals).toBe(source.normals);expect(prepared.indices).toBe(source.indices);expect(prepared.positions.length).toBe(source.positions.length);expect(prepared.uvs).toBeUndefined();expect(prepared.groups).toBeUndefined();expect(prepared.byteLength).toBe(source.byteLength);expect(prepared.colors.every(n=>n>=0&&n<=.52)).toBe(true);expect(prepared.colors).not.toEqual(source.colors);for(let i=0;i<source.positions.length/3;i++){const sample=biomes.sample([0,1,2].map(axis=>source.origin[axis]+source.positions[i*3+axis]) as [number,number,number]);for(let axis=0;axis<3;axis++)expect(prepared.colors[i*3+axis]).toBeCloseTo(sample.color[axis]*factors[sample.id],6);}}
  });
  it('preserves period-continuous metre UVs across adjacent close-surface camera-relative patches',()=>{
    const a:PlanetTile={face:0,level:16,x:32000,y:32000},b={...a,x:a.x+1},left=preparePlanetSurfacePatch(biomes,planet.patch(a)),right=preparePlanetSurfacePatch(biomes,planet.patch(b));
    const values=new Map<string,[number,number]>();for(let i=0;i<left.positions.length/3;i++){const p=[0,1,2].map(axis=>left.origin[axis]+left.positions[i*3+axis]);values.set(p.map(n=>n.toFixed(2)).join(','),[left.uvs![i*2],left.uvs![i*2+1]]);}
    let shared=0;const periodDifference=(x:number,y:number)=>Math.abs((x-y)/4-Math.round((x-y)/4));for(let i=0;i<right.positions.length/3;i++){const p=[0,1,2].map(axis=>right.origin[axis]+right.positions[i*3+axis]),other=values.get(p.map(n=>n.toFixed(2)).join(','));if(other){shared++;expect(periodDifference(other[0],right.uvs![i*2])).toBeLessThan(.0001);expect(periodDifference(other[1],right.uvs![i*2+1])).toBeLessThan(.0001);}}
    expect(shared).toBeGreaterThan(20);expect(Math.max(...left.uvs!.map(Math.abs))).toBeLessThan(300);
  });
  it('uses generated data-only recipes and produces one bounded reusable material per biome',async()=>{
    const recipes=planetSurfaceMaterialRecipes(42,64);expect(recipes).toHaveLength(PLANET_BIOME_IDS.length);expect(recipes.every(recipe=>recipe.tileMeters?.every(v=>v===4))).toBe(true);const bakes=await bakePlanetSurfaceMaterials(42,64);expect(bakes).toHaveLength(recipes.length);for(const bake of bakes){expect(bake.color.width).toBe(64);expect(bake.preparedMipmaps?.normal.length).toBeGreaterThan(1);expect(bake.diagnostics.bytes).toBeLessThan(200000);}
  });
});
