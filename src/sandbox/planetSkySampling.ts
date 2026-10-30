/** Numeric reference and GLSL for bounded, feature-aware cloud quadrature.
 * Distances supplied to the partition helper are metres; shader distances are
 * divided by planet radius. Their logarithmic metric is identical. */
export interface PlanetCloudRaySegment {fromMetres:number;toMetres:number;featureMetres:number}
export interface PlanetCloudRayPartition extends PlanetCloudRaySegment {edgesMetres:number[]}
export interface PlanetSkyDepthCandidate {terminalDepth:number;distanceSquared:number}

/** Unit-column physical cloud profile. Heights are local diagnosed base/top,
 * not a planet-wide authored shell; translating or stretching that geometry
 * preserves its optical column after dividing by the local thickness. */
export function planetPhysicalCloudProfile(fraction:number,upper=false):number {
  if(!Number.isFinite(fraction))throw Error('Cloud profile requires a finite altitude fraction.');
  if(fraction<=0||fraction>=1)return 0;
  const smooth=(a:number,b:number)=>{const t=Math.max(0,Math.min(1,(fraction-a)/(b-a)));return t*t*(3-2*t);};
  return smooth(0,upper?.18:.08)*(1-smooth(upper?.65:.55,1))/.735;
}

export interface PlanetPhysicalCloudRayBin {
  radiusMeters:number;origin:readonly [number,number,number];direction:readonly [number,number,number];
  fromMetres:number;toMetres:number;baseMetersAsl:number;topMetersAsl:number;surfaceMetersAsl:number;upper?:boolean;columnOpticalDepth:number;
}
/** Effective source point for exponential self-shadow, integrated with the
 * observer's Beer-Lambert weight. The b=1 thick limit is ln(2), not the mean
 * observer optical depth of one; that distinction prevents partition bands. */
export function planetCloudOpticalSourceFraction(tau:number,slope:number):number {
  if(!Number.isFinite(tau)||tau<0||!Number.isFinite(slope))throw Error('Cloud source requires finite optical depth and self-shadow slope.');
  if(tau===0)return .5;
  if(tau<.01&&Math.abs((1+slope)*tau)<.01)return Math.max(0,Math.min(1,.5-(2+slope)*tau/24));
  const denominator=-Math.expm1(-tau);
  if(Math.abs(slope)<.001){const mean=tau<.01?tau*(.5-tau/12):1-tau*Math.exp(-tau)/denominator;return Math.max(0,Math.min(1,mean/tau));}
  const rate=1+slope,exponent=rate*tau;
  const logIntegral=Math.abs(exponent)<.01?Math.log(tau)-exponent*.5+exponent*exponent/24:
    rate>0?Math.log(-Math.expm1(-exponent))-Math.log(rate):-exponent+Math.log(-Math.expm1(exponent))-Math.log(-rate);
  return Math.max(0,Math.min(1,-(logIntegral-Math.log(denominator))/(slope*tau)));
}
/** Frozen-column finite-volume reference for physical transport. Intersect
 * local diagnosed geometry before sampling: a thin cloud cannot disappear
 * between two samples of a much broader global acceleration envelope. The
 * four-node quadrature splits at tangency and the profile's two spline knees.
 * Horizontal variation and filtered microstructure remain the renderer's
 * bounded per-bin approximation; this helper tests the radial optical law. */
