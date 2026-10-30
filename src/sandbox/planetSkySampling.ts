import type {PlanetAtmosphereRenderColumn} from '../shared/planetAtmosphereSnapshot.ts';

/** Numeric reference and GLSL for bounded, feature-aware cloud quadrature.
 * Distances supplied to the partition helper are metres; shader distances are
 * divided by planet radius. Their logarithmic metric is identical. */
export interface PlanetCloudRaySegment {fromMetres:number;toMetres:number;featureMetres:number}
export interface PlanetCloudRayPartition extends PlanetCloudRaySegment {edgesMetres:number[]}
export interface PlanetSkyDepthCandidate {terminalDepth:number;distanceSquared:number}
export interface PlanetCloudRenderedColumn extends PlanetAtmosphereRenderColumn {lowerProfileTopMetersAsl:number;upperProfileTopMetersAsl:number}
export interface PlanetCloudProfileContext {
  noise:{size:number;data:Uint8Array};radiusMeters:number;shapeScaleMeters:number;timeSeconds:number;windMetersPerSecond:readonly [number,number,number];
}
export function planetCloudProfileTopFraction(broad:number,detail:number,iceFraction:number):number {
  if(![broad,detail,iceFraction].every(Number.isFinite))throw Error('Cloud profile noise and phase must be finite.');
  const clamp=(value:number)=>Math.max(0,Math.min(1,value)),ice=clamp(iceFraction),weight=.28+.52*ice,t=clamp(((1-weight)*clamp(broad)+weight*clamp(detail)-.2)/.6),minimum=.58+.22*ice;
  return minimum+(1-minimum)*(t*t*(3-2*t))**.65;
}
/** Renderer subgrid support inside the diagnosed physical envelope. The same
 * advected, camera-independent field is used by view, solar and source rays.
 * Normalizing the profile by this effective thickness preserves column mass. */
export function samplePlanetCloudProfile(column:PlanetAtmosphereRenderColumn,context:PlanetCloudProfileContext):PlanetCloudRenderedColumn {
  const {noise,radiusMeters:radius,shapeScaleMeters:shape,timeSeconds:time,windMetersPerSecond:wind}=context;
  if(!Number.isInteger(noise.size)||noise.size<2||noise.size>128||noise.data.length!==noise.size**3*4||![radius,shape,time,...wind].every(Number.isFinite)||radius<=0||shape<=0||time<0)throw Error('Cloud profile needs a bounded periodic noise volume and physical frame.');
  const fract=(value:number)=>value-Math.floor(value),e=(time/86400%(1/12))*12*Math.PI*2,phases=[e,-e,e],scale=shape*32*2;
  const read=(uv:readonly number[],channel:number)=>{
    const point=uv.map(value=>fract(value)*noise.size-.5),base=point.map(Math.floor),fraction=point.map(fract),wrap=(value:number)=>(value%noise.size+noise.size)%noise.size;let value=0;
    for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++){const cell=[x,y,z],weight=cell.reduce((product,side,index)=>product*(side?fraction[index]:1-fraction[index]),1),offset=((wrap(base[2]+z)*noise.size+wrap(base[1]+y))*noise.size+wrap(base[0]+x))*4+channel;value+=noise.data[offset]/255*weight;}return value;
  };
  const top=(base:number,ceiling:number,label:readonly number[],liquid:number,ice:number)=>{
    if(ceiling<=base||liquid+ice<=0)return ceiling;
    const metres=label.map(value=>value*(radius+base)),q=metres.map(value=>value/shape*.35),warped=metres.map((value,index)=>value+Math.sin(q[(index+1)%3]+.6*Math.sin(q[(index+2)%3]+phases[index]))*shape*.28),uv=warped.map((value,index)=>value/scale+fract(-wind[index]*time/scale)),detail=uv.map((value,index)=>value*4+[.173,.317,.619][index]);
    return base+(ceiling-base)*planetCloudProfileTopFraction(read(uv,2),read(detail,3),ice/(liquid+ice));
  };
  return{...column,lowerProfileTopMetersAsl:top(column.lowerBaseMetersAsl,column.lowerTopMetersAsl,column.materialLower,column.liquidLowerKgM2,column.iceLowerKgM2),upperProfileTopMetersAsl:top(column.upperBaseMetersAsl,column.upperTopMetersAsl,column.materialUpper,column.liquidUpperKgM2,column.iceUpperKgM2)};
}

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
export interface PlanetCloudScatteringInput {
  transmission:number;columnOpticalDepth:number;observerOpticalDepth?:number;selfShadowSlope?:number;sourceOpticalDepth?:number;
}
/** Bounded reduced-extinction multiple-scattering approximation. Each lobe is
 * normalized over solid angle; the extra diffuse weight draws only from lost
 * direct transmission. It vanishes in clear/thin columns and deep shadows,
 * rather than adding a constant unoccluded ambient/emissive cloud floor. */
