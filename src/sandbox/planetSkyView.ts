import {BufferAttribute,BufferGeometry,ClampToEdgeWrapping,Color,Data3DTexture,DataTexture,DepthTexture,GLSL3,HalfFloatType,LinearFilter,LinearMipmapLinearFilter,Matrix3,Matrix4,Mesh,NearestFilter,NoBlending,NoColorSpace,NoToneMapping,PerspectiveCamera,RedFormat,RepeatWrapping,RGBAFormat,Scene,ShaderMaterial,UnsignedIntType,Vector2,Vector3,Vector4,WebGLRenderTarget,type WebGLRenderer} from 'three';
import {compilePlanetSky,type CompiledPlanetSky,type PlanetSkyBake,type PlanetSkyRecipe} from '../shared/planetSky.ts';
import type {PlanetVector} from '../shared/planet.ts';
import {planetSkyCompositeFragmentShader,planetSkyVertexShader,planetSkyVolumeFragmentShader} from './planetSkyShader.ts';

export interface PlanetSkyFrame {position:PlanetVector;timeSeconds:number;sunDirection:PlanetVector;starRotationRadians?:number;presentationTimeSeconds?:number}
export type PlanetSkyDiagnostic='composite'|'scene'|'radiance'|'transmittance'|'depth-rejection'|'unweighted'|'nearest'|'cloud-shadow';
const diagnosticModes:readonly PlanetSkyDiagnostic[]=['composite','scene','radiance','transmittance','depth-rejection','unweighted','nearest','cloud-shadow'];
const vector=(v:PlanetVector)=>Array.isArray(v)&&v.length===3&&v.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=1e9);
const fract=(n:number)=>n-Math.floor(n);
/** WebGL2 HDR volume integration for a planet-centred host scene. The caller's
 * camera and terrain already share a local render origin. This pass owns only
 * derived textures/targets and never modifies terrain, authority or weather IDs. */
