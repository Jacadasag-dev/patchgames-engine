import {afterEach,describe,expect,it,vi} from 'vitest';
import {ACESFilmicToneMapping,BufferGeometry,Color,Mesh,MeshStandardMaterial,NoToneMapping,PerspectiveCamera,Scene,Vector4,type WebGLRenderer,type WebGLRenderTarget} from 'three';
import {compilePlanetSky,createPlanetSkyRecipe} from '../src/shared/planetSky.ts';
import {PlanetSkyView} from '../src/sandbox/planetSkyView.ts';

const radius=6_371_000,compiled=compilePlanetSky(createPlanetSkyRecipe(73,radius),radius),bake=compiled.bake();
const frame={position:[0,radius+75,0] as const,timeSeconds:10,sunDirection:[1,1,0] as const};
class Renderer {
  capabilities={isWebGL2:true,reversedDepthBuffer:false,logarithmicDepthBuffer:true,maxTextureSize:8192};
  extensions={has:(_name:string)=>true};xr={isPresenting:false};
  target:WebGLRenderTarget|null=null;
  viewport=new Vector4(3,5,900,600);current=this.viewport.clone();scissor=new Vector4(4,6,800,500);scissorTest=true;
  color=new Color('#123456');alpha=1;contextAlpha=true;
  autoClear=true;toneMapping=ACESFilmicToneMapping;
  calls=0;throwAt=0;info={render:{triangles:0,calls:0}};
  compiles=0;compileHook?:()=>Promise<unknown>;compileStates:{target:WebGLRenderTarget|null;toneMapping:number}[]=[];compileScenes:Scene[]=[];
  compileAsync(scene:Scene){this.compiles++;this.compileScenes.push(scene);this.compileStates.push({target:this.target,toneMapping:this.toneMapping});return this.compileHook?.()??Promise.resolve();}
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
  it('integrates three bounded passes and restores the authored canvas state',async()=>{
    const view=make(),r=new Renderer(),scene=new Scene(),camera=new PerspectiveCamera(60,1,.1,radius*8),before={viewport:r.viewport.clone(),scissor:r.scissor.clone(),color:r.color.clone(),alpha:r.alpha};
    await view.prepare(asRenderer(r),scene,camera);
    view.render(asRenderer(r),scene,camera,frame);
    expect(r.calls).toBe(3);expect(r.target).toBeNull();expect(r.viewport).toEqual(before.viewport);expect(r.scissor).toEqual(before.scissor);
    expect(r.color).toEqual(before.color);expect(r.alpha).toBe(before.alpha);expect(r.autoClear).toBe(true);expect(r.scissorTest).toBe(true);expect(r.toneMapping).toBe(ACESFilmicToneMapping);
    const stats=view.inspection();expect(stats.volumePixels).toBeLessThanOrEqual(stats.limits.maxPixels);expect(stats.sceneTriangles).toBe(512);expect(stats.sceneDrawCalls).toBe(6);
  });
  it.each([1,2,3])('restores renderer state when pass %i throws',async pass=>{
    const view=make(),r=new Renderer(),scene=new Scene(),camera=new PerspectiveCamera(60,1,.1,radius*8);r.throwAt=pass;
    await view.prepare(asRenderer(r),scene,camera);
    const before={viewport:r.viewport.clone(),scissor:r.scissor.clone(),color:r.color.clone(),alpha:r.alpha};
    expect(()=>view.render(asRenderer(r),scene,camera,frame)).toThrow('render failed');
    expect(r.target).toBeNull();expect(r.viewport).toEqual(before.viewport);expect(r.scissor).toEqual(before.scissor);expect(r.color).toEqual(before.color);expect(r.alpha).toBe(before.alpha);
    expect(r.autoClear).toBe(true);expect(r.scissorTest).toBe(true);expect(r.toneMapping).toBe(ACESFilmicToneMapping);
  });
  it('switches style and quality without replacing the seeded volume or baking data',async()=>{
    const view=make(),r=new Renderer(),scene=new Scene(),camera=new PerspectiveCamera(60,1,.1,radius*8),key=view.inspection().bakeKey;
    await view.prepare(asRenderer(r),scene,camera);
    view.setRecipe({...bake.recipe,style:'pixel',quality:'low',pixelSize:8});view.render(asRenderer(r),scene,camera,frame);
    expect(view.inspection()).toMatchObject({style:'pixel',quality:'low',bakeKey:key});expect(view.inspection().volumePixels).toBeLessThanOrEqual(65_536);
    view.setRecipe({...bake.recipe,quality:'high'});view.render(asRenderer(r),scene,camera,frame);expect(view.inspection().volumePixels).toBeLessThanOrEqual(360_000);
    const revision=view.inspection().revision;
    expect(()=>view.setRecipe({...bake.recipe,seed:74})).toThrow(/replacement/);expect(view.inspection().revision).toBe(revision);
  });
  it('uses the exact native scene path when both effects are disabled',()=>{
    const view=make(),r=new Renderer();view.setRecipe({...bake.recipe,atmosphere:{...bake.recipe.atmosphere,enabled:false},clouds:{...bake.recipe.clouds,enabled:false},celestial:{...bake.recipe.celestial,sunEnabled:false,starsEnabled:false}});
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
  it('releases owned resources exactly once, including after quality and size changes',async()=>{
    const view=make(),r=new Renderer(),scene=new Scene(),camera=new PerspectiveCamera();await view.prepare(asRenderer(r),scene,camera);view.render(asRenderer(r),scene,camera,frame);
    view.setRecipe({...bake.recipe,quality:'high'});r.viewport.z=1200;r.current.copy(r.viewport);view.render(asRenderer(r),scene,camera,frame);
    const resources=view as unknown as {noise:{dispose():void};weather:{dispose():void};circulationCoverage:{dispose():void};circulationEnvironment:{dispose():void};sceneTarget:{dispose():void};volumeTarget:{dispose():void};geometry:{dispose():void};volumeMaterial:{dispose():void};compositeMaterial:{dispose():void}};
    const disposals=(['noise','weather','circulationCoverage','circulationEnvironment','sceneTarget','volumeTarget','geometry','volumeMaterial','compositeMaterial'] as const).map(key=>vi.spyOn(resources[key],'dispose'));
    view.dispose();view.dispose();expect(view.inspection().disposed).toBe(true);for(const dispose of disposals)expect(dispose).toHaveBeenCalledTimes(1);
    expect(()=>view.render(asRenderer(r),new Scene(),new PerspectiveCamera(),frame)).toThrow(/disposed/);
  });
  it('keeps celestial sources active without atmosphere and uploads bounded cyclone/layer state',async()=>{
    const view=make(),r=new Renderer(),scene=new Scene(),camera=new PerspectiveCamera(60,1,.1,radius*8);view.setRecipe({...bake.recipe,atmosphere:{...bake.recipe.atmosphere,enabled:false},clouds:{...bake.recipe.clouds,enabled:false}});
    await view.prepare(asRenderer(r),scene,camera);
    view.render(asRenderer(r),scene,camera,{...frame,starRotationRadians:Math.PI,presentationTimeSeconds:10});
    expect(r.calls).toBe(3);const uniforms=(view as unknown as {uniforms:Record<string,{value:any}>}).uniforms;
    expect(uniforms.uSkyClock.value.x).toBe(10);expect(uniforms.uSkyClock.value.y).toBe(Math.PI);expect(uniforms.uStormCenters.value).toHaveLength(16);expect(uniforms.uStormProperties.value).toHaveLength(16);expect(uniforms.uCloudLayers.value).toHaveLength(3);
    expect(uniforms.uStormCount.value).toBeLessThanOrEqual(16);expect(view.inspection().weather.achievedCoverage).toBeGreaterThan(.6);
    expect(()=>view.render(asRenderer(r),new Scene(),new PerspectiveCamera(),{...frame,presentationTimeSeconds:NaN})).toThrow(/bounded time/);
  });
  it('keeps zero target coverage empty and preserves every star seed bit in exact uniform halves',async()=>{
    const seed=0x12345678,recipe=createPlanetSkyRecipe(seed,radius);
    const prepared=compilePlanetSky({...recipe,clouds:{...recipe.clouds,circulation:{...bake.recipe.clouds.circulation,seed,coverageTarget:0}}},radius).bake();
    const view=new PlanetSkyView(prepared),r=new Renderer(),scene=new Scene(),camera=new PerspectiveCamera();views.push(view);await view.prepare(asRenderer(r),scene,camera);view.render(asRenderer(r),scene,camera,frame);
    const uniforms=(view as unknown as {uniforms:Record<string,{value:any}>}).uniforms;
    expect(uniforms.uCoverageGain.value).toBe(0);expect(uniforms.uStormCount.value).toBe(0);
    expect(uniforms.uSkyClock.value.z).toBe(0x1234);expect(uniforms.uSkyClock.value.w).toBe(0x5678);
    expect(()=>new PlanetSkyView({...prepared,circulation:{...prepared.circulation,coverage:{...prepared.circulation.coverage,data:new Uint8Array(1)}}})).toThrow(/bounded/);
  });
  it('starts one asynchronous preparation and keeps drawing raw scene until sky and HDR capture programs are ready',async()=>{
    const view=make(),r=new Renderer(),scene=new Scene(),camera=new PerspectiveCamera(),pending:(()=>void)[]=[];r.compileHook=()=>new Promise<void>(resolve=>pending.push(resolve));
    const before={viewport:r.viewport.clone(),scissor:r.scissor.clone(),toneMapping:r.toneMapping};
    view.render(asRenderer(r),scene,camera,frame);
    const preparing=view.prepare(asRenderer(r),scene,camera);expect(view.prepare(asRenderer(r),scene,camera)).toBe(preparing);
    expect(r.compiles).toBe(2);expect(r.compileStates[0].toneMapping).toBe(NoToneMapping);expect(r.compileStates[0].target?.textures).toHaveLength(2);expect(r.compileStates[1]).toEqual({target:null,toneMapping:before.toneMapping});
    expect(r.target).toBeNull();expect(r.viewport).toEqual(before.viewport);expect(r.scissor).toEqual(before.scissor);expect(r.toneMapping).toBe(before.toneMapping);
    expect(r.calls).toBe(1);expect(view.inspection()).toMatchObject({frames:0,fallbackFrames:1,preparation:{status:'preparing',ready:false,error:''}});
    view.render(asRenderer(r),scene,camera,frame);expect(r.calls).toBe(2);expect(r.compiles).toBe(2);
    pending[0]();await Promise.resolve();expect(view.inspection().preparation.ready).toBe(false);
    pending[1]();await Promise.resolve();await Promise.resolve();expect(r.compiles).toBe(3);expect(view.inspection().preparation).toMatchObject({status:'preparing',phase:'scene-capture'});
    expect(r.compileStates[2].target?.depthTexture).toBeDefined();expect(r.compileStates[2].toneMapping).toBe(NoToneMapping);expect(r.target).toBeNull();expect(r.toneMapping).toBe(before.toneMapping);
    view.render(asRenderer(r),scene,camera,frame);expect(r.calls).toBe(3);expect(r.compiles).toBe(3);
    pending[2]();await preparing;expect(view.inspection().preparation).toMatchObject({status:'ready',ready:true,captureReady:true,error:''});
    r.calls=0;view.render(asRenderer(r),scene,camera,frame);expect(r.calls).toBe(3);expect(view.inspection().frames).toBe(1);
    await expect(view.prepare(asRenderer(new Renderer()))).rejects.toThrow(/one renderer/);
  });
  it('surfaces preparation failure and missing parallel support without retrying or freezing raw scene rendering',async()=>{
    const view=make(),r=new Renderer();r.compileHook=()=>Promise.reject(Error('compiler failed'));
    await expect(view.prepare(asRenderer(r))).rejects.toThrow('compiler failed');expect(view.inspection().preparation).toMatchObject({status:'failed',ready:false,error:'compiler failed'});
    view.render(asRenderer(r),new Scene(),new PerspectiveCamera(),frame);expect(r.calls).toBe(1);expect(r.compiles).toBe(2);expect(view.inspection().fallbackFrames).toBe(1);
    const unsupported=make(),other=new Renderer();other.extensions.has=name=>name!=='KHR_parallel_shader_compile';
    await expect(unsupported.prepare(asRenderer(other))).rejects.toThrow(/KHR_parallel_shader_compile/);expect(other.compiles).toBe(0);
    unsupported.render(asRenderer(other),new Scene(),new PerspectiveCamera(),frame);expect(other.calls).toBe(1);
  });
  it('isolates capture compilation from raw scene material programs and retains the warmed cache references',async()=>{
    const view=make(),r=new Renderer(),scene=new Scene(),camera=new PerspectiveCamera(),source=new MeshStandardMaterial(),geometry=new BufferGeometry();
    source.onBeforeCompile=()=>{};source.customProgramCacheKey=function(){return this.uuid+'-generated-capture-test';};scene.add(new Mesh(geometry,source));scene.background=new Color('#18293a');
    let captured:MeshStandardMaterial|undefined;
    r.compileHook=()=>{if(r.compiles===3)captured=(r.compileScenes[2].children[0] as Mesh).material as MeshStandardMaterial;return Promise.resolve();};
    await view.prepare(asRenderer(r),scene,camera);
    expect(r.compileScenes[2]).not.toBe(scene);expect(captured).toBeDefined();expect(captured).not.toBe(source);expect(captured!.customProgramCacheKey()).toBe(source.customProgramCacheKey());
    expect((scene.children[0] as Mesh).material).toBe(source);expect((scene.children[0] as Mesh).geometry).toBe(geometry);
    const release=vi.spyOn(captured!,'dispose');view.render(asRenderer(r),scene,camera,frame);expect(r.calls).toBe(3);expect(release).not.toHaveBeenCalled();
    view.dispose();expect(release).toHaveBeenCalledTimes(1);source.dispose();geometry.dispose();
  });
  it('releases isolated capture materials when disposed during the third compiler stage',async()=>{
    const view=make(),r=new Renderer(),scene=new Scene(),camera=new PerspectiveCamera(),source=new MeshStandardMaterial(),geometry=new BufferGeometry();scene.add(new Mesh(geometry,source));
    let captured:MeshStandardMaterial|undefined,complete!:()=>void;
    r.compileHook=()=>{if(r.compiles!==3)return Promise.resolve();captured=(r.compileScenes[2].children[0] as Mesh).material as MeshStandardMaterial;return new Promise<void>(resolve=>{complete=resolve;});};
    const preparing=view.prepare(asRenderer(r),scene,camera),rejected=expect(preparing).rejects.toThrow(/disposed/);await Promise.resolve();await Promise.resolve();
    expect(view.inspection().preparation.phase).toBe('scene-capture');const release=vi.spyOn(captured!,'dispose');view.dispose();await rejected;expect(release).toHaveBeenCalledTimes(1);
    complete();await Promise.resolve();await Promise.resolve();expect(view.inspection().preparation.status).toBe('disposed');source.dispose();geometry.dispose();
  });
  it('rejects pending preparation on disposal and ignores late driver completion',async()=>{
    const view=make(),r=new Renderer(),pending:(()=>void)[]=[];r.compileHook=()=>new Promise<void>(resolve=>pending.push(resolve));
    const preparing=view.prepare(asRenderer(r)),rejected=expect(preparing).rejects.toThrow(/disposed/);
    view.dispose();await rejected;pending.forEach(resolve=>resolve());await Promise.resolve();await Promise.resolve();
    expect(view.inspection().preparation).toMatchObject({status:'disposed',ready:false});await expect(view.prepare(asRenderer(r))).rejects.toThrow(/disposed/);
  });
  it('bounds a driver that never completes while keeping the scene fallback available',async()=>{
    vi.useFakeTimers();try{
      const view=make(),r=new Renderer();r.compileHook=()=>new Promise(()=>{});
      const preparing=view.prepare(asRenderer(r)),rejected=expect(preparing).rejects.toThrow(/60 seconds/);
      await vi.advanceTimersByTimeAsync(60_000);await rejected;expect(view.inspection().preparation.status).toBe('failed');
      view.render(asRenderer(r),new Scene(),new PerspectiveCamera(),frame);expect(r.calls).toBe(1);
    }finally{vi.useRealTimers();}
  });
});
