/** Numeric reference and GLSL for bounded, feature-aware cloud quadrature.
 * Distances supplied to the partition helper are metres; shader distances are
 * divided by planet radius. Their logarithmic metric is identical. */
export interface PlanetCloudRaySegment {fromMetres:number;toMetres:number;featureMetres:number}
export interface PlanetCloudRayPartition extends PlanetCloudRaySegment {edgesMetres:number[]}
export interface PlanetSkyDepthCandidate {terminalDepth:number;distanceSquared:number}

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
float cloudFeatureMetres(int layer) {
  float thickness=uCloudLayers[layer].y*uRadius;
  float shape=layer==2?min(uNoiseShapeScale*0.22,thickness/4.0):uNoiseShapeScale;
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
