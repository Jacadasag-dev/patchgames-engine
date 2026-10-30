import {Box3,BufferAttribute,BufferGeometry,ClampToEdgeWrapping,Color,Data3DTexture,DepthTexture,HalfFloatType,LinearFilter,LinearMipmapLinearFilter,Matrix4,Mesh,NearestFilter,NoBlending,NoColorSpace,NoToneMapping,OrthographicCamera,PerspectiveCamera,RedFormat,RepeatWrapping,RGBAFormat,Scene,UnsignedIntType,Vector3,Vector4,WebGPUCoordinateSystem} from 'three';
import {NodeMaterial,RenderPipeline,RenderTarget,type ArrayNode,type Node,type WebGPURenderer} from 'three/webgpu';
import {element,outputStruct,positionLocal,renderOutput,sampler,texture,texture3D,uniform,uv,vec4,wgslFn} from 'three/tsl';
import {compilePlanetSky,type CompiledPlanetSky,type PlanetSkyBake,type PlanetSkyRecipe} from '../shared/planetSky.ts';
import type {PlanetVector} from '../shared/planet.ts';
import type {PlanetSkyDiagnostic,PlanetSkyFrame} from './planetSkyView.ts';
import {createPlanetSkyNoiseMipmaps} from './planetSkyWebGPUMips.ts';
import {planetSkyWebGPUCompositeWGSL,planetSkyWebGPUPaletteWGSL,planetSkyWebGPUVolumeWGSL} from './planetSkyWebGPUShader.ts';

const diagnosticModes:readonly PlanetSkyDiagnostic[]=['composite','scene','radiance','transmittance','depth-rejection','unweighted','nearest'];
const vector=(v:PlanetVector)=>Array.isArray(v)&&v.length===3&&v.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=1e9);
const fract=(n:number)=>n-Math.floor(n);
function createUniforms(){return{
  projectionInverse:uniform(new Matrix4()),cameraRotation:uniform(new Matrix4()),cameraRadius:uniform(new Vector3()),
  sunDirection:uniform(new Vector3()),rayleigh:uniform(new Vector3()),shapeWind:uniform(new Vector3()),detailWind:uniform(new Vector3()),
  geometry:uniform(new Vector4()),atmosphere:uniform(new Vector4()),lighting:uniform(new Vector4()),clouds:uniform(new Vector4()),
  details:uniform(new Vector4()),steps:uniform(new Vector4()),dimensions:uniform(new Vector4()),style:uniform(new Vector4()),
};}
type NativeBackend={isWebGPUBackend?:boolean;device?:{limits:{maxTextureDimension2D:number;maxTextureDimension3D:number;maxColorAttachments:number}}};

/** Strict native WebGPU counterpart of PlanetSkyView. Await renderer.init()
 * before rendering. A failed WebGPU adapter is reported instead of silently
 * changing backends. Captured geometry already shares the host's local origin. */
export class PlanetSkyWebGPUView {
  private compiled:CompiledPlanetSky;
  private readonly noise:Data3DTexture;
  private readonly weather:Data3DTexture;
  private readonly noiseMips;
  private readonly geometry=new BufferGeometry();
  private readonly volumeScene=new Scene();
  private readonly screenCamera=new OrthographicCamera(-1,1,1,-1,0,1);
  private readonly volumeMaterial=new NodeMaterial();
  private readonly sceneTarget:RenderTarget;
  private readonly volumeTarget:RenderTarget;
  private readonly uniforms=createUniforms();
  private readonly compositeNode;
  private readonly viewport=new Vector4();
  private readonly scissor=new Vector4();
  private readonly clearColor=new Color();
  private readonly color=new Color();
  private pipeline?:RenderPipeline;
  private renderer?:WebGPURenderer;
  private uploaded=false;
  private disposed=false;
  private width=0;private height=0;private lowWidth=0;private lowHeight=0;
  private frames=0;private sceneTriangles=0;private sceneDrawCalls=0;private renderCpuMs=0;

