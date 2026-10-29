import {expect,it} from 'vitest';
import {defaultGenerationLabRecipe,generationLabTerrain,parseGenerationLabRecipe} from '../examples/generation-lab-data.ts';
import {compileTerrain} from '../src/sandbox/terrain.ts';
import {compileFoliageGeneration} from '../src/shared/generationFoliage.ts';
import {compileGenerationMaps} from '../src/shared/generationMaps.ts';
import {resolveObjectSurfaceDocument,inspectObjectSurfaceGeneration} from '../src/shared/objectSurface.ts';

it('the shared lab recipe composes all three real adapters without independent random recipes',()=>{
 const source=defaultGenerationLabRecipe(),r=parseGenerationLabRecipe(JSON.parse(JSON.stringify(source)));
 const terrain=compileTerrain(generationLabTerrain(r));
 expect(terrain.diagnostics.valid).toBe(true);expect(terrain.instances).toHaveLength(4);
 const trees=compileFoliageGeneration({recipe:r.foliage.recipe,graph:r.graph,bindings:r.foliage.bindings,instances:terrain.instances.map(i=>({id:i.id,world:[i.position.x,i.position.y,i.position.z] as const}))});
 expect(new Set(trees.variants.map(t=>t.geometryKey)).size).toBe(4);
 expect(new Set(trees.variants.map(t=>t.materialKey)).size).toBe(4);
 const surface=resolveObjectSurfaceDocument({...r.wall,generation:{graph:r.graph,bindings:r.wallBindings}});
 const left=inspectObjectSurfaceGeneration(surface,'front',.1,.5)!,right=inspectObjectSurfaceGeneration(surface,'front',.9,.5)!;
 expect(left.values['base.weathering']).toBeLessThan(right.values['base.weathering']);
 expect(compileGenerationMaps(r.graph).revision).toBe(compileGenerationMaps(source.graph).revision);
});
