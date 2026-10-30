import {expect,it,vi} from 'vitest';
import {BackSide,DataTexture,Material,Mesh,MeshDepthMaterial,MeshDistanceMaterial,MeshStandardMaterial,PerspectiveCamera,RGBAFormat,RGBADepthPacking,Scene,SphereGeometry,Texture} from 'three';
import {createGeneratedAlphaShadows,isGeneratedAlphaShadowMaterial} from '../src/sandbox/generatedAlpha.ts';
import {registerGeneratedGeometryLod} from '../src/sandbox/generatedLod.ts';
import {RenderVisibility} from '../src/sandbox/renderVisibility.ts';
import {WebGLRenderer as CompatibleWebGPURenderer} from '../src/sandbox/rendererWebGPU.ts';
import {WebGPURenderer as NativeWebGPURenderer,NodeMaterial} from 'three/webgpu';
function hashed(){return new MeshStandardMaterial({alphaHash:true,alphaTest:0,alphaToCoverage:false,transparent:false,map:new DataTexture(new Uint8Array([50,170,20,68]),1,1,RGBAFormat)});}

it('prepares native hashed depth and point-distance shadows with borrowed leaf opacity',()=>{
 const source=hashed(),handle=createGeneratedAlphaShadows(source);let textureReleases=0;source.map!.addEventListener('dispose',()=>textureReleases++);
 try{expect(handle.depth).toBeInstanceOf(MeshDepthMaterial);expect(handle.distance).toBeInstanceOf(MeshDistanceMaterial);expect(handle.depth.depthPacking).toBe(RGBADepthPacking);
  for(const material of [handle.depth,handle.distance]){expect(material.alphaHash).toBe(true);expect(material.alphaTest).toBe(0);expect(material.alphaToCoverage).toBe(false);expect(material.transparent).toBe(false);expect(material.map).toBe(source.map);expect(material.onBeforeCompile).toBe(Material.prototype.onBeforeCompile);expect(isGeneratedAlphaShadowMaterial(material)).toBe(true);}
  // WebGL's native shadow preparation copies these ordinary fields per draw.
  handle.depth.side=BackSide;handle.depth.map=new Texture();expect(isGeneratedAlphaShadowMaterial(handle.depth)).toBe(true);handle.depth.map.dispose();
 }finally{handle.dispose();handle.dispose();expect(textureReleases).toBe(0);source.map!.dispose();source.dispose();}
});
it('caches one pair per source material and releases it exactly once with its owner',()=>{
 const source=hashed(),a=createGeneratedAlphaShadows(source),b=createGeneratedAlphaShadows(source);expect(a).toBe(b);let depth=0,distance=0;a.depth.addEventListener('dispose',()=>depth++);a.distance.addEventListener('dispose',()=>distance++);
 source.dispose();a.dispose();b.dispose();source.dispose();expect([depth,distance]).toEqual([1,1]);expect(isGeneratedAlphaShadowMaterial(a.depth)).toBe(false);expect(isGeneratedAlphaShadowMaterial(a.distance)).toBe(false);source.map!.dispose();
});
it('does not trust matching public tags or unsafe mutations on an engine-owned material',()=>{
 const source=hashed(),handle=createGeneratedAlphaShadows(source),forged=new MeshDepthMaterial({alphaHash:true,alphaTest:0,depthPacking:RGBADepthPacking});forged.userData.generatedAlpha=true;
 expect(isGeneratedAlphaShadowMaterial(undefined)).toBe(false);expect(isGeneratedAlphaShadowMaterial(forged)).toBe(false);
 handle.depth.onBeforeCompile=()=>{};expect(isGeneratedAlphaShadowMaterial(handle.depth)).toBe(false);handle.depth.onBeforeCompile=Material.prototype.onBeforeCompile;
 const displacement=new Texture();handle.depth.displacementMap=displacement;expect(isGeneratedAlphaShadowMaterial(handle.depth)).toBe(false);handle.depth.displacementMap=null;
 const getter=vi.fn(()=>false);Object.defineProperty(handle.depth,'transparent',{get:getter,configurable:true});expect(isGeneratedAlphaShadowMaterial(handle.depth)).toBe(false);expect(getter).not.toHaveBeenCalled();
 Object.defineProperty(handle.depth,'transparent',{value:false,writable:true,configurable:true});expect(isGeneratedAlphaShadowMaterial(handle.depth)).toBe(true);
 handle.dispose();forged.dispose();displacement.dispose();source.map!.dispose();source.dispose();
});
it('rejects nonhashed or authored sources without evaluating alpha accessors',()=>{
 const source=new MeshStandardMaterial();expect(()=>createGeneratedAlphaShadows(source)).toThrow(/native opaque hashed/);source.alphaHash=true;source.onBeforeCompile=()=>{};expect(()=>createGeneratedAlphaShadows(source)).toThrow();source.onBeforeCompile=Material.prototype.onBeforeCompile;
 const getter=vi.fn(()=>true);Object.defineProperty(source,'alphaHash',{get:getter,configurable:true});expect(()=>createGeneratedAlphaShadows(source)).toThrow();expect(getter).not.toHaveBeenCalled();source.dispose();
});
it('permits generated shadow pairs through prepared LOD but preserves unsupported custom shadow paths',()=>{
 const source=hashed(),high=new SphereGeometry(1,24,16),low=new SphereGeometry(1,6,4),handle=createGeneratedAlphaShadows(source),mesh=new Mesh(high,source),scene=new Scene(),camera=new PerspectiveCamera(60,1,.1,1000),policy=new RenderVisibility();mesh.position.z=-200;mesh.customDepthMaterial=handle.depth;mesh.customDistanceMaterial=handle.distance;scene.add(mesh);
 const off=registerGeneratedGeometryLod(high,[{geometry:high,error:0},{geometry:low,error:.1}]);
 try{policy.prepare(scene,camera,720);expect(mesh.geometry).toBe(low);policy.restore();
  handle.depth.onBeforeCompile=()=>{};policy.prepare(scene,camera,720);expect(mesh.geometry).toBe(high);policy.restore();handle.depth.onBeforeCompile=Material.prototype.onBeforeCompile;
  const foreign=handle.depth.clone();mesh.customDepthMaterial=foreign;policy.prepare(scene,camera,720);expect(mesh.geometry).toBe(high);policy.restore();foreign.dispose();
 }finally{policy.dispose();off();handle.dispose();high.dispose();low.dispose();source.map!.dispose();source.dispose();}
});
it('allows only the validated native shadow exception through the WebGPU facade',()=>{
 // Exercise the facade boundary without pretending this CPU test renders a GPU.
 const native=vi.spyOn(NativeWebGPURenderer.prototype,'renderObject').mockImplementation(()=>{}),adapter=Object.create(CompatibleWebGPURenderer.prototype) as CompatibleWebGPURenderer,source=hashed(),handle=createGeneratedAlphaShadows(source),geometry=new SphereGeometry(1,6,4),mesh=new Mesh(geometry,source),scene=new Scene(),camera=new PerspectiveCamera();
 const draw=()=>adapter.renderObject(...[mesh,scene,camera,geometry,source,null,{}] as unknown as Parameters<CompatibleWebGPURenderer['renderObject']>);
 try{mesh.customDepthMaterial=handle.depth;mesh.customDistanceMaterial=handle.distance;expect(draw).not.toThrow();expect(native).toHaveBeenCalledOnce();
  const foreign=handle.depth.clone();mesh.customDepthMaterial=foreign;expect(draw).toThrow(/custom WebGL shadow/);expect(native).toHaveBeenCalledOnce();foreign.dispose();mesh.customDepthMaterial=handle.depth;
  handle.distance.onBeforeCompile=()=>{};expect(draw).toThrow(/custom WebGL shadow/);expect(native).toHaveBeenCalledOnce();
 }finally{native.mockRestore();handle.dispose();geometry.dispose();source.map!.dispose();source.dispose();}
});
it('scopes cached native WebGPU hash overrides by base and source, including nested failed draws',async()=>{
 const native=vi.spyOn(NativeWebGPURenderer.prototype,'renderObject'),dispose=vi.spyOn(NativeWebGPURenderer.prototype,'dispose').mockImplementation(async()=>{}),adapter=Object.create(CompatibleWebGPURenderer.prototype) as CompatibleWebGPURenderer,base=Object.assign(new NodeMaterial(),{isShadowPassMaterial:true}),scene=new Scene(),camera=new PerspectiveCamera(),geometry=new SphereGeometry(1,6,4),a=hashed(),b=hashed(),ap=createGeneratedAlphaShadows(a),bp=createGeneratedAlphaShadows(b),ma=new Mesh(geometry,a),mb=new Mesh(geometry,b);
 ma.customDepthMaterial=ap.depth;ma.customDistanceMaterial=ap.distance;mb.customDepthMaterial=bp.depth;mb.customDistanceMaterial=bp.distance;scene.overrideMaterial=base;
 const seen=new Map<Material,NodeMaterial>(),draw=(mesh:Mesh)=>adapter.renderObject(...[mesh,scene,camera,geometry,mesh.material,null,{}] as unknown as Parameters<CompatibleWebGPURenderer['renderObject']>);
 let nested=false,fail=false;
 native.mockImplementation((_mesh,_scene,_camera,_geometry,source)=>{const current=scene.overrideMaterial as NodeMaterial;expect(current).not.toBe(base);expect(current.alphaHash).toBe(true);expect(current.alphaTest).toBe(0);expect(current.alphaToCoverage).toBe(false);if(seen.has(source))expect(current).toBe(seen.get(source));else seen.set(source,current);
  if(nested&&source===a){draw(mb);expect(scene.overrideMaterial).toBe(current);if(fail)throw Error('native shadow failed');}
 });
 try{
  draw(ma);draw(mb);draw(ma);a.opacity=.4;draw(ma);expect(seen.get(a)!.opacity).toBe(.4);expect(scene.overrideMaterial).toBe(base);expect(seen.get(a)).not.toBe(seen.get(b));expect(base.alphaHash).toBe(false);
  nested=true;fail=true;expect(()=>draw(ma)).toThrow('native shadow failed');expect(scene.overrideMaterial).toBe(base);
  let ar=0,br=0;seen.get(a)!.addEventListener('dispose',()=>ar++);seen.get(b)!.addEventListener('dispose',()=>br++);a.dispose();expect([ar,br]).toEqual([1,0]);base.dispose();expect([ar,br]).toEqual([1,1]);await adapter.dispose();expect([ar,br]).toEqual([1,1]);
 }finally{native.mockRestore();dispose.mockRestore();ap.dispose();bp.dispose();geometry.dispose();a.map!.dispose();b.map!.dispose();a.dispose();b.dispose();base.dispose();}
});
it('bounds native WebGPU shadow variants and restores the base when the limit is reached',async()=>{
 const native=vi.spyOn(NativeWebGPURenderer.prototype,'renderObject').mockImplementation(()=>{}),dispose=vi.spyOn(NativeWebGPURenderer.prototype,'dispose').mockImplementation(async()=>{}),adapter=Object.create(CompatibleWebGPURenderer.prototype) as CompatibleWebGPURenderer,base=Object.assign(new NodeMaterial(),{isShadowPassMaterial:true}),scene=new Scene(),camera=new PerspectiveCamera(),geometry=new SphereGeometry(1,6,4),owner=hashed(),pair=createGeneratedAlphaShadows(owner),sources=Array.from({length:513},()=>owner.clone()),mesh=new Mesh(geometry,owner);mesh.customDepthMaterial=pair.depth;mesh.customDistanceMaterial=pair.distance;scene.overrideMaterial=base;
 const draw=(source:Material)=>adapter.renderObject(...[mesh,scene,camera,geometry,source,null,{}] as unknown as Parameters<CompatibleWebGPURenderer['renderObject']>);
 try{for(const source of sources.slice(0,512))draw(source);expect(native).toHaveBeenCalledTimes(512);expect(()=>draw(sources[512])).toThrow(/512 material-pair budget/);expect(scene.overrideMaterial).toBe(base);await adapter.dispose();}
 finally{native.mockRestore();dispose.mockRestore();pair.dispose();for(const source of sources)source.dispose();geometry.dispose();owner.map!.dispose();owner.dispose();base.dispose();}
});