export class PlanetSkyView {
  private compiled:CompiledPlanetSky;
  private readonly noise:Data3DTexture;
  private readonly weather:Data3DTexture;
  private readonly circulationCoverage:DataTexture;
  private readonly circulationEnvironment:DataTexture;
  private readonly weatherFacts;
  private readonly geometry=new BufferGeometry();
  private readonly volumeScene=new Scene();
  private readonly compositeScene=new Scene();
  private readonly screenCamera=new PerspectiveCamera();
  private readonly volumeMaterial:ShaderMaterial;
  private readonly compositeMaterial:ShaderMaterial;
  private readonly sceneTarget:WebGLRenderTarget;
  private readonly volumeTarget:WebGLRenderTarget;
  private readonly uniforms:Record<string,{value:any}>;
  private readonly viewport=new Vector4();
  private readonly scissor=new Vector4();
  private readonly actualViewport=new Vector4();
  private readonly cameraRotation=new Matrix3();
  private readonly sun=new Vector3();
  private readonly color=new Color();
  private readonly clearColor=new Color();
  private disposed=false;
  private renderer?:WebGLRenderer;
  private width=0;private height=0;private lowWidth=0;private lowHeight=0;
  private frames=0;private sceneTriangles=0;private sceneDrawCalls=0;
  private renderCpuMs=0;
  constructor(bake:PlanetSkyBake) {
    this.compiled=compilePlanetSky(bake.recipe,bake.radiusMeters);
    if(bake.bakeKey!==this.compiled.bakeKey||bake.revision!==this.compiled.revision||bake.noise?.size!==32||bake.weather?.size!==32
      ||!(bake.noise.data instanceof Uint8Array)||bake.noise.data.length!==32**3*4||!(bake.weather.data instanceof Uint8Array)||bake.weather.data.length!==32**3)throw Error('Planet sky bake does not match its validated recipe or bounded volumes.');
    this.noise=new Data3DTexture(new Uint8Array(bake.noise.data),32,32,32);
    this.weather=new Data3DTexture(new Uint8Array(bake.weather.data),32,32,32);
    for(const texture of [this.noise,this.weather]){texture.format=texture===this.noise?RGBAFormat:RedFormat;texture.minFilter=texture.magFilter=LinearFilter;texture.wrapS=texture.wrapT=texture.wrapR=texture===this.noise?RepeatWrapping:ClampToEdgeWrapping;texture.generateMipmaps=false;texture.unpackAlignment=1;texture.colorSpace=NoColorSpace;texture.needsUpdate=true;}
    this.noise.generateMipmaps=true;this.noise.minFilter=LinearMipmapLinearFilter;
    const circulation=bake.circulation;
    if(!circulation||circulation.revision!==this.compiled.weather.revision||circulation.radiusMeters!==bake.radiusMeters)throw Error('Planet sky circulation bake does not match its validated recipe.');
    for(const data of [circulation.coverage,circulation.environment])if(![128,256,512].includes(data?.width)||data.height!==data.width/2||!(data.data instanceof Uint8Array)||data.data.length!==data.width*data.height*4)throw Error('Planet sky circulation atlas exceeds its bounded data layout.');
    this.circulationCoverage=new DataTexture(new Uint8Array(circulation.coverage.data),circulation.coverage.width,circulation.coverage.height,RGBAFormat);
    this.circulationEnvironment=new DataTexture(new Uint8Array(circulation.environment.data),circulation.environment.width,circulation.environment.height,RGBAFormat);
    for(const texture of [this.circulationCoverage,this.circulationEnvironment]){texture.minFilter=texture.magFilter=LinearFilter;texture.wrapS=RepeatWrapping;texture.wrapT=ClampToEdgeWrapping;texture.generateMipmaps=false;texture.colorSpace=NoColorSpace;texture.unpackAlignment=1;texture.needsUpdate=true;}
    this.weatherFacts={targetCoverage:circulation.targetCoverage,achievedCoverage:circulation.achievedCoverage,coverageGain:circulation.coverageGain,coverageMetric:circulation.metric,atlasWidth:circulation.coverage.width,atlasHeight:circulation.coverage.height,atlasBytes:circulation.coverage.data.byteLength+circulation.environment.data.byteLength};
    this.sceneTarget=new WebGLRenderTarget(1,1,{type:HalfFloatType,format:RGBAFormat,minFilter:LinearFilter,magFilter:LinearFilter,depthBuffer:true,stencilBuffer:false,depthTexture:new DepthTexture(1,1,UnsignedIntType)});
    this.volumeTarget=new WebGLRenderTarget(1,1,{count:2,type:HalfFloatType,format:RGBAFormat,minFilter:NearestFilter,magFilter:NearestFilter,depthBuffer:false,stencilBuffer:false});
    this.uniforms={
      tSceneColor:{value:this.sceneTarget.texture},tSceneDepth:{value:this.sceneTarget.depthTexture},tRadiance:{value:this.volumeTarget.textures[0]},tTransmittance:{value:this.volumeTarget.textures[1]},
      uNoiseTexture:{value:this.noise},uWeatherTexture:{value:this.weather},uProjectionInverse:{value:new Matrix4()},uCameraRotation:{value:this.cameraRotation},
      tCirculationCoverage:{value:this.circulationCoverage},tCirculationEnvironment:{value:this.circulationEnvironment},
      uStormCenters:{value:Array.from({length:16},()=>new Vector4())},uStormProperties:{value:Array.from({length:16},()=>new Vector4())},uStormCount:{value:0},uWeatherTimeDays:{value:0},uCoverageGain:{value:1},uCloudLayers:{value:Array.from({length:3},()=>new Vector4())},
      uCelestial:{value:new Vector4()},uStars:{value:new Vector4()},uSkyClock:{value:new Vector4()},uSkyEffects:{value:new Vector4()},
      uCameraRadius:{value:new Vector3()},uSunDirection:{value:this.sun},uRayleigh:{value:new Vector3()},uShapeWindUV:{value:new Vector3()},uDetailWindUV:{value:new Vector3()},
      uRadius:{value:bake.radiusMeters},uNear:{value:.1},uFar:{value:bake.radiusMeters*8},uLogDepth:{value:0},
      uAtmosphereEnabled:{value:true},uCloudEnabled:{value:true},uAtmosphereHeight:{value:0},uRayleighHeightMeters:{value:0},uMieHeightMeters:{value:0},uMie:{value:0},uMieG:{value:0},uSunIntensity:{value:0},
      uCloudBottom:{value:0},uCloudThickness:{value:0},uCloudCoverage:{value:0},uCloudDensity:{value:0},uCloudErosion:{value:0},uNoiseShapeScale:{value:0},uNoiseDetailScale:{value:0},
      uAtmosphereSteps:{value:12},uLightSteps:{value:3},uCloudSteps:{value:20},uCloudLightSteps:{value:3},
      uOutputSize:{value:new Vector2()},uLowSize:{value:new Vector2()},uPixelSize:{value:4},uPaletteSteps:{value:12},uPixelStyle:{value:false},
      uDiagnostic:{value:0},
    };
    this.geometry.setAttribute('position',new BufferAttribute(new Float32Array([-1,-1,0,3,-1,0,-1,3,0]),3));
    this.geometry.setAttribute('uv',new BufferAttribute(new Float32Array([0,0,2,0,0,2]),2));
    this.volumeMaterial=new ShaderMaterial({glslVersion:GLSL3,vertexShader:planetSkyVertexShader,fragmentShader:planetSkyVolumeFragmentShader,uniforms:this.uniforms,depthTest:false,depthWrite:false,blending:NoBlending,toneMapped:false});
    this.compositeMaterial=new ShaderMaterial({glslVersion:GLSL3,vertexShader:planetSkyVertexShader,fragmentShader:planetSkyCompositeFragmentShader,uniforms:this.uniforms,depthTest:false,depthWrite:false,blending:NoBlending,toneMapped:true});
    for(const [scene,material] of [[this.volumeScene,this.volumeMaterial],[this.compositeScene,this.compositeMaterial]] as const){const mesh=new Mesh(this.geometry,material);mesh.frustumCulled=false;scene.add(mesh);}
    this.applyRecipe();
  }
  private applyRecipe():void {
    const {recipe:r,radiusMeters:radius,quality:q}=this.compiled,a=r.atmosphere,c=r.clouds,u=this.uniforms,scale=radius/6_371_000;
    this.color.set(a.rayleighColor);u.uRayleigh.value.set(this.color.r,this.color.g,this.color.b).multiplyScalar(33.1e-6*a.rayleighStrength/scale);
    for(const [key,value] of Object.entries({uAtmosphereEnabled:a.enabled,uCloudEnabled:c.enabled,uAtmosphereHeight:a.heightMeters/radius,uRayleighHeightMeters:a.rayleighScaleHeightMeters,uMieHeightMeters:a.mieScaleHeightMeters,
      uMie:21e-6*a.mieStrength/scale,uMieG:a.mieAnisotropy,uSunIntensity:a.sunIntensity,uCloudBottom:c.bottomMeters/radius,uCloudThickness:c.thicknessMeters/radius,
      uCloudCoverage:c.coverage,uCloudDensity:c.density,uCloudErosion:c.erosion,uNoiseShapeScale:c.shapeScaleMeters,uNoiseDetailScale:c.detailScaleMeters,
      uAtmosphereSteps:q.atmosphereSteps,uLightSteps:q.atmosphereLightSteps,uCloudSteps:q.cloudSteps,uCloudLightSteps:q.cloudLightSteps,uPixelStyle:r.style==='pixel',uPixelSize:r.pixelSize,uPaletteSteps:r.paletteSteps}))u[key].value=value;
    const celestial=r.celestial;
    u.uCelestial.value.set(celestial.sunEnabled?1:0,celestial.sunAngularRadiusDegrees*Math.PI/180,celestial.sunGlow,0);
    u.uStars.value.set(celestial.starsEnabled?1:0,celestial.starDensity,celestial.starIntensity,celestial.twinkle);
    u.uSkyEffects.value.set(c.shadowStrength,c.godRayStrength,a.heightMeters/radius,0);u.uCoverageGain.value=c.coverage/.67*this.weatherFacts.coverageGain;
    for(const [index,name]of (['fog','cumulus','cirrus'] as const).entries()){const layer=c.layers[name];u.uCloudLayers.value[index].set(layer.bottomMeters/radius,layer.thicknessMeters/radius,layer.density,layer.enabled?1:0);}
  }
  /** Coverage, dimensions, style, palette and quality are live uniform edits.
   * A different seed/weather field requires a new worker bake and replacement. */
  setRecipe(recipe:PlanetSkyRecipe):void {
    if(this.disposed)throw Error('Planet sky view is disposed.');
    const next=compilePlanetSky(recipe,this.compiled.radiusMeters);
    if(next.bakeKey!==this.compiled.bakeKey)throw Error('Planet sky seed or weather changed; prepare a replacement volume in the worker first.');
    this.compiled=next;this.applyRecipe();
  }
  /** Host/lab inspection only. Does not change the persisted weather recipe. */
  setDiagnostic(mode:PlanetSkyDiagnostic):void {
    const index=diagnosticModes.indexOf(mode);if(index<0||this.disposed)throw Error('Planet sky diagnostic mode is invalid or the view is disposed.');this.uniforms.uDiagnostic.value=index;
  }
  private resize(width:number,height:number):void {
    const q=this.compiled.quality,r=this.compiled.recipe;
    if(width!==this.width||height!==this.height){this.sceneTarget.setSize(width,height);this.width=width;this.height=height;}
    let scale=q.resolutionScale;
    if(r.style==='pixel')scale=1/r.pixelSize;
    scale=Math.min(scale,Math.sqrt(q.maxPixels/(width*height)));
    const w=Math.max(1,Math.floor(width*scale)),h=Math.max(1,Math.floor(height*scale));
    if(w!==this.lowWidth||h!==this.lowHeight){this.volumeTarget.setSize(w,h);this.lowWidth=w;this.lowHeight=h;}
    this.uniforms.uOutputSize.value.set(width,height);this.uniforms.uLowSize.value.set(w,h);
  }
  render(renderer:WebGLRenderer,scene:Scene,camera:PerspectiveCamera,frame:PlanetSkyFrame):void {
    if(this.disposed)throw Error('Planet sky view is disposed.');
    if(!(camera instanceof PerspectiveCamera)||(camera as PerspectiveCamera&{isArrayCamera?:boolean}).isArrayCamera)throw Error('Planet sky requires one perspective camera.');
    if(!Number.isFinite(camera.near)||!Number.isFinite(camera.far)||camera.near<=0||camera.far<=camera.near)throw Error('Planet sky perspective clip planes must be finite with 0 < near < far.');
    if(!vector(frame.position)||!vector(frame.sunDirection)||Math.hypot(...frame.sunDirection)<1e-12||!Number.isFinite(frame.timeSeconds)||Math.abs(frame.timeSeconds)>1e9||frame.starRotationRadians!==undefined&&(!Number.isFinite(frame.starRotationRadians)||Math.abs(frame.starRotationRadians)>1e9)||frame.presentationTimeSeconds!==undefined&&(!Number.isFinite(frame.presentationTimeSeconds)||Math.abs(frame.presentationTimeSeconds)>1e9))throw Error('Planet sky requires finite absolute camera/sun coordinates and explicit bounded time.');
    if(!renderer.capabilities?.isWebGL2||renderer.capabilities.reversedDepthBuffer||renderer.xr?.isPresenting)throw Error('Planet sky currently requires a WebGL2 perspective renderer with conventional or logarithmic depth, outside XR.');
    // Three requests an alpha-capable native context even for its default opaque
    // renderer. Qualify the actual clear/background policy, not that context bit.
    if(renderer.getClearAlpha()!==1&&!(scene.background instanceof Color))throw Error('Planet sky currently requires an opaque scene clear/background; transparent host composition needs a separate adapter.');
    if(renderer.getRenderTarget()!==null)throw Error('Planet sky currently composes into a canvas viewport; nested render-target output requires a host adapter.');
    if(this.renderer&&this.renderer!==renderer)throw Error('Planet sky GPU resources belong to one renderer; create a separate view for another renderer.');
    if(!this.renderer){if(!renderer.extensions.has('EXT_color_buffer_float'))throw Error('Planet sky HDR integration requires EXT_color_buffer_float.');this.renderer=renderer;}
    const r=this.compiled.recipe;
    if(!r.atmosphere.enabled&&!r.clouds.enabled&&!r.celestial.sunEnabled&&!r.celestial.starsEnabled){const start=performance.now();renderer.render(scene,camera);this.sceneTriangles=renderer.info.render.triangles;this.sceneDrawCalls=renderer.info.render.calls;this.renderCpuMs=performance.now()-start;this.frames++;return;}
    renderer.getViewport(this.viewport);renderer.getScissor(this.scissor);renderer.getCurrentViewport(this.actualViewport);
    const width=Math.floor(this.actualViewport.z),height=Math.floor(this.actualViewport.w);
    if(width<1||height<1||width>renderer.capabilities.maxTextureSize||height>renderer.capabilities.maxTextureSize||width*height>8_388_608)throw Error('Planet sky capture viewport exceeds its 8-megapixel or device texture limit.');
    this.resize(width,height);
    const u=this.uniforms,radius=this.compiled.radiusMeters,wind=r.clouds.windMetersPerSecond;
    camera.updateWorldMatrix(true,false);u.uProjectionInverse.value.copy(camera.projectionMatrixInverse);this.cameraRotation.setFromMatrix4(camera.matrixWorld);
    u.uCameraRadius.value.set(...frame.position).multiplyScalar(1/radius);this.sun.set(...frame.sunDirection).normalize();u.uNear.value=camera.near;u.uFar.value=camera.far;u.uLogDepth.value=renderer.capabilities.logarithmicDepthBuffer?1:0;
    for(const [name,scale] of [['uShapeWindUV',r.clouds.shapeScaleMeters],['uDetailWindUV',r.clouds.detailScaleMeters]] as const)u[name].value.set(...wind.map(value=>fract(value*frame.timeSeconds/(scale*32))));
    const weatherFrame=this.compiled.weather.frame(frame.timeSeconds);u.uStormCount.value=weatherFrame.cyclones.length;u.uWeatherTimeDays.value=weatherFrame.timeDays*(6_371_000/radius);
    for(let index=0;index<16;index++){const storm=weatherFrame.cyclones[index];if(storm){u.uStormCenters.value[index].set(...storm.center,storm.angularRadius);u.uStormProperties.value[index].set(storm.spin,storm.phase%(Math.PI*2),storm.strength,storm.type==='tropical'?0:1);}else{u.uStormCenters.value[index].set(0,0,0,0);u.uStormProperties.value[index].set(0,0,0,0);}}
    u.uSkyClock.value.set((frame.presentationTimeSeconds??frame.timeSeconds)%4096,(frame.starRotationRadians??0)%(Math.PI*2),(r.seed>>>16)&65535,r.seed&65535);
    const autoClear=renderer.autoClear,scissorTest=renderer.getScissorTest(),toneMapping=renderer.toneMapping,clearColor=renderer.getClearColor(this.clearColor),clearAlpha=renderer.getClearAlpha(),start=performance.now();
    try{
      renderer.autoClear=false;renderer.setScissorTest(false);renderer.toneMapping=NoToneMapping;
      renderer.setRenderTarget(this.sceneTarget);renderer.setViewport(0,0,width,height);renderer.clear(true,true,true);renderer.render(scene,camera);
      this.sceneTriangles=renderer.info.render.triangles;this.sceneDrawCalls=renderer.info.render.calls;
      renderer.setRenderTarget(this.volumeTarget);renderer.setViewport(0,0,this.lowWidth,this.lowHeight);renderer.render(this.volumeScene,this.screenCamera);
      renderer.toneMapping=toneMapping;renderer.setRenderTarget(null);renderer.setViewport(this.viewport);renderer.setScissor(this.scissor);renderer.setScissorTest(scissorTest);renderer.render(this.compositeScene,this.screenCamera);
      this.frames++;
    }finally{
      renderer.toneMapping=toneMapping;renderer.autoClear=autoClear;renderer.setRenderTarget(null);renderer.setViewport(this.viewport);renderer.setScissor(this.scissor);renderer.setScissorTest(scissorTest);renderer.setClearColor(clearColor,clearAlpha);this.renderCpuMs=performance.now()-start;
    }
  }
  inspection(){
    return{backend:'webgl2',style:this.compiled.recipe.style,quality:this.compiled.recipe.quality,diagnostic:diagnosticModes[this.uniforms.uDiagnostic.value],revision:this.compiled.revision,bakeKey:this.compiled.bakeKey,frames:this.frames,
      atmosphereEnabled:this.compiled.recipe.atmosphere.enabled,cloudsEnabled:this.compiled.recipe.clouds.enabled,
      cloudLayers:this.compiled.recipe.clouds.layers,celestial:this.compiled.recipe.celestial,weather:{...this.weatherFacts,cyclones:this.uniforms.uStormCount.value,timeDays:this.uniforms.uWeatherTimeDays.value},
      captureWidth:this.width,captureHeight:this.height,volumeWidth:this.lowWidth,volumeHeight:this.lowHeight,volumePixels:this.lowWidth*this.lowHeight,
      limits:{...this.compiled.quality},volumeDataBytes:32**3*5+this.weatherFacts.atlasBytes,estimatedTargetBytes:this.width*this.height*12+this.lowWidth*this.lowHeight*16,
      byteMetric:'Estimated attachment payload; excludes driver allocation, MSAA, staging and other scene resources',sceneTriangles:this.sceneTriangles,sceneDrawCalls:this.sceneDrawCalls,renderSubmissionCpuMs:this.renderCpuMs,disposed:this.disposed};
  }
  dispose():void {
    if(this.disposed)return;this.disposed=true;this.noise.dispose();this.weather.dispose();this.circulationCoverage.dispose();this.circulationEnvironment.dispose();this.sceneTarget.dispose();this.volumeTarget.dispose();this.geometry.dispose();this.volumeMaterial.dispose();this.compositeMaterial.dispose();this.volumeScene.clear();this.compositeScene.clear();
  }
}
