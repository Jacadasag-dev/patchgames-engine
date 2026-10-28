/** Resolved air-to-water momentum forcing. No water or prescribed surface height. */
import type {WaterBodyManifest,WaterBodyState} from './waterBody.ts';
import type {WaterWind} from './waterSystem.ts';
import {waterBodyCells} from './waterBodyCells.ts';
import {cloneBoundaryState} from './waterBoundary.ts';
export interface ResolvedWaterWind {velocity:{x:number;z:number};gustiness:number;dragCoefficient:number}

export function resolveWaterWind(value:unknown):ResolvedWaterWind|false|undefined {
  if(value===undefined||value===false)return value;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid water wind');
  const v=value as WaterWind;
  if(Object.keys(v).some(key=>!['velocity','gustiness','dragCoefficient'].includes(key))||!v.velocity||typeof v.velocity!=='object'||Array.isArray(v.velocity)
    ||Object.keys(v.velocity).some(key=>key!=='x'&&key!=='z')||!Number.isFinite(v.velocity.x)||!Number.isFinite(v.velocity.z)||Math.hypot(v.velocity.x,v.velocity.z)>60)throw new Error('Invalid water wind velocity');
  const gustiness=v.gustiness??.35,dragCoefficient=v.dragCoefficient??.0013;
  if(!Number.isFinite(gustiness)||gustiness<0||gustiness>1||!Number.isFinite(dragCoefficient)||dragCoefficient<0||dragCoefficient>.01)throw new Error('Invalid water wind stress');
  return{velocity:{x:v.velocity.x,z:v.velocity.z},gustiness,dragCoefficient};
}

/** Bulk stress tau = rho_air Cd |air-water| (air-water). Gusts modulate that
 * external stress, never geometry: pressure/dispersion and conservative fluxes
 * produce the resulting waves. This is a bounded depth-averaged game model,
 * not a spectral ocean/weather or air-obstacle sheltering model.
 *
 * The positive stress multiplier has a spatial mean of one. Its wavelengths
 * are resolved by >=8 cells; simulation time, not render time, advects it.
 * Drag approaches local air velocity without overshooting, even in thin films.
 * Depth and every mass ledger are unchanged. Momentum/energy come from air. */
export function applyWaterWind(w:WaterBodyManifest,s:WaterBodyState,wind:ResolvedWaterWind|false|undefined,dt:number,blocked?:readonly boolean[]):WaterBodyState {
  if(!wind)return s;
  const speed=Math.hypot(wind.velocity.x,wind.velocity.z);
  if(speed===0||wind.dragCoefficient===0)return s;
  const dx=wind.velocity.x/speed,dz=wind.velocity.z/speed;
  const wavelength=Math.max(8*Math.max(w.cellSizeX,w.cellSizeZ),Math.min(12,Math.max(w.columns*w.cellSizeX,w.rows*w.cellSizeZ)*.45));
  const k=2*Math.PI/wavelength,travel=speed*.2*(s.time+dt*.5),airDensity=1.225;
  if(s.boundary){
    const next:WaterBodyState={...s,boundary:cloneBoundaryState(s.boundary),depth:s.depth.slice(),flowX:s.flowX.slice(),flowZ:s.flowZ.slice(),sleeping:s.sleeping.slice(),quietTime:s.quietTime.slice(),...(s.solidDepth?{solidDepth:s.solidDepth.slice()}:{}),revision:s.revision+1};
    const cells=waterBodyCells(w,next);let changed=false;
    for(let i=0;i<cells.count;i++){
      const depth=cells.depth(i);if(depth<=w.wetDepth)continue;
      // The coarse blocked mask can contain a thin wall between two live
      // regions. Each physical region's own bed/volume decides its exposure.
      const {x,z}=cells.center(i),along=x*dx+z*dz,across=-x*dz+z*dx;
      const stress=1+wind.gustiness*(.65*Math.sin(k*(along-travel))+.35*Math.sin(k*(along*.67+across*.31-travel*.83)+1.7));
      const oldX=cells.flowX[i],oldZ=cells.flowZ[i],rx=wind.velocity.x-oldX,rz=wind.velocity.z-oldZ;
      const rate=airDensity*wind.dragCoefficient*stress*Math.hypot(rx,rz)/(w.liquid.restDensity*depth),fraction=rate*dt/(1+rate*dt);
      let vx=oldX+rx*fraction,vz=oldZ+rz*fraction;
      const magnitude=Math.hypot(vx,vz),limit=Math.max(w.maxFlowSpeed,Math.hypot(oldX,oldZ));
      if(magnitude>limit){vx*=limit/magnitude;vz*=limit/magnitude;}
      if(vx===oldX&&vz===oldZ)continue;
      cells.flowX[i]=vx;cells.flowZ[i]=vz;cells.wake(i);changed=true;
    }
    if(!changed)return s;cells.commit();return next;
  }
  let next:WaterBodyState|undefined;
  for(let i=0;i<s.depth.length;i++){
    if(s.depth[i]<=w.wetDepth||blocked?.[i])continue;
    const x=w.origin.x+(Math.floor(i/w.rows)+.5)*w.cellSizeX,z=w.origin.z+(i%w.rows+.5)*w.cellSizeZ;
    const along=x*dx+z*dz,across=-x*dz+z*dx;
    const stress=1+wind.gustiness*(.65*Math.sin(k*(along-travel))+.35*Math.sin(k*(along*.67+across*.31-travel*.83)+1.7));
    const rx=wind.velocity.x-s.flowX[i],rz=wind.velocity.z-s.flowZ[i],relative=Math.hypot(rx,rz);
    // Exact relaxation for the frozen direction/stress prevents a huge thin
    // film acceleration from overshooting wind velocity at finite dt.
    const rate=airDensity*wind.dragCoefficient*stress*relative/(w.liquid.restDensity*s.depth[i]);
    const fraction=rate*dt/(1+rate*dt),limit=Math.max(w.maxFlowSpeed,Math.hypot(s.flowX[i],s.flowZ[i]));
    let vx=s.flowX[i]+rx*fraction,vz=s.flowZ[i]+rz*fraction;
    const magnitude=Math.hypot(vx,vz);if(magnitude>limit){vx*=limit/magnitude;vz*=limit/magnitude;}
    if(vx===s.flowX[i]&&vz===s.flowZ[i])continue;
    next??={...s,flowX:s.flowX.slice(),flowZ:s.flowZ.slice(),sleeping:s.sleeping.slice(),quietTime:s.quietTime.slice(),revision:s.revision+1};
    next.flowX[i]=vx;next.flowZ[i]=vz;next.sleeping[i]=false;next.quietTime[i]=0;
  }
  return next??s;
}
