import {afterEach,describe,expect,it,vi} from 'vitest';
import {ACESFilmicToneMapping,Color,PerspectiveCamera,Scene,SRGBColorSpace,Vector3,Vector4,WebGPUCoordinateSystem,type Data3DTexture,type DataTexture,type RenderTarget} from 'three';
import type {WebGPURenderer} from 'three/webgpu';
import {compilePlanetSky,createPlanetSkyRecipe} from '../src/shared/planetSky.ts';
import {PlanetSkyWebGPUView} from '../src/sandbox/planetSkyWebGPU.ts';
import {createPlanetSkyNoiseMipmaps} from '../src/sandbox/planetSkyWebGPUMips.ts';
import {createPlanetWeatherRecipe} from '../src/shared/planetWeather.ts';

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
  initTexture(texture:Data3DTexture|DataTexture){this.initializedTextures.push(texture);}
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