  constructor(bake:PlanetSkyBake){
    this.compiled=compilePlanetSky(bake.recipe,bake.radiusMeters);
    if(bake.bakeKey!==this.compiled.bakeKey||bake.revision!==this.compiled.revision||bake.noise?.size!==32||bake.weather?.size!==32
      ||!(bake.noise.data instanceof Uint8Array)||bake.noise.data.length!==32**3*4||!(bake.weather.data instanceof Uint8Array)||bake.weather.data.length!==32**3)throw Error('Planet sky bake does not match its validated recipe or bounded volumes.');
    this.noiseMips=createPlanetSkyNoiseMipmaps(bake.noise.data);
    this.noise=new Data3DTexture(this.noiseMips[0].data,32,32,32);
    this.weather=new Data3DTexture(new Uint8Array(bake.weather.data),32,32,32);
    for(const data of [this.noise,this.weather]){
      data.format=data===this.noise?RGBAFormat:RedFormat;data.minFilter=data.magFilter=LinearFilter;
      data.wrapS=data.wrapT=data.wrapR=data===this.noise?RepeatWrapping:ClampToEdgeWrapping;
      data.generateMipmaps=false;data.unpackAlignment=1;data.colorSpace=NoColorSpace;data.needsUpdate=true;
    }
    this.noise.minFilter=LinearMipmapLinearFilter;
    // Declare storage for all six levels. Native Three uploads the base Data3D
    // image; uploadNoise fills the other levels through public texture copies.
    this.noise.mipmaps=this.noiseMips;
    this.noise.name='Planet sky filtered 3D shape/detail noise';this.weather.name='Planet sky 3D weather field';
    this.sceneTarget=new RenderTarget(1,1,{type:HalfFloatType,format:RGBAFormat,minFilter:LinearFilter,magFilter:LinearFilter,depthBuffer:true,stencilBuffer:false,depthTexture:new DepthTexture(1,1,UnsignedIntType)});
    this.volumeTarget=new RenderTarget(1,1,{count:2,type:HalfFloatType,format:RGBAFormat,minFilter:NearestFilter,magFilter:NearestFilter,depthBuffer:false,stencilBuffer:false});
    this.sceneTarget.texture.name='Planet sky linear scene';this.volumeTarget.textures[0].name='Planet sky radiance';this.volumeTarget.textures[1].name='Planet sky RGB transmission and view depth';
    const noise=texture3D(this.noise),weather=texture3D(this.weather),sceneDepth=texture(this.sceneTarget.depthTexture!);
    const integration=(wgslFn(planetSkyWebGPUVolumeWGSL)({uvIn:uv(),sceneDepth,noise,noiseSampler:sampler(noise),weather,weatherSampler:sampler(weather),...this.uniforms}) as Node<'mat4'>).toVar('planetSkyTransport');
    // @types/three currently types element() for arrays only, while native TSL
    // and WGSL also support matrix-column indexing. The stored value is a mat4.
    const columns=integration as unknown as ArrayNode<'vec4'>;
    this.volumeMaterial.fragmentNode=outputStruct(element(columns,0),element(columns,1));
    this.volumeMaterial.vertexNode=vec4(positionLocal.xy,0,1);
    this.volumeMaterial.depthTest=false;this.volumeMaterial.depthWrite=false;this.volumeMaterial.blending=NoBlending;this.volumeMaterial.toneMapped=false;this.volumeMaterial.fog=false;
    this.geometry.setAttribute('position',new BufferAttribute(new Float32Array([-1,-1,0,3,-1,0,-1,3,0]),3));
    // Native render-target textures and the screen triangle use top-left UVs.
    this.geometry.setAttribute('uv',new BufferAttribute(new Float32Array([0,1,2,1,0,-1]),2));
    const mesh=new Mesh(this.geometry,this.volumeMaterial);mesh.frustumCulled=false;this.volumeScene.add(mesh);
    const sceneColor=texture(this.sceneTarget.texture),radianceTexture=texture(this.volumeTarget.textures[0]),transmissionTexture=texture(this.volumeTarget.textures[1]);
    const composite=wgslFn(planetSkyWebGPUCompositeWGSL)({uvIn:uv(),sceneColor,sceneSampler:sampler(sceneColor),sceneDepth,radianceTexture,transmissionTexture,geometry:this.uniforms.geometry,dimensions:this.uniforms.dimensions,style:this.uniforms.style});
    this.compositeNode=wgslFn(planetSkyWebGPUPaletteWGSL)({color:renderOutput(composite),style:this.uniforms.style});
    this.applyRecipe();
  }
  private applyRecipe():void{
    const {recipe:r,radiusMeters:radius,quality:q}=this.compiled,a=r.atmosphere,c=r.clouds,u=this.uniforms,scale=radius/6_371_000;
    this.color.set(a.rayleighColor);u.rayleigh.value.set(this.color.r,this.color.g,this.color.b).multiplyScalar(33.1e-6*a.rayleighStrength/scale);
    u.atmosphere.value.set(a.heightMeters/radius,a.rayleighScaleHeightMeters,a.mieScaleHeightMeters,21e-6*a.mieStrength/scale);
    u.lighting.value.set(a.mieAnisotropy,a.sunIntensity,0,c.enabled?1:0);
    u.clouds.value.set(c.bottomMeters/radius,c.thicknessMeters/radius,c.coverage,c.density);
    u.details.value.set(c.erosion,c.shapeScaleMeters,c.detailScaleMeters,a.enabled?1:0);
    u.steps.value.set(q.atmosphereSteps,q.atmosphereLightSteps,q.cloudSteps,q.cloudLightSteps);
    const diagnostic=u.style.value.w;u.style.value.set(r.style==='pixel'?1:0,r.pixelSize,r.paletteSteps,diagnostic);
  }
  setRecipe(recipe:PlanetSkyRecipe):void{
    if(this.disposed)throw Error('Planet sky view is disposed.');
    const next=compilePlanetSky(recipe,this.compiled.radiusMeters);
    if(next.bakeKey!==this.compiled.bakeKey)throw Error('Planet sky seed or weather changed; prepare a replacement volume in the worker first.');
    this.compiled=next;this.applyRecipe();
  }
  setDiagnostic(mode:PlanetSkyDiagnostic):void{
    const index=diagnosticModes.indexOf(mode);if(index<0||this.disposed)throw Error('Planet sky diagnostic mode is invalid or the view is disposed.');this.uniforms.style.value.w=index;
  }
  private resize(width:number,height:number):void{
    const q=this.compiled.quality,r=this.compiled.recipe;
    if(width!==this.width||height!==this.height){this.sceneTarget.setSize(width,height);this.width=width;this.height=height;}
    const scale=Math.min(r.style==='pixel'?1/r.pixelSize:q.resolutionScale,Math.sqrt(q.maxPixels/(width*height)));
    const w=Math.max(1,Math.floor(width*scale)),h=Math.max(1,Math.floor(height*scale));
    if(w!==this.lowWidth||h!==this.lowHeight){this.volumeTarget.setSize(w,h);this.lowWidth=w;this.lowHeight=h;}
    this.uniforms.dimensions.value.set(width,height,w,h);
  }
  private uploadNoise(renderer:WebGPURenderer):void{
    if(this.uploaded)return;
    renderer.initTexture(this.noise);renderer.initTexture(this.weather);
    for(let level=1;level<this.noiseMips.length;level++){
      const mip=this.noiseMips[level],source=new Data3DTexture(mip.data,mip.width,mip.height,mip.depth);
      source.format=RGBAFormat;source.colorSpace=NoColorSpace;source.unpackAlignment=1;source.needsUpdate=true;
      try{
        const region=new Box3(new Vector3(),new Vector3(mip.width,mip.height,mip.depth));
        renderer.copyTextureToTexture(source,this.noise,region,null,0,level);
      }finally{source.dispose();}
    }
    this.uploaded=true;
  }
  render(renderer:WebGPURenderer,scene:Scene,camera:PerspectiveCamera,frame:PlanetSkyFrame):void{
    if(this.disposed)throw Error('Planet sky view is disposed.');
    if(!(camera instanceof PerspectiveCamera)||(camera as PerspectiveCamera&{isArrayCamera?:boolean}).isArrayCamera)throw Error('Planet sky requires one perspective camera.');
    if(!Number.isFinite(camera.near)||!Number.isFinite(camera.far)||camera.near<=0||camera.far<=camera.near)throw Error('Planet sky perspective clip planes must be finite with 0 < near < far.');
    if(!vector(frame.position)||!vector(frame.sunDirection)||Math.hypot(...frame.sunDirection)<1e-12||!Number.isFinite(frame.timeSeconds)||Math.abs(frame.timeSeconds)>1e9)throw Error('Planet sky requires finite absolute camera/sun coordinates and explicit bounded time.');
    const backend=renderer.backend as unknown as NativeBackend;
    if(!renderer.initialized||backend?.isWebGPUBackend!==true||!backend.device||renderer.coordinateSystem!==WebGPUCoordinateSystem)throw Error('Planet sky requires an initialized native WebGPU renderer; WebGL fallback is unsupported. Await renderer.init() first.');
    if(renderer.reversedDepthBuffer||renderer.xr?.isPresenting)throw Error('Planet sky requires conventional or native logarithmic depth outside XR.');
    if(renderer.getClearAlpha()!==1&&!(scene.background instanceof Color))throw Error('Planet sky requires an opaque scene clear/background.');
    if(renderer.getRenderTarget()!==null||renderer.getOutputRenderTarget()!==null)throw Error('Planet sky composes into a canvas viewport; nested render-target output requires a host adapter.');
    if(this.renderer&&this.renderer!==renderer)throw Error('Planet sky GPU resources belong to one renderer; create a separate view for another renderer.');
    const limits=backend.device.limits;
    if(limits.maxColorAttachments<2||limits.maxTextureDimension3D<32)throw Error('Planet sky WebGPU requires two HDR color attachments and 32 cubed 3D textures.');
    const r=this.compiled.recipe;
    if(!r.atmosphere.enabled&&!r.clouds.enabled){
      this.renderer=renderer;const start=performance.now(),triangles=renderer.info.render.triangles,drawCalls=renderer.info.render.drawCalls;
      renderer.render(scene,camera);this.sceneTriangles=renderer.info.render.triangles-triangles;this.sceneDrawCalls=renderer.info.render.drawCalls-drawCalls;this.renderCpuMs=performance.now()-start;this.frames++;return;
    }
    renderer.getViewport(this.viewport);renderer.getScissor(this.scissor);
    const pixelRatio=renderer.getPixelRatio(),width=Math.floor(this.viewport.z*pixelRatio),height=Math.floor(this.viewport.w*pixelRatio);
    if(width<1||height<1||width>limits.maxTextureDimension2D||height>limits.maxTextureDimension2D||width*height>8_388_608)throw Error('Planet sky capture viewport exceeds its 8-megapixel or device texture limit.');
    this.renderer=renderer;this.resize(width,height);this.uploadNoise(renderer);
    if(!this.pipeline){this.pipeline=new RenderPipeline(renderer,this.compositeNode);this.pipeline.outputColorTransform=false;}
    const u=this.uniforms,radius=this.compiled.radiusMeters,wind=r.clouds.windMetersPerSecond;
    u.cameraRadius.value.set(...frame.position).multiplyScalar(1/radius);u.sunDirection.value.set(...frame.sunDirection).normalize();
    u.geometry.value.set(radius,camera.near,camera.far,renderer.logarithmicDepthBuffer?1:0);
    for(const [name,scale] of [['shapeWind',r.clouds.shapeScaleMeters],['detailWind',r.clouds.detailScaleMeters]] as const)u[name].value.set(fract(wind[0]*frame.timeSeconds/(scale*32)),fract(wind[1]*frame.timeSeconds/(scale*32)),fract(wind[2]*frame.timeSeconds/(scale*32)));
    const autoClear=renderer.autoClear,scissorTest=renderer.getScissorTest(),toneMapping=renderer.toneMapping,outputColorSpace=renderer.outputColorSpace,xrEnabled=renderer.xr.enabled,mrt=renderer.getMRT(),clearAlpha=renderer.getClearAlpha(),start=performance.now();
    renderer.getClearColor(this.clearColor);
    try{
      renderer.autoClear=false;renderer.setScissorTest(false);renderer.setMRT(null);renderer.toneMapping=NoToneMapping;
      renderer.setRenderTarget(this.sceneTarget);renderer.clear(true,true,true);
      const triangles=renderer.info.render.triangles,drawCalls=renderer.info.render.drawCalls;renderer.render(scene,camera);
      this.sceneTriangles=renderer.info.render.triangles-triangles;this.sceneDrawCalls=renderer.info.render.drawCalls-drawCalls;
      // Native renderer updates the camera's coordinate system during capture.
      // Copy its inverse afterwards, never a legacy WebGL facade projection.
      camera.updateWorldMatrix(true,false);u.projectionInverse.value.copy(camera.projectionMatrixInverse);u.cameraRotation.value.extractRotation(camera.matrixWorld);
      renderer.setRenderTarget(this.volumeTarget);renderer.render(this.volumeScene,this.screenCamera);
      // Native targets own their viewports; the canvas viewport is untouched.
      // Avoid setViewport here, which resets native minDepth/maxDepth values.
      renderer.toneMapping=toneMapping;renderer.setRenderTarget(null);renderer.setScissor(this.scissor);renderer.setScissorTest(scissorTest);this.pipeline.render();
      this.frames++;
    }finally{
      // RenderPipeline also changes color space and XR while it draws. Restore
      // those explicitly because an exception can interrupt its own cleanup.
      renderer.toneMapping=toneMapping;renderer.outputColorSpace=outputColorSpace;renderer.xr.enabled=xrEnabled;renderer.autoClear=autoClear;
      renderer.setRenderTarget(null);renderer.setMRT(mrt);renderer.setScissor(this.scissor);renderer.setScissorTest(scissorTest);renderer.setClearColor(this.clearColor,clearAlpha);this.renderCpuMs=performance.now()-start;
    }
  }
  inspection(){
    return{backend:'webgpu',style:this.compiled.recipe.style,quality:this.compiled.recipe.quality,diagnostic:diagnosticModes[this.uniforms.style.value.w],revision:this.compiled.revision,bakeKey:this.compiled.bakeKey,frames:this.frames,
      atmosphereEnabled:this.compiled.recipe.atmosphere.enabled,cloudsEnabled:this.compiled.recipe.clouds.enabled,
      captureWidth:this.width,captureHeight:this.height,volumeWidth:this.lowWidth,volumeHeight:this.lowHeight,volumePixels:this.lowWidth*this.lowHeight,
      noiseMipLevels:this.noiseMips.length,filteredNoiseBytes:this.noiseMips.reduce((sum,mip)=>sum+mip.data.byteLength,0),
      limits:{...this.compiled.quality},volumeDataBytes:32**3*5,estimatedTargetBytes:this.width*this.height*12+this.lowWidth*this.lowHeight*16,
      byteMetric:'Estimated attachment payload; excludes driver allocation, MSAA, staging and other scene resources',sceneTriangles:this.sceneTriangles,sceneDrawCalls:this.sceneDrawCalls,renderSubmissionCpuMs:this.renderCpuMs,disposed:this.disposed};
  }
  dispose():void{
    if(this.disposed)return;this.disposed=true;this.pipeline?.dispose();this.noise.dispose();this.weather.dispose();this.sceneTarget.dispose();this.volumeTarget.dispose();this.geometry.dispose();this.volumeMaterial.dispose();this.volumeScene.clear();
  }
}
