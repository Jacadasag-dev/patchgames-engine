import {afterEach,describe,expect,it,vi} from 'vitest';
import {ACESFilmicToneMapping,Color,PerspectiveCamera,Scene,SRGBColorSpace,Vector3,Vector4,WebGPUCoordinateSystem,type Data3DTexture,type DataTexture,type RenderTarget} from 'three';
import type {WebGPURenderer} from 'three/webgpu';
import {compilePlanetSky,createPlanetSkyRecipe} from '../src/shared/planetSky.ts';
import {PlanetSkyWebGPUView} from '../src/sandbox/planetSkyWebGPU.ts';
import {createPlanetSkyNoiseMipmaps} from '../src/sandbox/planetSkyWebGPUMips.ts';
import * as skyShaders from '../src/sandbox/planetSkyWebGPUShader.ts';
import {createPlanetWeatherRecipe} from '../src/shared/planetWeather.ts';
import type {PlanetAtmosphereSnapshot} from '../src/shared/planetAtmosphereSnapshot.ts';

const radius=6_371_000,bake=compilePlanetSky(createPlanetSkyRecipe(73,radius),radius).bake();
const frame={position:[0,radius+75,0] as const,timeSeconds:10,sunDirection:[1,1,0] as const};
class Renderer {
  initialized=true;coordinateSystem=WebGPUCoordinateSystem;reversedDepthBuffer=false;logarithmicDepthBuffer=true;
  backend={isWebGPUBackend:true,device:{limits:{maxTextureDimension2D:8192,maxTextureDimension3D:2048,maxColorAttachments:8}}};
  xr={isPresenting:false,enabled:true};target:RenderTarget|null=null;output:RenderTarget|null=null;mrt:unknown={host:'authored MRT'};
  viewport=new Vector4(3,5,900,600);scissor=new Vector4(4,6,800,500);scissorTest=true;
  color=new Color('#123456');alpha=1;autoClear=true;toneMapping=ACESFilmicToneMapping;outputColorSpace=SRGBColorSpace;
  calls=0;throwAt=0;info={render:{triangles:900,drawCalls:123}};
  initializedTextures:(Data3DTexture|DataTexture)[]=[];copies:{source:Data3DTexture;destination:Data3DTexture;depth:number;level:number}[]=[];
  textureAllocations=new Map<Data3DTexture|DataTexture,{width:number;height:number}>();trackedTextures=new WeakSet<Data3DTexture|DataTexture>();
  getRenderTarget(){return this.target;}
  getOutputRenderTarget(){return this.output;}
  getViewport(v:Vector4){return v.copy(this.viewport);}
  getScissor(v:Vector4){return v.copy(this.scissor);}
  getPixelRatio(){return 1;}
  getScissorTest(){return this.scissorTest;}
  setScissorTest(v:boolean){this.scissorTest=v;}
  setRenderTarget(v:RenderTarget|null){this.target=v;}
  setViewport(v:Vector4){this.viewport.copy(v);}
  setScissor(v:Vector4){this.scissor.copy(v);}
  getMRT(){return this.mrt;}
  setMRT(v:unknown){this.mrt=v;}
  getClearColor(v:Color){return v.copy(this.color);}
  getClearAlpha(){return this.alpha;}
  setClearColor(v:Color,alpha:number){this.color.copy(v);this.alpha=alpha;}
  clear(){}
  initTexture(texture:Data3DTexture|DataTexture){
    const allocated=this.textureAllocations.get(texture),{width,height}=texture.image;
    if(allocated&&(allocated.width!==width||allocated.height!==height))throw Error('Native texture allocation size changed without disposal.');
    if(!this.trackedTextures.has(texture)){this.trackedTextures.add(texture);texture.addEventListener('dispose',()=>this.textureAllocations.delete(texture));}
    this.textureAllocations.set(texture,{width,height});this.initializedTextures.push(texture);
  }
  copyTextureToTexture(source:Data3DTexture,destination:Data3DTexture,region:{max:{z:number}},_position:null,_srcLevel:number,level:number){this.copies.push({source,destination,depth:region.max.z,level});}
  render(){
    this.calls++;if(this.calls===this.throwAt)throw Error('native render failed');
    // Native info is cumulative between host resets. Fullscreen draws must not
    // leak into world statistics, including on the second frame.
    const world=this.calls%3===1;this.info.render.triangles+=world?512:1;this.info.render.drawCalls+=world?6:1;
  }
}
const asRenderer=(r:Renderer)=>r as unknown as WebGPURenderer;
const views:PlanetSkyWebGPUView[]=[];
const make=()=>{const view=new PlanetSkyWebGPUView(bake);views.push(view);return view;};
const camera=()=>new PerspectiveCamera(60,1,.1,radius*8);
const snapshot=(sequence:number,timeSeconds:number):PlanetAtmosphereSnapshot=>{
  const width=64,height=32,condensate=new Float32Array(width*height*4),materialLower=new Float32Array(condensate.length),materialUpper=new Float32Array(condensate.length),cloudAltitudeMoments=new Float32Array(condensate.length);
  for(let offset=0;offset<condensate.length;offset+=4){condensate[offset]=.1;materialLower[offset]=1;materialLower[offset+3]=.005;materialUpper[offset]=1;materialUpper[offset+3]=100;const mass=condensate[offset]+materialLower[offset+3];cloudAltitudeMoments[offset]=1000*mass;cloudAltitudeMoments[offset+1]=3000*mass;}
  return{kind:'planet-atmosphere-snapshot',version:2,revision:'physical-atmosphere',planetRevision:'physical-planet',epoch:1,sequence,timeSeconds,radiusMeters:radius,width,height,atmosphereHeightMeters:bake.recipe.atmosphere.heightMeters,cloudBoundsMeters:[1000,3000,0,0],condensate,materialLower,materialUpper,cloudAltitudeMoments};
};
afterEach(()=>{views.forEach(view=>view.dispose());views.length=0;vi.restoreAllMocks();});

