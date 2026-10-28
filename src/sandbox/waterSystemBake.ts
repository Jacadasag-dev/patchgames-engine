/** Host/view-side precomputation. Cosmetic clips deliberately contain no forces. */
import {BufferAttribute,BufferGeometry,DoubleSide,Group,Mesh,MeshPhysicalMaterial,type Texture} from 'three';
import {createWaterSystemState,stepWaterSystem,type WaterSystemManifest,type WaterSystemState} from './waterSystem.ts';
import {buildWaterBodySurface,WaterBodySurfaceWorkspace,type WaterBodyStyle} from './waterBodyView.ts';
import {createWaterEffectRecorder,createWaterEffectPlayback,interpolateWaterEffectSurface,type WaterEffectClip,type WaterEffectSurface} from './waterPlayback.ts';
import type {PhysicsScene} from './physics.ts';
import {WATER_CURRENT_GLSL} from './waterCurrentShader.ts';
import {addLiquidFlowShading} from './liquidFlowShading.ts';
const signatureHash=(value:unknown)=>{const text=JSON.stringify(value);let h=2166136261;for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619);return(h>>>0).toString(16);};

/** Record the actual simulated water body surface. Run offline or in
 * a preparation worker; never call this entire bounded bake inside a game tick.
 * Use finalState as a live start, or clip as inexpensive cosmetic scenery. */
export function bakeWaterSystem({system,state=createWaterSystemState(system),duration,sampleRate=8,maxBytes=64*1024*1024,style={},scene=system.scene,disabledSources=[]}:{
  system:WaterSystemManifest;state?:WaterSystemState;duration:number;sampleRate?:number;maxBytes?:number;style?:WaterBodyStyle;scene?:PhysicsScene;disabledSources?:string[];
}):{clip:WaterEffectClip;finalState:WaterSystemState} {
  if(!Number.isFinite(duration)||duration<1e-5||duration>30||!Number.isInteger(sampleRate)||sampleRate<1||sampleRate>30)throw new Error('Water bake requires 0.00001..30 seconds and 1..30 samples/second');
  const frames=Math.ceil(duration*sampleRate)+1;
  const recorder=createWaterEffectRecorder({mode:'cosmetic',signature:{environment:`${system.revision}:${signatureHash(scene)}`,configuration:`water-system-bake-v1:${system.water.revision}:${signatureHash([style,disabledSources])}`},maxFrames:frames,maxBytes,maxDuration:duration+1e-8});
  const gridWorkspace=new WaterBodySurfaceWorkspace(),meshEpochs=new WeakMap<object,number>();let next=state,nextMeshEpoch=0;
  function capture(){
    const grid=buildWaterBodySurface(system.water,next.water,{color:'#217d96',...style,workspace:gridWorkspace}),positions:number[]=[],normals:number[]=[],colors:number[]=[],keys:number[]=[],flowData:number[]=[];
    const mesh=next.water.boundary?.mesh;let epoch=0;
    if(mesh){let known=meshEpochs.get(mesh);if(known===undefined){known=nextMeshEpoch++;meshEpochs.set(mesh,known);}epoch=known;}
    // Remove unused fixed-capacity triangles. Stable grid vertex keys preserve
    // interpolation even when wet cells appear/disappear during the recording.
    // Boundary contacts/clipped edges retain -1. Interior keys are scoped to
    // the actual immutable mesh identity, so an adaptive topology transition
    // cannot accidentally match recycled region/vertex indices. The bounded
    // mesh has fewer than 2^24 keys; even 4096 epochs stay safe integers.
    for(let v=0;v<grid.positions.length/3;v+=3){
      const a=v*3,b=a+3,c=a+6,ab=[grid.positions[b]-grid.positions[a],grid.positions[b+1]-grid.positions[a+1],grid.positions[b+2]-grid.positions[a+2]],ac=[grid.positions[c]-grid.positions[a],grid.positions[c+1]-grid.positions[a+1],grid.positions[c+2]-grid.positions[a+2]];
      if(Math.hypot(ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0])<1e-12)continue;
      for(let k=v;k<v+3;k++){positions.push(...grid.positions.subarray(k*3,k*3+3));normals.push(...grid.normals.subarray(k*3,k*3+3));colors.push(...grid.colors.subarray(k*4,k*4+4));flowData.push(...grid.flowData!.subarray(k*4,k*4+4));const key=grid.boundary?.vertexKeys[k]??k;keys.push(grid.boundary&&key>=0?epoch*16777216+key:key);}
    }
    const surface:WaterEffectSurface={positions:new Float32Array(positions),normals:new Float32Array(normals),colors:new Float32Array(colors),vertexKeys:new Float64Array(keys),flowData:new Float32Array(flowData),currents:system.water.currents!==false,spacing:Math.min(system.water.cellSizeX,system.water.cellSizeZ)};
    recorder.record({time:next.water.time,surface});
  }
  capture();const start=state.water.time;
  for(let frame=1;frame<frames;frame++){
    // Even intervals include the exact end without a sub-minimum tail tick.
    const target=start+duration*frame/(frames-1);
    const remaining=target-next.water.time,ticks=Math.ceil(remaining/(1/30));
    for(let tick=0;tick<ticks;tick++)next=stepWaterSystem({system,state:next,dt:remaining/ticks,scene,disabledSources}).state;
    capture();
  }
  return{clip:recorder.finish(),finalState:next};
}