export function integratePlanetPhysicalCloudBin(input:PlanetPhysicalCloudRayBin):{opticalDepth:number;centroidMetres:number;entryMetres:number;exitMetres:number} {
  const {radiusMeters:radius,origin,fromMetres:from,toMetres:to,baseMetersAsl:base,topMetersAsl:top,surfaceMetersAsl:surface,columnOpticalDepth:optical}=input;
  if(![radius,...origin,...input.direction,from,to,base,top,surface,optical].every(Number.isFinite)||radius<=0||from<0||to<=from||base<0||top<=base||surface<0||optical<0)throw Error('Physical cloud ray bin requires finite positive geometry and optical mass.');
  const norm=Math.hypot(...input.direction);if(norm<1e-12)throw Error('Physical cloud ray direction must be nonzero.');
  const direction=input.direction.map(value=>value/norm),along=origin.reduce((sum,value,index)=>sum+value*direction[index],0),turn=-along;
  const cross=[origin[1]*direction[2]-origin[2]*direction[1],origin[2]*direction[0]-origin[0]*direction[2],origin[0]*direction[1]-origin[1]*direction[0]],impactSquared=cross.reduce((sum,value)=>sum+value*value,0);
  const sphere=(altitude:number)=>{const square=(radius+altitude)**2-impactSquared;if(square<0)return [1,-1];const extent=Math.sqrt(square);return[-along-extent,-along+extent];};
  const altitude=(distance:number)=>Math.hypot(...origin.map((value,index)=>value+direction[index]*distance))-radius;
  if(surface>=top||optical===0)return{opticalDepth:0,centroidMetres:0,entryMetres:0,exitMetres:0};
  const partitions=[from,...(turn>from&&turn<to?[turn]:[]),to],outer=sphere(top),inner=sphere(Math.max(base,surface)),nodes=[.06943184420297371,.33000947820757187,.6699905217924281,.9305681557970262],weights=[.1739274225687269,.3260725774312731,.3260725774312731,.1739274225687269];
  let profileLength=0,centroid=0,entry=Infinity,exit=0;
  for(let part=0;part<partitions.length-1;part++){
    const start=partitions[part],finish=partitions[part+1],outward=(start+finish)*.5>turn;
    let a=Math.max(start,outer[0]),b=Math.min(finish,outer[1]);
    if(inner[1]>inner[0]){if(outward)a=Math.max(a,inner[1]);else b=Math.min(b,inner[0]);}if(outer[1]<=outer[0]||b<=a)continue;
    entry=Math.min(entry,a);exit=Math.max(exit,b);
    const cuts=[a,b];for(const fraction of [input.upper?.18:.08,input.upper?.65:.55]){const crossing=sphere(base+(top-base)*fraction),point=crossing[outward?1:0];if(crossing[1]>crossing[0]&&point>a&&point<b)cuts.push(point);}cuts.sort((x,y)=>x-y);
    for(let interval=0;interval<cuts.length-1;interval++)for(let node=0;node<4;node++){
      const length=cuts[interval+1]-cuts[interval],point=cuts[interval]+length*nodes[node],contribution=length*weights[node]*planetPhysicalCloudProfile((altitude(point)-base)/(top-base),input.upper);
      profileLength+=contribution;centroid+=point*contribution;
    }
  }
  return{opticalDepth:optical*profileLength/(top-base),centroidMetres:profileLength>0?centroid/profileLength:0,entryMetres:Number.isFinite(entry)?entry:0,exitMetres:exit};
}

export function planetPhysicalCloudSourceDistance(input:PlanetPhysicalCloudRayBin,fraction:number):number {
  if(!Number.isFinite(fraction)||fraction<0||fraction>1)throw Error('Cloud source optical fraction must be bounded.');
  const full=integratePlanetPhysicalCloudBin(input);if(full.opticalDepth<=0)return(input.fromMetres+input.toMetres)*.5;
  let lo=full.entryMetres,hi=full.exitMetres;
  const norm=Math.hypot(...input.direction),direction=input.direction.map(value=>value/norm),thickness=input.topMetersAsl-input.baseMetersAsl,target=full.opticalDepth*fraction;
  const derivative=(point:number)=>input.columnOpticalDepth*planetPhysicalCloudProfile((Math.hypot(...input.origin.map((value,index)=>value+direction[index]*point))-input.radiusMeters-input.baseMetersAsl)/thickness,input.upper)/thickness;
  const entryDerivative=derivative(lo);
  let point=entryDerivative>1e-8?Math.max(lo,Math.min(hi,lo+target/entryDerivative)):lo+(hi-lo)*Math.cbrt(fraction);
  for(let iteration=0;iteration<10;iteration++){
    const amount=point>full.entryMetres?integratePlanetPhysicalCloudBin({...input,fromMetres:full.entryMetres,toMetres:point}).opticalDepth:0,error=target-amount;
    if(Math.abs(error)<=Math.max(1e-12,target*1e-5))break;
    if(error>0)lo=point;else hi=point;
    const next=point+error/Math.max(1e-12,derivative(point));point=next>lo&&next<hi?next:(lo+hi)*.5;
  }
  return point;
}

