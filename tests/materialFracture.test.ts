import {it,expect} from 'vitest';
import {parseMaterialFracture,compileMaterialFracture,createMaterialFractureSampler} from '../src/shared/materialFracture.ts';
import {MATERIAL_FRACTURE_PRESETS} from '../src/shared/materialFracturePresets.ts';
import {materialGeneratorSchema,generateMaterial,materialFractureAt} from '../src/shared/materialGenerator.ts';
import {parseMaterialGeneratorData} from '../src/shared/materialGeneratorData.ts';
import {createGeneratedMaterialFromPixels} from '../src/sandbox/materialGenerator.ts';
import {sampleObjectSurface,objectSurfaceSchema,OBJECT_SURFACE_EXAMPLES} from '../src/shared/objectSurface.ts';
it.each(['impact','network'] as const)('%s generates deterministic connected, tapered branches within a hard segment budget',style=>{
 const r=parseMaterialFracture({style,density:1,branching:1}),lines=compileMaterialFracture(r,[2,2],42);expect(lines.length).toBeGreaterThan(50);expect(lines.length).toBeLessThanOrEqual(512);expect(lines).toEqual(compileMaterialFracture(r,[2,2],42));expect(lines).not.toEqual(compileMaterialFracture(r,[2,2],43));
 let connected=0;for(const line of lines){if(line.parent>=0){expect(line.a).toEqual(lines[line.parent].b);connected++;}expect(line.widthScale).toBeGreaterThan(0);expect([...line.a,...line.b]).toSatisfy(a=>a.every(Number.isFinite));}expect(connected).toBeGreaterThan(30);
 const sampler=createMaterialFractureSampler(r,[2,2],42);const line=lines.find(l=>l.a.every(n=>n>.1&&n<1.9))!;expect(sampler.sample(line.a[0]/2,line.a[1]/2)).toBeGreaterThan(0);expect(sampler.sample(.1,.1)).toBeGreaterThanOrEqual(0);
 expect(compileMaterialFracture({...r,density:0},[2,2],42)).toEqual([]);expect(compileMaterialFracture({...r,strength:0},[2,2],42)).toEqual([]);
});
it('impact origins, width, branching and reach have independent geometric effects',()=>{
 const r=parseMaterialFracture({style:'impact',density:.5,branching:0}),lines=compileMaterialFracture(r,[2,2],42),branches=compileMaterialFracture({...r,branching:1},[2,2],42);
 expect(branches.length).toBeGreaterThan(lines.length);expect(compileMaterialFracture({...r,center:[.2,.7]},[2,2],42)[0].a).toEqual([.4,1.4]);
 const [a,b]=[createMaterialFractureSampler(r,[2,2],42),createMaterialFractureSampler({...r,widthMeters:.03},[2,2],42)];expect(a.segments).toEqual(b.segments);
 let narrow=0,wide=0;for(let y=0;y<64;y++)for(let x=0;x<64;x++){narrow+=a.sample((x+.5)/64,(y+.5)/64,.03);wide+=b.sample((x+.5)/64,(y+.5)/64,.03);}expect(wide).toBeGreaterThan(narrow*2);
});
it.each(MATERIAL_FRACTURE_PRESETS)('$id bakes coherent damage including glass with zero base relief',async({recipe})=>{
 expect(parseMaterialGeneratorData(recipe)).toEqual(materialGeneratorSchema.parse(recipe));const clean={...recipe,fracture:{...recipe.fracture!,strength:0}};
 const a=await generateMaterial(recipe,{resolution:64}),b=await generateMaterial(clean,{resolution:64});expect(a.color.data).not.toEqual(b.color.data);expect(a.normal.data).not.toEqual(b.normal.data);expect(a.roughness.data).not.toEqual(b.roughness.data);expect(a.recipe.optics).toEqual(b.recipe.optics);
 const h=createGeneratedMaterialFromPixels(a);expect(h.material.transmission).toBe(recipe.optics?.transmission??0);expect(h.material.alphaTest).toBe(0);h.dispose();
});
it('uses physical fracture depth in object-surface probes and observes live recipe edits',()=>{
 const r=objectSurfaceSchema.parse({...OBJECT_SURFACE_EXAMPLES.grass,base:MATERIAL_FRACTURE_PRESETS[3].recipe,sizeMeters:[2.8,2.8,.1],layers:[]}),u=.001,v=.5;const before=materialFractureAt(r.base,u,v);r.base.fracture!.widthMeters=.05;const after=materialFractureAt(r.base,u,v);expect(after!.weight).toBeGreaterThanOrEqual(before!.weight);
 const lines=compileMaterialFracture(r.base.fracture!,r.base.tileMeters,r.base.seed),line=lines.find(l=>l.a.every(n=>n>=0&&n<=1))!,x=line.a[0]/r.base.tileMeters[0],y=line.a[1]/r.base.tileMeters[1],damaged=sampleObjectSurface(r,'front',x,y);r.base.fracture!.strength=0;const clean=sampleObjectSurface(r,'front',x,y);expect(damaged.height).toBeLessThan(clean.height);
});
it('rejects malformed fracture data in both material parsers',()=>{
 for(const fracture of [{style:'foo'},{center:[-1,.5]},{widthMeters:0},{density:NaN},{branching:2},{depthMeters:-1},{color:'red'},{unknown:true}])for(const parse of [materialGeneratorSchema.parse.bind(materialGeneratorSchema),parseMaterialGeneratorData])expect(()=>parse({pattern:{family:'plaster'},fracture})).toThrow();
});