describe('native WebGPU planet sky',()=>{
  it('captures, integrates, composes and restores host state without accumulating scene statistics',()=>{
    const view=make(),r=new Renderer(),before={viewport:r.viewport.clone(),scissor:r.scissor.clone(),color:r.color.clone(),mrt:r.mrt};
    for(let i=0;i<2;i++){
      view.render(asRenderer(r),new Scene(),camera(),frame);
      expect(view.inspection()).toMatchObject({backend:'webgpu',frames:i+1,sceneTriangles:512,sceneDrawCalls:6});
      expect(r.target).toBeNull();expect(r.viewport).toEqual(before.viewport);expect(r.scissor).toEqual(before.scissor);expect(r.mrt).toBe(before.mrt);
      expect(r.color).toEqual(before.color);expect(r.alpha).toBe(1);expect(r.autoClear).toBe(true);expect(r.scissorTest).toBe(true);expect(r.toneMapping).toBe(ACESFilmicToneMapping);expect(r.outputColorSpace).toBe(SRGBColorSpace);expect(r.xr.enabled).toBe(true);
    }
    expect(r.calls).toBe(6);expect(r.initializedTextures).toHaveLength(4);
    expect(r.copies.map(copy=>[copy.level,copy.depth])).toEqual([[1,16],[2,8],[3,4],[4,2],[5,1]]);
    expect(r.copies.every(copy=>copy.destination===r.initializedTextures[0])).toBe(true);
    expect(view.inspection().volumePixels).toBeLessThanOrEqual(view.inspection().limits.maxPixels);
  });
  it.each([1,2,3])('restores color-space, XR, MRT, target and rectangles when pass %i fails',pass=>{
    const view=make(),r=new Renderer();r.throwAt=pass;
    const before={viewport:r.viewport.clone(),scissor:r.scissor.clone(),color:r.color.clone(),mrt:r.mrt};
    expect(()=>view.render(asRenderer(r),new Scene(),camera(),frame)).toThrow('native render failed');
    expect(r.target).toBeNull();expect(r.viewport).toEqual(before.viewport);expect(r.scissor).toEqual(before.scissor);expect(r.mrt).toBe(before.mrt);expect(r.color).toEqual(before.color);
    expect(r.autoClear).toBe(true);expect(r.scissorTest).toBe(true);expect(r.toneMapping).toBe(ACESFilmicToneMapping);expect(r.outputColorSpace).toBe(SRGBColorSpace);expect(r.xr.enabled).toBe(true);expect(view.inspection().frames).toBe(0);
  });
  it('changes quality/style/diagnostics live without replacing the seeded field or uploading again',()=>{
    const view=make(),r=new Renderer(),key=view.inspection().bakeKey;
    view.setDiagnostic('transmittance');view.setRecipe({...bake.recipe,style:'pixel',quality:'low',pixelSize:8});view.render(asRenderer(r),new Scene(),camera(),frame);
    expect(view.inspection()).toMatchObject({style:'pixel',quality:'low',diagnostic:'transmittance',bakeKey:key});expect(view.inspection().volumePixels).toBeLessThanOrEqual(65_536);
    view.setRecipe({...bake.recipe,quality:'high'});view.render(asRenderer(r),new Scene(),camera(),frame);expect(view.inspection().volumePixels).toBeLessThanOrEqual(360_000);expect(r.copies).toHaveLength(5);
    const revision=view.inspection().revision;expect(()=>view.setRecipe({...bake.recipe,seed:74})).toThrow(/replacement/);expect(view.inspection().revision).toBe(revision);
  });
  it('renders the ordinary native scene directly when both effects are disabled',()=>{
    const view=make(),r=new Renderer();view.setRecipe({...bake.recipe,atmosphere:{...bake.recipe.atmosphere,enabled:false},clouds:{...bake.recipe.clouds,enabled:false},celestial:{...bake.recipe.celestial,sunEnabled:false,starsEnabled:false}});
    view.render(asRenderer(r),new Scene(),camera(),frame);expect(r.calls).toBe(1);expect(r.initializedTextures).toHaveLength(0);expect(r.copies).toHaveLength(0);expect(view.inspection()).toMatchObject({captureWidth:0,sceneTriangles:512,sceneDrawCalls:6});
  });
  it('rejects fallback, uninitialized devices, unsupported targets, invalid depth and oversized captures before drawing',()=>{
    const view=make(),r=new Renderer(),c=camera();
    r.backend.isWebGPUBackend=false;expect(()=>view.render(asRenderer(r),new Scene(),c,frame)).toThrow(/fallback/);r.backend.isWebGPUBackend=true;
    r.initialized=false;expect(()=>view.render(asRenderer(r),new Scene(),c,frame)).toThrow(/initialized/);r.initialized=true;
    r.reversedDepthBuffer=true;expect(()=>view.render(asRenderer(r),new Scene(),c,frame)).toThrow(/depth/);r.reversedDepthBuffer=false;
    c.near=0;expect(()=>view.render(asRenderer(r),new Scene(),c,frame)).toThrow(/clip planes/);c.near=.1;
    r.viewport.set(0,0,8192,8192);expect(()=>view.render(asRenderer(r),new Scene(),c,frame)).toThrow(/8-megapixel/);expect(r.calls).toBe(0);expect(r.copies).toHaveLength(0);
  });
  it('owns independent bake data and releases each retained GPU resource once',()=>{
    const view=make(),r=new Renderer();view.render(asRenderer(r),new Scene(),camera(),frame);
    const resources=view as unknown as {noise:Data3DTexture;weather:Data3DTexture;circulationCoverage:DataTexture;circulationEnvironment:DataTexture;sceneTarget:RenderTarget;volumeTarget:RenderTarget;geometry:{dispose():void};volumeMaterial:{dispose():void};pipeline:{dispose():void}};
    expect(resources.noise.image.data).not.toBe(bake.noise.data);expect(resources.weather.image.data).not.toBe(bake.weather.data);
    expect(resources.circulationCoverage.image.data).not.toBe(bake.circulation.coverage.data);expect(resources.circulationEnvironment.image.data).not.toBe(bake.circulation.environment.data);
    expect(resources.noise.generateMipmaps).toBe(false);expect(resources.noise.mipmaps).toHaveLength(6);
    const spies=(['noise','weather','circulationCoverage','circulationEnvironment','sceneTarget','volumeTarget','geometry','volumeMaterial','pipeline'] as const).map(key=>vi.spyOn(resources[key],'dispose'));
    view.dispose();view.dispose();expect(view.inspection().disposed).toBe(true);for(const spy of spies)expect(spy).toHaveBeenCalledTimes(1);
    expect(()=>view.render(asRenderer(r),new Scene(),camera(),frame)).toThrow(/disposed/);
  });
  it('still composes celestial light when only air and clouds are disabled',()=>{
    const view=make(),r=new Renderer();view.setRecipe({...bake.recipe,atmosphere:{...bake.recipe.atmosphere,enabled:false},clouds:{...bake.recipe.clouds,enabled:false}});
    view.render(asRenderer(r),new Scene(),camera(),{...frame,starRotationRadians:Math.PI,presentationTimeSeconds:12});
    expect(r.calls).toBe(3);expect(view.inspection()).toMatchObject({sunEnabled:true,starsEnabled:true,cloudLayers:3});
  });
  it('retains fixed storm banks and reuses every uploaded atlas during day/night and shadow edits',()=>{
    const view=make(),r=new Renderer();view.render(asRenderer(r),new Scene(),camera(),frame);
    const resources=view as unknown as {uniforms:{stormCenters0:{value:{elements:number[]}};clock:{value:Vector4}}};
    const bank=resources.uniforms.stormCenters0.value.elements;
    view.setRecipe({...bake.recipe,celestial:{...bake.recipe.celestial,starIntensity:2,twinkle:.8},clouds:{...bake.recipe.clouds,shadowStrength:.8,godRayStrength:.9}});
    view.render(asRenderer(r),new Scene(),camera(),{...frame,timeSeconds:86400,presentationTimeSeconds:4100,starRotationRadians:Math.PI*3});
    expect(r.initializedTextures).toHaveLength(4);expect(resources.uniforms.stormCenters0.value.elements).toBe(bank);expect(resources.uniforms.clock.value.x).toBe(4);expect(resources.uniforms.clock.value.y).toBeCloseTo(Math.PI);
    expect(view.inspection()).toMatchObject({cloudShadowStrength:.8,godRayStrength:.9});
  });
  it('keeps physical weather clocks independent of planet radius and uploads the coupled column controls',()=>{
    const smallRadius=1000,compiled=compilePlanetSky({kind:'planet-sky',version:1,seed:73,celestial:{dayLengthSeconds:43200},clouds:{windMetersPerSecond:[7,-3,2],circulation:{...createPlanetWeatherRecipe(73),resolution:128,timeScale:3}}},smallRadius),smallBake=compiled.bake();
    const view=new PlanetSkyWebGPUView(smallBake);views.push(view);const r=new Renderer(),timeSeconds=-12345,weatherFrame=compiled.weather.frame(timeSeconds);
    view.render(asRenderer(r),new Scene(),new PerspectiveCamera(60,1,.1,smallRadius*8),{position:[0,smallRadius+75,0],timeSeconds,sunDirection:[1,1,0]});
    const resources=view as unknown as {uniforms:{weatherParams:{value:Vector4};condensationThreshold:{value:number};weatherEvolutionPhase:{value:number};shapeWind:{value:Vector3}}};
    expect(resources.uniforms.weatherParams.value.x).toBe(weatherFrame.timeDays);expect(resources.uniforms.weatherParams.value.w).toBe(2);
    expect(resources.uniforms.condensationThreshold.value).toBe(smallBake.circulation.condensationThreshold);
    expect(resources.uniforms.weatherEvolutionPhase.value).toBe((weatherFrame.timeDays%(1/12))*12*Math.PI*2);
    const shapeScale=compiled.recipe.clouds.shapeScaleMeters,offset=compiled.recipe.clouds.windMetersPerSecond.map(w=>{const x=-w*timeSeconds/(shapeScale*32);return x-Math.floor(x);});
    expect(resources.uniforms.shapeWind.value.toArray()).toEqual(offset);expect(offset.every(value=>value>=0&&value<1)).toBe(true);
    expect(view.inspection().transport).toMatchObject({cloudPrimarySamples:20,airPrimarySamples:12,maxCloudIntervals:6,maxCloudLightSamples:18});
  });
  it.each([NaN,Infinity,-2.01,2.01])('rejects an invalid baked condensation threshold %s before drawing',threshold=>{
    expect(()=>new PlanetSkyWebGPUView({...bake,circulation:{...bake.circulation,condensationThreshold:threshold}})).toThrow(/circulation/);
  });
  it('preserves the physical pressure ellipse through repeated phase turns',()=>{
    const view=make(),r=new Renderer(),timeSeconds=86400*100,storms=compilePlanetSky(bake.recipe,radius).weather.frame(timeSeconds).cyclones;
    view.render(asRenderer(r),new Scene(),camera(),{...frame,timeSeconds});
    const resources=view as unknown as {uniforms:Record<string,{value:{elements:number[]}}>};
    expect(storms.some(storm=>Math.abs(storm.phase)>Math.PI*2)).toBe(true);
    for(let index=0;index<storms.length;index++){
      const phase=resources.uniforms['stormProperties'+Math.floor(index/4)].value.elements[index%4*4+1],angle=storms[index].phase*.15;
      expect(Math.abs(phase*.15)).toBeLessThanOrEqual(Math.PI*2);
      expect(Math.sin(phase*.15)).toBeCloseTo(Math.sin(angle),12);expect(Math.cos(phase*.15)).toBeCloseTo(Math.cos(angle),12);
    }
  });
  it('stages complete physical endpoint pairs without exposing partial planes or rebuilding nodes',()=>{
    const view=make(),r=new Renderer(),scene=new Scene(),c=camera(),previous=snapshot(1,100),current=snapshot(2,200);
    const resources=view as unknown as {uniforms:{snapshotParams:{value:Vector4};weatherParams:{value:Vector4}};snapshotNodes:Record<string,{value:DataTexture}>;volumeMaterial:{version:number}};
    const nodes=resources.snapshotNodes,version=resources.volumeMaterial.version;
    expect(view.setWeatherSnapshots(previous,current)).toBe(true);
    for(let pass=0;pass<8;pass++){
      view.render(asRenderer(r),scene,c,{...frame,timeSeconds:150});
      expect(resources.uniforms.snapshotParams.value.x).toBe(1);expect(resources.uniforms.snapshotParams.value.z).toBe(pass===7?1:0);expect(resources.uniforms.snapshotParams.value.w).toBe(pass===7?2:0);
      expect(resources.uniforms.weatherParams.value.y).toBe(0);expect(resources.snapshotNodes).toBe(nodes);expect(resources.volumeMaterial.version).toBe(version);
    }
    expect(resources.uniforms.snapshotParams.value.y).toBe(.5);expect(view.inspection().simulation).toMatchObject({active:true,sequence:2,uploads:8,staging:false});
    expect(nodes.snapshotCondensate0.value.image.data).toBe(previous.condensate);expect(nodes.snapshotCondensate1.value.image.data).toBe(current.condensate);
    expect(view.setWeatherSnapshots(previous,current)).toBe(false);view.render(asRenderer(r),scene,c,{...frame,timeSeconds:500});expect(resources.uniforms.snapshotParams.value.y).toBe(1);
    expect(()=>view.setWeatherSnapshots(previous)).toThrow(/Stale/);
  });
  it('keeps physical simulation empty until ready and can clear it without leaking a retired snapshot',()=>{
    const view=make(),r=new Renderer(),scene=new Scene(),c=camera();
    const resources=view as unknown as {uniforms:{snapshotParams:{value:Vector4}}};view.enableSimulation();view.render(asRenderer(r),scene,c,frame);
    expect(resources.uniforms.snapshotParams.value.toArray()).toEqual([1,0,0,0]);
    const state=snapshot(1,10);view.setWeatherSnapshots(state);for(let pass=0;pass<4;pass++)view.render(asRenderer(r),scene,c,frame);
    expect(resources.uniforms.snapshotParams.value.z).toBe(1);view.clearWeatherSnapshots();view.enableSimulation();view.render(asRenderer(r),scene,c,frame);
    expect(resources.uniforms.snapshotParams.value.toArray()).toEqual([1,0,0,0]);view.dispose();expect(()=>view.setWeatherSnapshots(state)).toThrow(/disposed/);
  });
  it('recreates primed 1x1 snapshot allocations before uploading a larger grid while retaining nodes',()=>{
    const view=make(),r=new Renderer(),resources=view as unknown as {snapshotNodes:Record<string,{value:DataTexture}>};
    const nodes=resources.snapshotNodes;for(const node of Object.values(nodes))r.initTexture(node.value);
    view.setWeatherSnapshots(snapshot(1,10));for(let pass=0;pass<4;pass++)view.render(asRenderer(r),new Scene(),camera(),frame);
    expect(view.inspection().simulation).toMatchObject({active:true,error:'',uploads:4});expect(resources.snapshotNodes).toBe(nodes);
    expect(nodes.snapshotCondensate0.value.image.width).toBe(64);expect(r.textureAllocations.get(nodes.snapshotCondensate0.value)).toEqual({width:64,height:32});
  });
  it('lets the host freeze staged weather and advances exactly one plane before a prepared render',()=>{
    const view=make(),r=new Renderer(),scene=new Scene(),c=camera();view.setWeatherSnapshots(snapshot(1,10));
    for(let pass=0;pass<4;pass++)view.render(asRenderer(r),scene,c,{...frame,weatherPrepared:true});
    expect(view.inspection().simulation).toMatchObject({active:false,uploads:0});
    view.stageWeather(r);view.render(asRenderer(r),scene,c,{...frame,weatherPrepared:true});
    expect(view.inspection().simulation).toMatchObject({active:false,uploads:1});
    view.stageWeather(r);view.render(asRenderer(r),scene,c,{...frame,weatherPrepared:true});
    expect(view.inspection().simulation).toMatchObject({active:false,uploads:2});
    view.stageWeather(r);view.render(asRenderer(r),scene,c,{...frame,weatherPrepared:true});
    expect(view.inspection().simulation).toMatchObject({active:false,uploads:3});
    view.stageWeather(r);view.render(asRenderer(r),scene,c,{...frame,weatherPrepared:true});
    expect(view.inspection().simulation).toMatchObject({active:true,uploads:4});
    view.dispose();expect(()=>view.stageWeather(r)).toThrow(/disposed/);
  });
  it('uses conservative physical bounds and samples only the completely uploaded altitude pair',()=>{
    const view=make(),r=new Renderer(),scene=new Scene(),c=camera(),state=snapshot(1,10);
    state.cloudBoundsMeters=[1000,3000,2000,4500];
    for(let offset=0;offset<state.condensate.length;offset+=4){state.condensate[offset+1]=.02;state.condensate[offset+2]=.01;const mass=state.condensate[offset+1]+state.condensate[offset+2];state.cloudAltitudeMoments[offset+2]=2000*mass;state.cloudAltitudeMoments[offset+3]=4500*mass;}
    view.setWeatherSnapshots(state);expect(view.sampleWeather([0,1,0],10)).toBeUndefined();
    for(let pass=0;pass<3;pass++)view.render(asRenderer(r),scene,c,frame);expect(view.sampleWeather([0,1,0],10)).toBeUndefined();
    view.render(asRenderer(r),scene,c,frame);const column=view.sampleWeather([0,1,0],10)!;
    expect(column.surfaceHeightMetersAsl).toBe(100);expect(column.lowerBaseMetersAsl).toBeCloseTo(1000,3);expect(column.lowerTopMetersAsl).toBeCloseTo(3000,3);expect(column.upperBaseMetersAsl).toBeCloseTo(2000,3);expect(column.upperTopMetersAsl).toBeCloseTo(4500,3);
    const resources=view as unknown as {uniforms:{fogLayer:{value:Vector4};cumulusLayer:{value:Vector4};cirrusLayer:{value:Vector4}};snapshotNodes:Record<string,{value:DataTexture}>};
    expect(resources.uniforms.fogLayer.value.toArray()).toEqual([1000/radius,2000/radius,1,1]);expect(resources.uniforms.cumulusLayer.value.toArray()).toEqual([2000/radius,2500/radius,1,1]);expect(resources.uniforms.cirrusLayer.value.w).toBe(0);
    expect(view.inspection().cloudLayers).toBe(2);
    expect(resources.snapshotNodes.snapshotAltitude0.value.image.data).toBe(state.cloudAltitudeMoments);
    const next=snapshot(2,20);view.setWeatherSnapshots(state,next);expect(view.sampleWeather([0,1,0],20)!.upperTopMetersAsl).toBeCloseTo(4500,3);
    view.clearWeatherSnapshots();view.render(asRenderer(r),scene,c,frame);expect(resources.uniforms.fogLayer.value.y).toBe(bake.recipe.clouds.layers.fog.thicknessMeters/radius);expect(resources.uniforms.cirrusLayer.value.w).toBe(1);
    expect(view.inspection().cloudLayers).toBe(3);
  });
  it('rejects physical atmosphere-height changes until simulation is cleared',()=>{
    const view=make(),changed={...bake.recipe,atmosphere:{...bake.recipe.atmosphere,heightMeters:bake.recipe.atmosphere.heightMeters+100}};
    view.enableSimulation();expect(()=>view.setRecipe(changed)).toThrow(/height/i);view.clearWeatherSnapshots();expect(()=>view.setRecipe(changed)).not.toThrow();
  });
});

