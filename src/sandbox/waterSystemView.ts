import {Group} from 'three';
import {WaterBodyView,type WaterBodyViewOptions,type WaterBodySurfaceBuffers} from './waterBodyView.ts';
import {WaterDetailView,type WaterDetailQuality} from './waterDetailView.ts';
import {WaterTerrainEffectsView} from './waterTerrainEffectsView.ts';
import type {WaterDetailEvent} from './waterDetail.ts';
import type {WaterSystemManifest,WaterSystemState} from './waterSystem.ts';
import type {PhysicsScene} from './physics.ts';
export interface WaterSystemViewOptions extends WaterBodyViewOptions {
  /** Spray, mist, foam and bubbles from engine detail events. Cosmetic only;
   * default 'high'. 'off' or false never changes simulated water. */detail?:WaterDetailQuality|false}
export interface WaterSystemViewFrame {
  /** Detail events returned by the steps since the previous presented frame. */detail?:readonly WaterDetailEvent[];
}

/** One view owns the water body surface and its cosmetic spray detail.
 * For large scenes, worker-built buffers can still use the lower-level views. */
export class WaterSystemView {
  readonly system:WaterSystemManifest;
  readonly root=new Group();readonly pool:WaterBodyView;
  /** Cosmetic spray, mist, foam and bubbles; undefined when disabled. */readonly detail?:WaterDetailView;
  readonly terrainEffects?:WaterTerrainEffectsView;
  private detailSeconds=Number.NaN;private acceptedSeconds=Number.NaN;private detailFrame='';
  constructor(system:WaterSystemManifest,options:WaterSystemViewOptions={}) {
    this.system=system;
    const color=options.color??'#217d96';
    this.pool=new WaterBodyView(system.water,{opacity:.8,opticalStrength:.12,waveNormalStrength:3,waveContrast:.6,interpolationSeconds:1/30,...options,color});
    this.pool.material.envMapIntensity=.32;this.pool.material.roughness=.16;this.pool.material.clearcoat=.25;this.pool.material.clearcoatRoughness=.12;
    this.root.add(this.pool.root);
    if(options.detail!==false){this.detail=new WaterDetailView(system.water,{quality:options.detail??'high',color,foamColor:options.foamColor,wind:system.wind?system.wind.velocity:undefined,scene:system.scene});this.terrainEffects=new WaterTerrainEffectsView(system.water,system.scene,{quality:options.detail??'high',color,shallowColor:options.shallowColor,shallowDepth:options.shallowDepth,edgeOpacity:options.edgeOpacity,flowStrength:options.flowStrength,waveContrast:options.waveContrast??.6,waveNormalStrength:options.waveNormalStrength??3,foamColor:options.foamColor,surfaceMaterial:this.pool.material});this.root.add(this.detail.root,this.terrainEffects.root);}
  }
  /** Both cosmetic layers share one quality control, including while paused. */
  setDetailQuality(quality:WaterDetailQuality):void{this.detail?.setQuality(quality);this.terrainEffects?.setQuality(quality);}
  /** A worker-built surface lets connected renderers share exactly one accepted
   * body boundary, including its rounded shoreline and smoothed corners. The
   * scene supplies current native solids for cosmetic collision; the body
   * surface follows the water state's own terrain and barriers. */
  update(state:WaterSystemState,nowMs=performance.now(),scene?:PhysicsScene,surface?:WaterBodySurfaceBuffers,frame:WaterSystemViewFrame={}):void {
    if(surface&&(surface.waterRevision!==state.water.waterRevision||surface.revision!==state.water.revision||Math.abs(surface.time-state.water.time)>1e-9))throw new Error('Water surface must match its accepted simulation frame.');
    if(surface)this.pool.applySurface(surface,nowMs);else this.pool.update(state.water,nowMs);
    const seconds=state.water.time;
    // Advance particles which already existed through the preceding interval,
    // before adding this frame's births. Wall time is only surface interpolation.
    if(seconds<this.acceptedSeconds){this.detail?.reset();this.detailSeconds=seconds;this.detailFrame='';}
    this.advanceDetail(seconds);this.acceptedSeconds=seconds;
    const key=`${state.water.waterRevision}:${state.water.revision}:${seconds}`;
    const events=key===this.detailFrame?[]:frame.detail??[];
    if(events.length)this.detailFrame=key;
    this.detail?.setScene(scene??this.system.scene);this.detail?.ingest(events,state.water,this.pool.acceptedSurface);
    if(this.pool.acceptedSurface)this.terrainEffects?.update(state.water,this.pool.acceptedSurface,scene??this.system.scene,frame.detail??[]);
  }
  /** Call once per rendered frame after update(). seconds is the displayed
   * simulation time; cosmetic detail advances only while it is moving. */
  animate(seconds:number,nowMs=performance.now()):void {
    this.pool.animate(seconds,nowMs);
    this.terrainEffects?.animate(seconds);
    this.advanceDetail(seconds);
  }
  private advanceDetail(seconds:number):void {
    if(!Number.isFinite(seconds))return;
    if(!Number.isFinite(this.detailSeconds)){this.detailSeconds=seconds;return;}
    // Display interpolation can trail an accepted frame. Only an accepted
    // rewind in update() resets the epoch; repeated/lagging displays do nothing.
    if(seconds<=this.detailSeconds)return;
    const elapsed=Math.min(.1,seconds-this.detailSeconds);this.detailSeconds=seconds;
    const counts=this.detail?.counts;
    if(counts&&(counts.spray||counts.mist||counts.bubbles||counts.foam))this.detail!.animate(elapsed);
  }
  dispose():void {this.terrainEffects?.dispose();this.detail?.dispose();this.pool.dispose();this.root.clear();this.root.removeFromParent();}
}
