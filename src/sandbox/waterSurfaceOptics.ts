/** Shared optical transfer, independent of surface orientation and physics. */
const SHALLOW_TINT=.5;
export function waterSurfaceTint(depth:number,shallowDepth:number,side=false):number {
  if(side)return .1;const t=Math.max(0,Math.min(1,depth/shallowDepth));return(1-t*t*(3-2*t))*SHALLOW_TINT;
}
export const WATER_SURFACE_OPTICS_GLSL=`
float waterSurfaceTint(float depth,float shallowDepth){return(1.0-smoothstep(0.0,shallowDepth,max(0.0,depth)))*${SHALLOW_TINT.toFixed(1)};}
`;

/** The main water shader's accepted-wave lighting, evaluated from its source
 * normal only. Never apply the horizontal reference to an airborne normal. */
export function waterSurfaceWaveTone(normal:{x:number;y:number;z:number},contrast=.35,normalStrength=1):number {
  const x=normal.x*normalStrength,y=normal.y,z=normal.z*normalStrength,length=Math.hypot(x,y,z);if(!(length>0))return 1;
  const lightLength=Math.hypot(1,1.2,1),lightY=1.2/lightLength,shade=Math.max(-.7,Math.min(.7,4*((-x+1.2*y-z)/(length*lightLength)-lightY))),top=Math.max(0,Math.min(1,(normal.y-.25)/.5));
  return 1+contrast*shade*top*top*(3-2*top);
}

/** Integrates displayed flow distance instead of multiplying an absolute
 * clock by a changing speed. Paused frames and speed-only changes are exact
 * no-ops; accepted rewinds establish a new display epoch. */
export class WaterFlowAdvectionClock {
  private time=NaN;private acceptedTime=NaN;private speed=0;distance=0;
  /** Accepted snapshots may trail the interpolated display clock. Only an
   * actual accepted-state rewind starts a new optical epoch. */
  accept(time:number,speed:number):number {
    if(!Number.isFinite(time)||!Number.isFinite(speed)||speed<0)throw new Error('Invalid water optical flow clock');
    if(Number.isFinite(this.acceptedTime)&&time<this.acceptedTime){this.time=NaN;this.distance=0;}
    this.acceptedTime=time;
    if(Number.isFinite(this.time)&&time<this.time){this.speed=speed;return this.distance;}
    return this.advance(time,speed);
  }
  advance(time:number,speed=this.speed):number {
    if(!Number.isFinite(time)||!Number.isFinite(speed)||speed<0)throw new Error('Invalid water optical flow clock');
    if(Number.isFinite(this.time)&&time<this.time){this.speed=speed;return this.distance;}
    if(!Number.isFinite(this.time)){this.distance=0;}
    else if(time>this.time)this.distance+=(time-this.time)*(this.speed+speed)*.5;
    this.time=time;this.speed=speed;return this.distance;
  }
}