describe('native WGSL source contract',()=>{
  it('keeps shader declarations clear of WGSL keywords and reserved identifiers',()=>{
    // WGSL rejects these even when a local name would be legal in TypeScript
    // or GLSL. Scan the final strings, including shared weather helper code.
    const reserved=new Set(`alias break case const const_assert continue continuing default diagnostic discard else enable false fn for if let loop override requires return struct switch true var while NULL Self abstract active alignas alignof as asm asm_fragment async attribute auto await become binding_array cast catch class co_await co_return co_yield coherent column_major common compile compile_fragment concept const_cast consteval constexpr constinit crate debugger decltype delete demote demote_to_helper do dynamic_cast enum explicit export extends extern external fallthrough filter final finally friend from fxgroup get goto groupshared highp impl implements import inline instanceof interface layout lowp macro macro_rules match mediump meta mod module move mut mutable namespace new nil noexcept noinline nointerpolation non_coherent noncoherent noperspective null nullptr of operator package packoffset partition pass patch pixelfragment precise precision premerge priv protected pub public readonly ref regardless register reinterpret_cast require resource restrict self set shared sizeof smooth snorm static static_assert static_cast std subroutine super target template this thread_local throw trait try type typedef typeid typename typeof union unless unorm unsafe unsized use using varying virtual volatile wgsl where with writeonly yield`.split(/\s+/));
    const invalid:string[]=[];
    for(const [name,raw] of Object.entries(skyShaders)){
      const source=raw.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');
      const declarations=[...source.matchAll(/\b(?:fn|struct|let|var(?:<[^>]+>)?|const|override|alias)\s+([A-Za-z_]\w*)/g),...source.matchAll(/\b([A-Za-z_]\w*)\s*:/g)];
      for(const declaration of declarations)if(reserved.has(declaration[1]))invalid.push(`${name}: ${declaration[1]}`);
    }
    expect(invalid).toEqual([]);
  });
});

describe('bounded 3D noise mip preparation',()=>{
  it('averages each 2x2x2 group independently and preserves constant channels through the final voxel',()=>{
    const data=new Uint8Array(32**3*4);
    for(let z=0;z<32;z++)for(let y=0;y<32;y++)for(let x=0;x<32;x++){
      const index=((z*32+y)*32+x)*4;data[index]=x<16?0:240;data[index+1]=y<16?16:128;data[index+2]=z<16?32:64;data[index+3]=255;
    }
    const mips=createPlanetSkyNoiseMipmaps(data);expect(mips.map(mip=>mip.width)).toEqual([32,16,8,4,2,1]);
    expect(mips[1].data[0]).toBe(0);expect(mips[1].data[15*4]).toBe(240);expect(Array.from(mips[5].data)).toEqual([120,72,48,255]);
    expect(mips.reduce((sum,mip)=>sum+mip.data.length,0)).toBe(149796);expect(mips[0].data).not.toBe(data);
    expect(()=>createPlanetSkyNoiseMipmaps(new Uint8Array(8))).toThrow(/32 cubed/);
  });
});