/** Numeric reference for the reconstruction fallback. Negative terminal depth
 * means empty sky. An opaque pixel can only borrow shorter, finite transport;
 * pure sky prefers complete sky paths over foreground-truncated neighbours. */
export function conservativePlanetSkySampleWeights(actualDepth:number,candidates:readonly PlanetSkyDepthCandidate[]):number[] {
  if(!Number.isFinite(actualDepth)||candidates.length>9||candidates.some(candidate=>!Number.isFinite(candidate.terminalDepth)||!Number.isFinite(candidate.distanceSquared)||candidate.distanceSquared<0))throw Error('Sky reconstruction requires bounded finite local depth samples.');
  const sky=actualDepth<0,skyOnly=sky&&candidates.some(candidate=>candidate.terminalDepth<0);
  const weights=candidates.map(candidate=>{
    const empty=candidate.terminalDepth<0;
    if(skyOnly&&!empty||!sky&&(empty||candidate.terminalDepth>actualDepth))return 0;
    return 1/(.25+candidate.distanceSquared);
  }),total=weights.reduce((sum,value)=>sum+value,0);
  return total>0?weights.map(value=>value/total):weights;
}

const log1p=(value:number)=>value<.01?value*(1+value*(-.5+value/3)):Math.log(1+value);
const expm1=(value:number)=>value<.01?value*(1+value*(.5+value/6)):Math.exp(value)-1;
const metric=(from:number,to:number,feature:number)=>log1p(Math.max(0,to-from)/(Math.max(0,from)+feature));

export function planetCloudFeatureMetres(shapeMetres:number,thicknessMetres:number,radiusMetres:number,cirrus=false):number {
  if(![shapeMetres,thicknessMetres,radiusMetres].every(value=>Number.isFinite(value)&&value>0))throw Error('Cloud quadrature requires positive finite feature dimensions.');
  const shape=cirrus?Math.min(shapeMetres*.22,thicknessMetres/4):shapeMetres;
  return Math.max(radiusMetres/6_371_000,Math.min(shape*.25,thicknessMetres*.125));
}

/** One sample minimum per crossed interval; the remaining budget follows the
 * observer-distance metric. The total is max(interval count, budget), <=32.
 * This does not promise to resolve every far puff along an unbounded horizon. */
export function partitionPlanetCloudRay(segments:readonly PlanetCloudRaySegment[],budget:number):PlanetCloudRayPartition[] {
  if(!Number.isInteger(budget)||budget<1||budget>32||segments.length>6)throw Error('Cloud quadrature supports at most six intervals and a 1..32 sample budget.');
  let previous=-1;
  for(const segment of segments){
    if(![segment.fromMetres,segment.toMetres,segment.featureMetres].every(Number.isFinite)||segment.fromMetres<0||segment.fromMetres<previous||segment.toMetres<=segment.fromMetres||segment.featureMetres<=0)throw Error('Cloud quadrature intervals must be finite, positive and ordered without overlap.');
    previous=segment.toMetres;
  }
  const measures=segments.map(segment=>metric(segment.fromMetres,segment.toMetres,segment.featureMetres)),total=measures.reduce((sum,value)=>sum+value,0),extra=Math.max(0,budget-segments.length);
  let prefix=0;
  return segments.map((segment,index)=>{
    const measure=measures[index],before=prefix;prefix+=measure;
    const count=1+Math.floor(extra*Math.min(1,prefix/Math.max(1e-30,total)))-Math.floor(extra*Math.min(1,before/Math.max(1e-30,total)));
    const edgesMetres=Array.from({length:count+1},(_,step)=>step===0?segment.fromMetres:step===count?segment.toMetres:
      Math.max(segment.fromMetres,Math.min(segment.toMetres,segment.fromMetres+(segment.fromMetres+segment.featureMetres)*expm1(measure*step/count))));
    return {...segment,edgesMetres};
  });
}

