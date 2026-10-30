import {afterEach,describe,expect,it,vi} from 'vitest';
import {ACESFilmicToneMapping,Color,PerspectiveCamera,Scene,SRGBColorSpace,Vector4,WebGPUCoordinateSystem,type Data3DTexture,type RenderTarget} from 'three';
import type {WebGPURenderer} from 'three/webgpu';
import {compilePlanetSky,createPlanetSkyRecipe} from '../src/shared/planetSky.ts';
import {PlanetSkyWebGPUView} from '../src/sandbox/planetSkyWebGPU.ts';
import {createPlanetSkyNoiseMipmaps} from '../src/sandbox/planetSkyWebGPUMips.ts';

const radius=6_371_000,bake=compilePlanetSky(createPlanetSkyRecipe(73,radius),radius).bake();
const frame={position:[0,radius+75,0] as const,timeSeconds:10,sunDirection:[1,1,0] as const};
class Renderer {
  initialized=true;coordinateSystem=WebGPUCoordinateSystem;reversedDepthBuffer=false;logarithmicDepthBuffer=true;
  backend={isWebGPUBackend:true,device:{limits:{maxTextureDimension2D:8192,maxTextureDimension3D:2048,maxColorAttachments:8}}};
  xr={isPresenting:false,enabled:true};target:RenderTarget|null=null;output:RenderTarget|null=null;mrt:unknown={host:'authored MRT'};
  viewport=new Vector4(3,5,900,600);scissor=new Vector4(4,6,800,500);scissorTest=true;
  color=new Color('#123456');alpha=1;autoClear=true;toneMapping=ACESFilmicToneMapping;outputColorSpace=SRGBColorSpace;
  calls=0;throwAt=0;info={render:{triangles:900,drawCalls:123}};
  initializedTextures:Data3DTexture[]=[];copies:{source:Data3DTexture;destination:Data3DTexture;depth:number;level:number}[]=[];
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
  initTexture(texture:Data3DTexture){this.initializedTextures.push(texture);}
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
    expect(r.calls).toBe(6);expect(r.initializedTextures).toHaveLength(2);
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
    const view=make(),r=new Renderer();view.setRecipe({...bake.recipe,atmosphere:{...bake.recipe.atmosphere,enabled:false},clouds:{...bake.recipe.clouds,enabled:false}});
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
    const resources=view as unknown as {noise:Data3DTexture;weather:Data3DTexture;sceneTarget:RenderTarget;volumeTarget:RenderTarget;geometry:{dispose():void};volumeMaterial:{dispose():void};pipeline:{dispose():void}};
    expect(resources.noise.image.data).not.toBe(bake.noise.data);expect(resources.weather.image.data).not.toBe(bake.weather.data);
    expect(resources.noise.generateMipmaps).toBe(false);expect(resources.noise.mipmaps).toHaveLength(6);
    const spies=(['noise','weather','sceneTarget','volumeTarget','geometry','volumeMaterial','pipeline'] as const).map(key=>vi.spyOn(resources[key],'dispose'));
    view.dispose();view.dispose();expect(view.inspection().disposed).toBe(true);for(const spy of spies)expect(spy).toHaveBeenCalledTimes(1);
    expect(()=>view.render(asRenderer(r),new Scene(),camera(),frame)).toThrow(/disposed/);
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