/** Cheap recorded presentation. Call update with clip-relative seconds. A clip
 * stops at its end; no automatic seam jump or replayed physical impulses. */
export class BakedWaterSystemView {
  readonly clip:WaterEffectClip;
  readonly root=new Group();readonly material:MeshPhysicalMaterial;
  private readonly mesh:Mesh;private readonly playback:ReturnType<typeof createWaterEffectPlayback>;
  private frame=-1;private last=-Infinity;private buffers?:{positions:Float32Array;normals:Float32Array};
  private readonly clock={value:0};private flowBuffer?:Float32Array;
  constructor(clip:WaterEffectClip,options:{opacity?:number;envMap?:Texture;waveNormalStrength?:number;waveContrast?:number;flowStrength?:number;shoreStrength?:number}={}) {
    this.clip=clip;
    for(const key of ['flowStrength','shoreStrength'] as const)if(options[key]!==undefined&&(!Number.isFinite(options[key])||options[key]!<0||options[key]!>2))throw new Error(`BakedWaterSystemView ${key} must be between 0 and 2`);
    if(clip.mode!=='cosmetic')throw new Error('BakedWaterSystemView expects cosmetic water; use checkpoint playback for interactive worlds');
    this.playback=createWaterEffectPlayback(clip);this.material=new MeshPhysicalMaterial({color:0xffffff,vertexColors:true,transparent:true,opacity:options.opacity??.8,roughness:.16,metalness:0,ior:1.333,clearcoat:.25,clearcoatRoughness:.12,envMapIntensity:.32,side:DoubleSide,...(options.envMap?{envMap:options.envMap}:{}),depthWrite:false});
    // Preserve the live view's lighting response to recorded physical normals.
    // This shader never moves geometry or invents new wave motion during replay.
    this.material.onBeforeCompile=shader=>{
      addLiquidFlowShading(shader,this.clock);
      shader.uniforms.recordedNormalStrength={value:options.waveNormalStrength??3};shader.uniforms.recordedWaveContrast={value:options.waveContrast??.6};
      shader.uniforms.recordedClock=this.clock;shader.uniforms.recordedFlowStrength={value:options.flowStrength??(clip.frames[0]?.surface.currents===false?0:1)};shader.uniforms.recordedShoreStrength={value:options.shoreStrength??1};
      shader.vertexShader='uniform float recordedNormalStrength;\nvarying vec3 recordedWaveNormal;\nattribute vec4 recordedFlow;\nvarying vec4 recordedCurrent;\nvarying vec2 recordedPosition;\nvarying vec3 recordedU;\nvarying vec3 recordedV;\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nrecordedCurrent=recordedFlow;recordedPosition=position.xz;recordedU=normalize((modelViewMatrix*vec4(1.0,0.0,0.0,0.0)).xyz);recordedV=normalize((modelViewMatrix*vec4(0.0,0.0,1.0,0.0)).xyz);');
      shader.vertexShader=shader.vertexShader.replace('#include <beginnormal_vertex>','#include <beginnormal_vertex>\nobjectNormal.xz *= recordedNormalStrength; recordedWaveNormal = objectNormal;');
      shader.fragmentShader=WATER_CURRENT_GLSL+'uniform float recordedWaveContrast;\nvarying vec3 recordedWaveNormal;\nuniform float recordedClock;\nuniform float recordedFlowStrength;\nuniform float recordedShoreStrength;\nvarying vec4 recordedCurrent;\nvarying vec2 recordedPosition;\nvarying vec3 recordedU;\nvarying vec3 recordedV;\n'+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\nvec4 recordedDetail=waterCurrentDetail(recordedPosition,recordedCurrent.xy,recordedCurrent.w,recordedCurrent.z,recordedClock);\ndiffuseColor.rgb=mix(diffuseColor.rgb,vec3(0.85,0.96,0.94),clamp(recordedFlowStrength*recordedDetail.z*0.26+recordedShoreStrength*recordedDetail.w,0.0,0.8));');
      shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>','#include <normal_fragment_maps>\nvec3 recordedOptics=recordedFlowStrength*(recordedU*recordedDetail.x+recordedV*recordedDetail.y);normal=normalize(normal+recordedOptics);');
      shader.fragmentShader=shader.fragmentShader.replace('#include <clearcoat_normal_fragment_maps>','#include <clearcoat_normal_fragment_maps>\n#ifdef USE_CLEARCOAT\nclearcoatNormal=normalize(clearcoatNormal+recordedOptics);\n#endif');
      shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>','vec3 recordedLight = normalize(vec3(-1.0,1.2,-1.0));\nfloat recordedShade = clamp(4.0*(dot(normalize(recordedWaveNormal),recordedLight)-recordedLight.y),-0.7,0.7);\noutgoingLight *= 1.0+recordedWaveContrast*recordedShade*smoothstep(0.25,0.75,recordedWaveNormal.y);\n#include <opaque_fragment>');
    };
    this.material.customProgramCacheKey=()=> 'recorded-water-slope-v4';
    this.mesh=new Mesh(new BufferGeometry(),this.material);this.root.add(this.mesh);
  }
  update(seconds:number):boolean {
    if(!Number.isFinite(seconds)||seconds<0)throw new Error('Invalid baked water playback time');
    // This simple view permits restart by constructing a new view; playback's
    // guard against rewinding authoritative captures stays intact.
    if(seconds<this.last)throw new Error('Recreate baked water view to restart playback');this.last=seconds;
    const sample=this.playback.sample(Math.min(this.clip.endTime,this.clip.startTime+seconds),{signature:this.clip.signature});
    if(sample.kind!=='frame')return false;
    this.clock.value=sample.time;
    if(this.buffers?.positions.length!==sample.surface.positions.length)this.buffers=undefined;
    this.buffers=interpolateWaterEffectSurface(sample,this.buffers);
    const flowCount=sample.surface.positions.length/3*4;if(this.flowBuffer?.length!==flowCount)this.flowBuffer=new Float32Array(flowCount);
    for(let i=0;i<flowCount;i++){const value=sample.surface.flowData?.[i]??0;this.flowBuffer[i]=value+((sample.blend?.toFlowData?.[i]??value)-value)*(sample.blend?.alpha??0);}
    if(this.frame!==sample.frameIndex){const geometry=new BufferGeometry();geometry.setAttribute('position',new BufferAttribute(this.buffers.positions,3));geometry.setAttribute('normal',new BufferAttribute(this.buffers.normals,3));
      if(sample.surface.colors?.length)geometry.setAttribute('color',new BufferAttribute(sample.surface.colors, sample.surface.colors.length/(sample.surface.positions.length/3)));
      geometry.setAttribute('recordedFlow',new BufferAttribute(this.flowBuffer,4));
      if(sample.surface.indices)geometry.setIndex(new BufferAttribute(sample.surface.indices,1));this.mesh.geometry.dispose();this.mesh.geometry=geometry;this.frame=sample.frameIndex;
    }else{this.mesh.geometry.getAttribute('position').needsUpdate=true;this.mesh.geometry.getAttribute('normal').needsUpdate=true;this.mesh.geometry.getAttribute('recordedFlow').needsUpdate=true;}
    this.mesh.geometry.computeBoundingSphere();return seconds<this.clip.endTime-this.clip.startTime;
  }
  dispose():void{this.mesh.geometry.dispose();this.material.dispose();this.root.clear();this.root.removeFromParent();}
}
