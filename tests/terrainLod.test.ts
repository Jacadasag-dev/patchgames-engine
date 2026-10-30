import {it,expect} from 'vitest';
import {compileTerrain,compileTerrainChunk,type TerrainRecipe} from '../src/sandbox/terrain.ts';
import {createTerrainLodGeometry} from '../src/sandbox/terrainLod.ts';

const recipe:TerrainRecipe={version:1,seed:13,bounds:{width:128,depth:128,cells:32},base:{noise:{amplitude:5,wavelength:27}},assets:[],regions:[]};
const perimeter=(level:ReturnType<typeof createTerrainLodGeometry>['levels'][number],x?:number,z?:number)=>{
 const p=level.geometry.getAttribute('position'),n=level.geometry.getAttribute('normal'),points=new Map<string,number[]>();
 for(let i=0;i<p.count;i++)if((x===undefined||Math.abs(p.getX(i)-x)<1e-5)&&(z===undefined||Math.abs(p.getZ(i)-z)<1e-5))points.set(p.getX(i)+','+p.getZ(i),[p.getX(i),p.getY(i),p.getZ(i),n.getX(i),n.getY(i),n.getZ(i)]);
 return [...points.values()].sort((a,b)=>a[0]-b[0]||a[2]-b[2]);
};
it('prepares bounded decreasing geometry tiers without changing source terrain',()=>{
 const manifest=compileTerrain(recipe),before=JSON.stringify(manifest),lod=createTerrainLodGeometry(manifest);
 expect(lod.levels).toHaveLength(5);expect(lod.sourceTriangles).toBe(2048);
 expect(lod.levels[0].triangles).toBe(lod.sourceTriangles);
 for(let i=1;i<lod.levels.length;i++){expect(lod.levels[i].triangles).toBeLessThan(lod.levels[i-1].triangles);expect(lod.levels[i].errorMeters).toBeGreaterThanOrEqual(0);}
 expect(lod.levels.at(-1)!.triangles).toBeLessThan(lod.sourceTriangles*.1);
 expect(JSON.stringify(manifest)).toBe(before);lod.dispose();
});
it('retains every source boundary position and normal at all detail levels',()=>{
 const manifest=compileTerrain(recipe),lod=createTerrainLodGeometry(manifest),base=lod.levels[0];
 for(const level of lod.levels){for(const x of [-64,64])expect(perimeter(level,x)).toEqual(perimeter(base,x));for(const z of [-64,64])expect(perimeter(level,undefined,z)).toEqual(perimeter(base,undefined,z));
  const p=level.geometry.getAttribute('position'),delta=level.geometry.getAttribute('terrainLodDelta');
  for(let i=0;i<p.count;i++)if(Math.abs(p.getX(i))===64||Math.abs(p.getZ(i))===64)expect(delta.getX(i)).toBe(0);
 }lod.dispose();
});
it('neighboring mixed-detail streamed chunks meet at the same exact edge heights',()=>{
 const large={...recipe,bounds:{width:512,depth:512},streaming:{chunkSize:128 as const,cells:32}},left=createTerrainLodGeometry(compileTerrainChunk(large,{x:-1,z:0,size:128,cells:32})),right=createTerrainLodGeometry(compileTerrainChunk(large,{x:0,z:0,size:128,cells:32}));
 for(const l of left.levels)for(const r of right.levels)expect(perimeter(l,0).map(p=>p.slice(0,3))).toEqual(perimeter(r,0).map(p=>p.slice(0,3)));
 left.dispose();right.dispose();
});
it('supports irregular cell counts with positive, finite top-facing geometry',()=>{
 const manifest=compileTerrain({...recipe,bounds:{width:48,depth:48,cells:15}}),lod=createTerrainLodGeometry(manifest);
 for(const level of lod.levels){const p=level.geometry.getAttribute('position'),index=level.geometry.index!;
  for(let i=0;i<index.count;i+=3){const a=index.getX(i),b=index.getX(i+1),c=index.getX(i+2),up=(p.getZ(b)-p.getZ(a))*(p.getX(c)-p.getX(a))-(p.getX(b)-p.getX(a))*(p.getZ(c)-p.getZ(a));expect(up).toBeGreaterThan(0);}
  expect(Array.from(level.geometry.getAttribute('terrainLodDelta').array).every(Number.isFinite)).toBe(true);
 }lod.dispose();
});
it('disposes every tier exactly once and rejects invalid budgets or heightfields',()=>{
 const manifest=compileTerrain(recipe),lod=createTerrainLodGeometry(manifest);let count=0;for(const l of lod.levels)l.geometry.addEventListener('dispose',()=>count++);lod.dispose();lod.dispose();expect(count).toBe(lod.levels.length);
 for(const levels of [0,7,1.5])expect(()=>createTerrainLodGeometry(manifest,levels)).toThrow();expect(()=>createTerrainLodGeometry({...manifest,heights:[0]})).toThrow();
});
it('protects vertex-color features even on an otherwise perfectly flat heightfield',()=>{
 const manifest=compileTerrain({...recipe,base:{height:0}});manifest.colors.fill(0x334455);manifest.colors[7*(manifest.rows+1)+9]=0xee2211;
 const lod=createTerrainLodGeometry(manifest);expect(lod.levels[0].errorMeters).toBe(0);
 for(const level of lod.levels.slice(1))expect(level.errorMeters).toBeGreaterThan(0);
 lod.dispose();
});
