import {afterEach,describe,expect,it,vi} from 'vitest';
import {ACESFilmicToneMapping,Color,PerspectiveCamera,Scene,Vector4,type WebGLRenderer,type WebGLRenderTarget} from 'three';
import {compilePlanetSky,createPlanetSkyRecipe} from '../src/shared/planetSky.ts';
import {PlanetSkyView} from '../src/sandbox/planetSkyView.ts';

const radius=6_371_000,compiled=compilePlanetSky(createPlanetSkyRecipe(73,radius),radius),bake=compiled.bake();
const frame={position:[0,radius+75,0] as const,timeSeconds:10,sunDirection:[1,1,0] as const};
class Renderer {
  capabilities={isWebGL2:true,reversedDepthBuffer:false,logarithmicDepthBuffer:true,maxTextureSize:8192};
  extensions={has:()=>true};xr={isPresenting:false};
  target:WebGLRenderTarget|null=null;
  viewport=new Vector4(3,5,900,600);current=this.viewport.clone();scissor=new Vector4(4,6,800,500);scissorTest=true;
  color=new Color('#123456');alpha=1;contextAlpha=true;
  autoClear=true;toneMapping=ACESFilmicToneMapping;
  calls=0;throwAt=0;info={render:{triangles:0,calls:0}};
  getRenderTarget(){return this.target;}
  getContextAttributes(){return{alpha:this.contextAlpha};}
  getViewport(v:Vector4){return v.copy(this.viewport);}
  getCurrentViewport(v:Vector4){return v.copy(this.current);}
  getScissor(v:Vector4){return v.copy(this.scissor);}
  getScissorTest(){return this.scissorTest;}
  setScissorTest(v:boolean){this.scissorTest=v;}
  setRenderTarget(v:WebGLRenderTarget|null){this.target=v;this.current.copy(v?.viewport??this.viewport);}
  setViewport(v:Vector4|number,y?:number,w?:number,h?:number){this.viewport=v instanceof Vector4?v.clone():new Vector4(v,y!,w!,h!);this.current.copy(this.viewport);}
  setScissor(v:Vector4){this.scissor.copy(v);}
  getClearColor(v:Color){return v.copy(this.color);}
  getClearAlpha(){return this.alpha;}
  setClearColor(v:Color,alpha:number){this.color.copy(v);this.alpha=alpha;}
  clear(){}
  render(){this.calls++;if(this.calls===this.throwAt)throw Error('render failed');this.info.render={triangles:this.calls===1?512:1,calls:this.calls===1?6:1};}
}
const asRenderer=(r:Renderer)=>r as unknown as WebGLRenderer;
const views:PlanetSkyView[]=[];
const make=()=>{const v=new PlanetSkyView(bake);views.push(v);return v;};
afterEach(()=>{views.forEach(v=>v.dispose());views.length=0;vi.restoreAllMocks();});
describe('planet sky view lifecycle',()=>{
  it('integrates three bounded passes and restores the authored canvas state',()=>{
    const view=make(),r=new Renderer(),before={viewport:r.viewport.clone(),scissor:r.scissor.clone(),color:r.color.clone(),alpha:r.alpha};
    view.render(asRenderer(r),new Scene(),new PerspectiveCamera(60,1,.1,radius*8),frame);
    expect(r.calls).toBe(3);expect(r.target).toBeNull();expect(r.viewport).toEqual(before.viewport);expect(r.scissor).toEqual(before.scissor);
    expect(r.color).toEqual(before.color);expect(r.alpha).toBe(before.alpha);expect(r.autoClear).toBe(true);expect(r.scissorTest).toBe(true);expect(r.toneMapping).toBe(ACESFilmicToneMapping);
    const stats=view.inspection();expect(stats.volumePixels).toBeLessThanOrEqual(stats.limits.maxPixels);expect(stats.sceneTriangles).toBe(512);expect(stats.sceneDrawCalls).toBe(6);
  });
  it.each([1,2,3])('restores renderer state when pass %i throws',pass=>{
    const view=make(),r=new Renderer();r.throwAt=pass;
    const before={viewport:r.viewport.clone(),scissor:r.scissor.clone(),color:r.color.clone(),alpha:r.alpha};
    expect(()=>view.render(asRenderer(r),new Scene(),new PerspectiveCamera(60,1,.1,radius*8),frame)).toThrow('render failed');
    expect(r.target).toBeNull();expect(r.viewport).toEqual(before.viewport);expect(r.scissor).toEqual(before.scissor);expect(r.color).toEqual(before.color);expect(r.alpha).toBe(before.alpha);
    expect(r.autoClear).toBe(true);expect(r.scissorTest).toBe(true);expect(r.toneMapping).toBe(ACESFilmicToneMapping);
  });
  it('switches style and quality without replacing the seeded volume or baking data',()=>{
    const view=make(),r=new Renderer(),camera=new PerspectiveCamera(60,1,.1,radius*8),key=view.inspection().bakeKey;
    view.setRecipe({...bake.recipe,style:'pixel',quality:'low',pixelSize:8});view.render(asRenderer(r),new Scene(),camera,frame);
    expect(view.inspection()).toMatchObject({style:'pixel',quality:'low',bakeKey:key});expect(view.inspection().volumePixels).toBeLessThanOrEqual(65_536);
    view.setRecipe({...bake.recipe,quality:'high'});view.render(asRenderer(r),new Scene(),camera,frame);expect(view.inspection().volumePixels).toBeLessThanOrEqual(360_000);
    const revision=view.inspection().revision;
    expect(()=>view.setRecipe({...bake.recipe,seed:74})).toThrow(/replacement/);expect(view.inspection().revision).toBe(revision);
  });
  it('uses the exact native scene path when both effects are disabled',()=>{
    const view=make(),r=new Renderer();view.setRecipe({...bake.recipe,atmosphere:{...bake.recipe.atmosphere,enabled:false},clouds:{...bake.recipe.clouds,enabled:false}});
    view.render(asRenderer(r),new Scene(),new PerspectiveCamera(),frame);expect(r.calls).toBe(1);expect(view.inspection().captureWidth).toBe(0);
  });
  it('rejects invalid bake data, unsupported backends/targets and invalid camera depth before rendering',()=>{
    expect(()=>new PlanetSkyView({...bake,noise:{size:32,data:new Uint8Array(1)}})).toThrow(/bounded/);
    const view=make(),r=new Renderer(),camera=new PerspectiveCamera();r.capabilities.isWebGL2=false;
    expect(()=>view.render(asRenderer(r),new Scene(),camera,frame)).toThrow(/WebGL2/);r.capabilities.isWebGL2=true;r.alpha=.5;
    expect(()=>view.render(asRenderer(r),new Scene(),camera,frame)).toThrow(/opaque/);r.alpha=1;camera.near=0;
    expect(()=>view.render(asRenderer(r),new Scene(),camera,frame)).toThrow(/clip planes/);camera.near=.1;r.extensions.has=()=>false;
    expect(()=>view.render(asRenderer(r),new Scene(),camera,frame)).toThrow(/EXT_color_buffer_float/);expect(r.calls).toBe(0);
  });
  it('releases owned resources exactly once, including after quality and size changes',()=>{
    const view=make(),r=new Renderer();view.render(asRenderer(r),new Scene(),new PerspectiveCamera(),frame);
    view.setRecipe({...bake.recipe,quality:'high'});r.viewport.z=1200;r.current.copy(r.viewport);view.render(asRenderer(r),new Scene(),new PerspectiveCamera(),frame);
    const resources=view as unknown as {noise:{dispose():void};weather:{dispose():void};sceneTarget:{dispose():void};volumeTarget:{dispose():void};geometry:{dispose():void};volumeMaterial:{dispose():void};compositeMaterial:{dispose():void}};
    const disposals=(['noise','weather','sceneTarget','volumeTarget','geometry','volumeMaterial','compositeMaterial'] as const).map(key=>vi.spyOn(resources[key],'dispose'));
    view.dispose();view.dispose();expect(view.inspection().disposed).toBe(true);for(const dispose of disposals)expect(dispose).toHaveBeenCalledTimes(1);
    expect(()=>view.render(asRenderer(r),new Scene(),new PerspectiveCamera(),frame)).toThrow(/disposed/);
  });
});