/** Included verbatim by the WebGL volume shader. Native transport mirrors this
 * small contract; numeric regression tests exercise the same metric/partition. */
export const planetSkyQuadratureGLSL=/* glsl */`
float cloudOneMinusExp(float value) {
  return value<0.01?value*(1.0+value*(-0.5+value/6.0)):1.0-exp(-value);
}
float cloudOpticalSourceFraction(float tau,float slope) {
  if(tau<=0.0)return 0.5;
  if(tau<0.01&&abs((1.0+slope)*tau)<0.01)return clamp(0.5-(2.0+slope)*tau/24.0,0.0,1.0);
  if(abs(slope)<0.001){float mean=tau<0.01?tau*(0.5-tau/12.0):1.0-tau*exp(-tau)/cloudOneMinusExp(tau);return clamp(mean/tau,0.0,1.0);}
  float rate=1.0+slope,exponent=rate*tau,logIntegral;
  if(abs(exponent)<0.01)logIntegral=log(tau)-exponent*0.5+exponent*exponent/24.0;
  else if(rate>0.0)logIntegral=log(cloudOneMinusExp(exponent))-log(rate);
  else logIntegral=-exponent+log(cloudOneMinusExp(-exponent))-log(-rate);
  return clamp(-(logIntegral-log(cloudOneMinusExp(tau)))/(slope*tau),0.0,1.0);
}

float physicalCloudProfile(float fraction,bool upper) {
  if(fraction<=0.0||fraction>=1.0)return 0.0;
  return (upper?smoothstep(0.0,0.18,fraction)*(1.0-smoothstep(0.65,1.0,fraction)):smoothstep(0.0,0.08,fraction)*(1.0-smoothstep(0.55,1.0,fraction)))/0.735;
}

float cloudFeatureMetres(int layer) {
  float thickness=uCloudLayers[layer].y*uRadius;
  bool cirrus=layer==2;
#ifdef PLANET_SKY_SIMULATION
  cirrus=layer==1;
#endif
  float shape=cirrus?min(uNoiseShapeScale*0.22,thickness/4.0):uNoiseShapeScale;
  return max(uRadius/6371000.0,min(shape*0.25,thickness*0.125));
}

float cloudLog1p(float value) {
  return value<0.01?value*(1.0+value*(-0.5+value/3.0)):log(1.0+value);
}

float cloudExpm1(float value) {
  return value<0.01?value*(1.0+value*(0.5+value/6.0)):exp(value)-1.0;
}

float cloudRayMetric(float from,float to,float featureMetres) {
  return cloudLog1p(max(0.0,to-from)/(max(0.0,from)+featureMetres/uRadius));
}

float cloudRayEdge(float from,float to,float metric,float featureMetres,float fraction) {
  if(fraction<=0.0)return from;
  if(fraction>=1.0)return to;
  return clamp(from+(from+featureMetres/uRadius)*cloudExpm1(metric*fraction),from,to);
}

float cloudWorldPhase(vec3 midpoint,float featureMetres) {
  // The field is fixed in world space, independent of screen/frame/camera.
  return 0.2+0.6*textureLod(uNoiseTexture,midpoint*uRadius/(featureMetres*32.0),0.0).a;
}

int apportionedSteps(float before,float after,float total,int intervals,int budget) {
  int extra=max(0,budget-intervals);
  int start=int(floor(float(extra)*clamp(before/max(1e-30,total),0.0,1.0)));
  int end=int(floor(float(extra)*clamp(after/max(1e-30,total),0.0,1.0)));
  return 1+end-start;
}
`;
