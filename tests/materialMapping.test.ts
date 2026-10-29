import {it,expect} from 'vitest';
import {BoxGeometry,BufferGeometry,Float32BufferAttribute} from 'three';
import {mapBoxMaterialMeters,inspectTextureDensity,createMaterialMappingDebug} from '../src/sandbox/materialMapping.ts';
import {createGeneratedMaterialBox} from '../src/sandbox/materialGenerator.ts';
import {generateObjectSurface,OBJECT_SURFACE_EXAMPLES,BOX_SURFACES,boxSurfaceFrame} from '../src/shared/objectSurface.ts';

it('keeps a segmented, thin box at equal physical density on all six faces and is idempotent',()=>{
  const geometry=new BoxGeometry(4,2.5,.08,3,2,1);
  const wrong=inspectTextureDensity(geometry,[256,256]);expect(wrong.anisotropy).toBeGreaterThan(20);
  mapBoxMaterialMeters(geometry);const first=Array.from(geometry.getAttribute('uv').array);
  const density=inspectTextureDensity(geometry,[256,256]);
  expect(density.minimum).toBeCloseTo(256,2);expect(density.maximum).toBeCloseTo(256,2);expect(density.anisotropy).toBeCloseTo(1,5);
  mapBoxMaterialMeters(geometry);expect(Array.from(geometry.getAttribute('uv').array)).toEqual(first);geometry.dispose();
});
it('detects skew, degenerate UVs and unequal physical tile axes',()=>{
  const g=new BufferGeometry();g.setAttribute('position',new Float32BufferAttribute([0,0,0,1,0,0,0,1,0],3));
  g.setAttribute('uv',new Float32BufferAttribute([0,0,1,0,1,1],2));expect(inspectTextureDensity(g,[256,256]).anisotropy).toBeGreaterThan(2);
  g.setAttribute('uv',new Float32BufferAttribute([0,0,0,0,0,0],2));expect(inspectTextureDensity(g,[256,256]).minimum).toBe(0);
  expect(inspectTextureDensity(g,[256,256]).anisotropy).toBe(Infinity);g.dispose();
  const box=new BoxGeometry(1,1,1);mapBoxMaterialMeters(box);const d=inspectTextureDensity(box,[256,256],[1,2]);expect(d.minimum).toBe(256);expect(d.maximum).toBe(512);box.dispose();
});
it('offers a loading-time box default that maps every PBR channel and owns its resources',async()=>{
  const box=await createGeneratedMaterialBox({pattern:{family:'masonry'},tileMeters:[2,1],output:{resolution:32}},[4,2,.1]);
  for(const map of Object.values(box.maps))expect(map.repeat.toArray()).toEqual([.5,1]);
  expect(inspectTextureDensity(box.mesh.geometry,[32,32],[.5,1]).minimum).toBeCloseTo(16);
  let releases=0;box.mesh.geometry.addEventListener('dispose',()=>releases++);box.dispose();box.dispose();expect(releases).toBe(1);
  await expect(createGeneratedMaterialBox({pattern:{family:'rock'}},[NaN,1,1])).rejects.toThrow();
});
it('allocates rectangular face maps at consistent density while preserving bounded effects',async()=>{
  const baked=await generateObjectSurface(OBJECT_SURFACE_EXAMPLES.slash,{resolution:128});let bytes=0;
  for(const face of BOX_SURFACES){const f=baked.faces[face],span=boxSurfaceFrame(baked.recipe.sizeMeters,face).span;
    expect(Math.abs(f.color.width/span[0]-32)).toBeLessThan(2);expect(Math.abs(f.color.height/span[1]-32)).toBeLessThan(2);
    for(const map of [f.color,f.normal,f.height,f.roughness,f.metalness,f.ao]){expect(map.data.length).toBe(map.width*map.height*4);bytes+=map.data.byteLength;}
  }
  expect(baked.faces.front.color.width).toBe(128);expect(baked.faces.front.color.height).toBe(80);expect(baked.diagnostics.bytes).toBe(bytes);
  expect(baked.faces.front.color.data).not.toEqual(baked.faces.back.color.data);
});
it('validates debug inputs and preserves mapping settings without modifying source textures',()=>{
  expect(()=>createMaterialMappingDebug({mode:'density',textureSize:[0,256]})).toThrow();
  const debug=createMaterialMappingDebug({mode:'checker',textureSize:[128,64],repeat:[2,3],uvMeters:[4,2]});
  expect(debug.uniforms.texels.value.toArray()).toEqual([256,192]);expect(debug.uniforms.uvMeters.value.toArray()).toEqual([4,2]);debug.dispose();
});