export function planetCloudScatteringWeights(input:PlanetCloudScatteringInput):{single:number;multiple:number;reducedTransmission:number} {
  const {transmission:t,columnOpticalDepth:column,observerOpticalDepth:tau=0,selfShadowSlope:slope=0,sourceOpticalDepth:source=0}=input;
  if(![t,column,tau,slope,source].every(Number.isFinite)||t<0||t>1||column<0||tau<0||source<0)throw Error('Cloud scattering requires bounded transmission and nonnegative optical mass.');
  const eta=.25,upper=t**eta;let mean=upper;
  if(tau>0&&t>0&&t<1){const entry=Math.max(0,-Math.log(Math.max(t,1e-35))-slope*source);mean=Math.exp(Math.max(-80,Math.min(0,-eta*entry-eta*slope*tau*planetCloudOpticalSourceFraction(tau,eta*slope))));}
  mean=Math.max(t,Math.min(upper,mean));
  return{single:t,multiple:-Math.expm1(-column)*(mean-t),reducedTransmission:mean};
}
export interface PlanetCloudSlabScatteringInput extends PlanetCloudScatteringInput {phase:number;solarCosine:number;outgoingCosine:number;iceOpticalFraction:number}
/** Hemispheric visible-light escape closure. Conservative two-stream slab
 * reflectance replaces the incorrect 4π phase-budget limit for thick cloud
 * decks. The escape kernel is normalized over the complete viewed column. */
export function planetCloudSlabScatteringResponse(input:PlanetCloudSlabScatteringInput):number {
  const {transmission,columnOpticalDepth:column,phase,solarCosine:muSun,outgoingCosine:muOut,iceOpticalFraction:ice}=input;
  if(![phase,muSun,muOut,ice].every(Number.isFinite)||phase<0||Math.abs(muSun)>1||Math.abs(muOut)>1||ice<0||ice>1)throw Error('Cloud slab needs finite phase, hemisphere cosines and optical ice fraction.');
  const mean=planetCloudScatteringWeights(input).reducedTransmission,p=-Math.expm1(-column),transport=column*(.15+.1*ice),reflection=transport/(1+transport),passing=1/(1+transport);
  let diffuse=0;
  if(muSun*muOut>0&&column>0){const view=column/Math.max(Math.abs(muOut),.001),rate=1+.25*Math.max(0,input.selfShadowSlope??0),normalization=-Math.expm1(-rate*view)/rate;diffuse=p*Math.abs(muSun)*reflection*mean/(Math.PI*Math.max(1e-12,normalization));}
  else{const unscattered=Math.exp(-column/Math.max(Math.abs(muSun),.001));diffuse=p*Math.abs(muSun)*Math.max(0,passing-unscattered)*mean/Math.PI;}
  return(1-p)*phase*transmission+diffuse;
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
vec2 physicalCloudProfileBounds(vec2 bounds,vec3 label,float iceFraction,float footprintMetres) {
  if(bounds.y<=bounds.x)return bounds;
  vec3 metres=cloudMorph(label*(uRadius+bounds.x));
  vec3 uv=metres/(uNoiseShapeScale*32.0*2.0)+uReliefWindUV;
  float broadLod=clamp(log2(max(1.0,footprintMetres/(uNoiseShapeScale*2.0))),0.0,5.0),detailLod=clamp(log2(max(1.0,footprintMetres/(uNoiseShapeScale*0.5))),0.0,5.0);
  float broad=textureLod(uNoiseTexture,uv,broadLod).b,detail=textureLod(uNoiseTexture,uv*4.0+vec3(0.173,0.317,0.619),detailLod).a;
  float ice=clamp(iceFraction,0.0,1.0),signal=pow(smoothstep(0.2,0.8,mix(broad,detail,0.28+0.52*ice)),0.65),minimum=0.58+0.22*ice;
  return vec2(bounds.x,mix(bounds.x,bounds.y,minimum+(1.0-minimum)*signal));
}

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
float cloudReducedVisibility(float transmission,float observerOptical,float slope,float sourceOptical) {
  const float eta=0.25;
  float upper=pow(clamp(transmission,0.0,1.0),eta),mean=upper;
  if(observerOptical>0.0&&transmission>0.0&&transmission<1.0){
    float entry=max(0.0,-log(max(transmission,1e-35))-slope*sourceOptical);
    float fraction=cloudOpticalSourceFraction(observerOptical,eta*slope);
    mean=exp(clamp(-eta*entry-eta*slope*observerOptical*fraction,-80.0,0.0));
  }
  return clamp(mean,transmission,upper);
}
float cloudScatteringResponse(float transmission,float phase,float columnOptical,float observerOptical,float slope,float sourceOptical) {
  float mean=cloudReducedVisibility(transmission,observerOptical,slope,sourceOptical);
  return phase*transmission+cloudOneMinusExp(max(0.0,columnOptical))*(mean-transmission)/(4.0*3.141592653589793);
}
float cloudSlabScatteringResponse(float transmission,float phase,float columnOptical,float observerOptical,float slope,float sourceOptical,float muSun,float muOut,float iceFraction) {
  float mean=cloudReducedVisibility(transmission,observerOptical,slope,sourceOptical),activation=cloudOneMinusExp(max(0.0,columnOptical));
  float transport=columnOptical*(0.15+0.1*clamp(iceFraction,0.0,1.0)),reflection=transport/(1.0+transport),passing=1.0/(1.0+transport),diffuse;
  if(muSun*muOut>0.0&&columnOptical>0.0){float view=columnOptical/max(abs(muOut),0.001),rate=1.0+0.25*max(0.0,slope),normalization=cloudOneMinusExp(rate*view)/rate;diffuse=activation*abs(muSun)*reflection*mean/(3.141592653589793*max(1e-12,normalization));}
  else{float unscattered=exp(-columnOptical/max(abs(muSun),0.001));diffuse=activation*abs(muSun)*max(0.0,passing-unscattered)*mean/3.141592653589793;}
  return(1.0-activation)*phase*transmission+diffuse;
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
