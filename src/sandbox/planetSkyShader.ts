import {planetWeatherCoverageGLSL} from '../shared/planetWeather.ts';
import {planetSkyQuadratureGLSL} from './planetSkySampling.ts';
import {PLANET_ATMOSPHERE_OPTICS} from '../shared/planetAtmosphereSnapshot.ts';

/** Engine-owned GLSL3 volume integration. Density comes from the same prepared
 * fields as the CPU recipe sampler. Lighting is bounded single scattering with
 * a small ambient cloud fill, not a multiple-scattering weather simulation. */
export const planetSkyVertexShader=/* glsl */`
out vec2 vUv;
void main() {
  vUv=uv;
  gl_Position=vec4(position.xy,0.0,1.0);
}
`;

export const planetSkyVolumeFragmentShader=/* glsl */`
precision highp float;
precision highp sampler3D;
precision highp sampler2D;
in vec2 vUv;
layout(location=0) out vec4 skyRadiance;
layout(location=1) out vec4 skyTransmittance;

uniform sampler2D tSceneDepth;
uniform sampler3D uNoiseTexture;
uniform sampler3D uWeatherTexture;
uniform sampler2D tCirculationCoverage;
uniform sampler2D tCirculationEnvironment;
uniform sampler2D tSnapshotCondensate0;
uniform sampler2D tSnapshotCondensate1;
uniform sampler2D tSnapshotLower0;
uniform sampler2D tSnapshotLower1;
uniform sampler2D tSnapshotUpper0;
uniform sampler2D tSnapshotUpper1;
uniform sampler2D tSnapshotAltitude0;
uniform sampler2D tSnapshotAltitude1;
uniform vec4 uSnapshotParams;
uniform vec4 uStormCenters[16];
uniform vec4 uStormProperties[16];
uniform int uStormCount;
uniform float uWeatherTimeDays;
uniform float uWeatherRotationScale;
uniform float uCondensationThreshold;
uniform float uWeatherEvolutionPhase;
uniform float uCoverageGain;
uniform vec4 uCloudLayers[3];
uniform vec4 uSkyEffects;
uniform mat4 uProjectionInverse;
uniform mat3 uCameraRotation;
uniform vec3 uCameraRadius;
uniform vec3 uSunDirection;
uniform vec3 uRayleigh;
uniform vec3 uShapeWindUV;
uniform vec3 uDetailWindUV;
uniform float uRadius;
uniform float uNear;
uniform float uFar;
uniform float uLogDepth;
uniform float uAtmosphereHeight;
uniform float uRayleighHeightMeters;
uniform float uMieHeightMeters;
uniform float uMie;
uniform float uMieG;
uniform float uSunIntensity;
uniform float uCloudBottom;
uniform float uCloudThickness;
uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform float uCloudErosion;
uniform float uNoiseShapeScale;
uniform float uNoiseDetailScale;
uniform bool uAtmosphereEnabled;
uniform bool uCloudEnabled;
uniform int uAtmosphereSteps;
uniform int uLightSteps;
uniform int uCloudSteps;
uniform int uCloudLightSteps;
uniform vec2 uOutputSize;
uniform vec2 uLowSize;
uniform float uPixelSize;
uniform bool uPixelStyle;

const float PI=3.141592653589793;
const float EMPTY_DEPTH=0.9999999;

vec2 sphereInterval(vec3 origin,vec3 direction,float radius) {
  // Cross-product distance avoids subtracting two large squared distances for
  // an orbital camera. All sphere calculations use planet-radius units.
  float along=dot(origin,direction);
  vec3 perpendicular=cross(origin,direction);
  float square=radius*radius-dot(perpendicular,perpendicular);
  if(square<0.0)return vec2(1.0,-1.0);
  float extent=sqrt(max(0.0,square));
  return vec2(-along-extent,-along+extent);
}

float positiveViewDepth(float depth) {
  if(uLogDepth>0.5)return exp2(depth*log2(uFar+1.0))-1.0;
  return uNear*uFar/max(0.0000001,uFar-depth*(uFar-uNear));
}

#ifndef PLANET_SKY_SIMULATION
${planetWeatherCoverageGLSL}
#endif

#ifdef PLANET_SKY_SIMULATION
vec4 atmospherePlane(sampler2D plane,vec3 direction) {
  ivec2 size=textureSize(plane,0);
  vec2 uv=vec2(atan(direction.x,direction.z)/(2.0*PI)+0.5,asin(clamp(direction.y,-1.0,1.0))/PI+0.5);
  vec2 pixel=uv*vec2(size)-0.5,blend=fract(pixel);ivec2 base=ivec2(floor(pixel));vec4 value=vec4(0.0);
  for(int y=0;y<2;y++)for(int x=0;x<2;x++) {
    ivec2 cell=base+ivec2(x,y);cell.x=((cell.x%size.x)+size.x)%size.x;cell.y=clamp(cell.y,0,size.y-1);
    value+=texelFetch(plane,cell,0)*(x==0?1.0-blend.x:blend.x)*(y==0?1.0-blend.y:blend.y);
  }
  return value;
}
vec3 atmosphereUnit(vec3 label,vec3 fallback) {return dot(label,label)>0.00000001?normalize(label):fallback;}
vec4 atmosphereMass(vec3 position) {
  if(uSnapshotParams.x<0.5||uSnapshotParams.z<0.5)return vec4(0.0);
  vec3 direction=normalize(position);
  return max(vec4(0.0),mix(atmospherePlane(tSnapshotCondensate0,direction),atmospherePlane(tSnapshotCondensate1,direction),uSnapshotParams.y));
}
vec4 atmosphereMaterial(vec3 position,int layer) {
  vec3 direction=normalize(position);vec4 a,b;
  if(layer==1){a=atmospherePlane(tSnapshotUpper0,direction);b=atmospherePlane(tSnapshotUpper1,direction);}
  else{a=atmospherePlane(tSnapshotLower0,direction);b=atmospherePlane(tSnapshotLower1,direction);}
  return vec4(atmosphereUnit(mix(atmosphereUnit(a.xyz,direction),atmosphereUnit(b.xyz,direction),uSnapshotParams.y),direction),mix(a.w,b.w,uSnapshotParams.y));
}
struct AtmosphereCloudColumn {vec4 mass;vec4 lower;vec4 upper;vec4 altitude;};
AtmosphereCloudColumn atmosphereCloudColumn(vec3 position) {
  AtmosphereCloudColumn column;
  column.mass=atmosphereMass(position);column.lower=atmosphereMaterial(position,0);column.upper=atmosphereMaterial(position,1);
  // Spatial and temporal interpolation happen on altitude*condensate mass.
  // A dry neighbour contributes zero moments and cannot drag the cloud base.
  vec4 moments=mix(atmospherePlane(tSnapshotAltitude0,normalize(position)),atmospherePlane(tSnapshotAltitude1,normalize(position)),uSnapshotParams.y);
  float lowerMass=column.mass.x+column.lower.w,upperMass=column.mass.y+column.mass.z;
  column.altitude=vec4(lowerMass>0.0?moments.xy/lowerMass:vec2(0.0),upperMass>0.0?moments.zw/upperMass:vec2(0.0));
  return column;
}
float atmosphereDust(vec3 position) {
  if(!uAtmosphereEnabled||uSnapshotParams.x<0.5||uSnapshotParams.z<0.5)return 0.0;
  float mass=atmosphereMass(position).w;if(mass<=0.0)return 0.0;
  float altitude=max(0.0,(length(position)-1.0)*uRadius),height=max(0.01,uRayleighHeightMeters),top=uAtmosphereHeight*uRadius;
  return mass*${PLANET_ATMOSPHERE_OPTICS.dustExtinctionM2Kg.toFixed(1)}*exp(-altitude/height)/(height*max(0.000001,1.0-exp(-top/height)));
}
#else
float atmosphereDust(vec3 position) {return 0.0;}
PlanetWeatherState cloudWeather(vec3 position) {
  PlanetWeatherState state=planetWeatherState(tCirculationCoverage,tCirculationEnvironment,normalize(position),uSunDirection,uWeatherTimeDays,uStormCenters,uStormProperties,uStormCount,uCoverageGain,uWeatherRotationScale,uCondensationThreshold,uRadius);
  state.coverage=clamp(state.coverage*(textureLod(uWeatherTexture,position/2.2+0.5,0.0).r*2.0),vec3(0.0),vec3(1.0));
  return state;
}
#endif

vec3 cloudMorph(vec3 metres) {
  float evolution=uWeatherEvolutionPhase;
  vec3 q=metres/uNoiseShapeScale*0.35;
  return metres+sin(q.yzx+0.6*sin(q.zxy+vec3(evolution,-evolution,evolution)))*(uNoiseShapeScale*0.28);
}

${planetSkyQuadratureGLSL}

#ifdef PLANET_SKY_SIMULATION
float physicalCloudMicro(vec3 position,float footprintMetres,int layer,AtmosphereCloudColumn column) {
  bool cirrus=layer==1;
  vec2 bounds=cirrus?column.altitude.zw:column.altitude.xy;
  float altitude=(length(position)-1.0)*uRadius,thickness=bounds.y-bounds.x;
  float h=(altitude-bounds.x)/thickness;
  vec3 flow=cirrus?column.upper.xyz:column.lower.xyz;
  vec3 metres=cloudMorph(flow*(length(position)*uRadius));
  float filterScale=cirrus?min(uNoiseShapeScale*0.22,thickness/4.0):uNoiseShapeScale;
  float shapeLod=clamp(log2(max(1.0,footprintMetres/filterScale)),0.0,5.0);
  float detailLod=clamp(log2(max(1.0,footprintMetres/uNoiseDetailScale)),0.0,5.0);
  vec3 shapeUV=metres/(uNoiseShapeScale*32.0)+uShapeWindUV;
  if(cirrus){vec3 direction=normalize(metres);float longitude=atan(direction.x,direction.z)/(2.0*PI)+0.5;float periods=max(1.0,floor(2.0*PI*uRadius/(uNoiseShapeScale*32.0*8.0)+0.5));shapeUV=vec3(longitude*periods,asin(clamp(direction.y,-1.0,1.0))*uRadius/(uNoiseShapeScale*32.0*0.22),h*0.125)+uShapeWindUV;}
  float shape=smoothstep(0.30,0.68,textureLod(uNoiseTexture,shapeUV,shapeLod).r);
  float detail=textureLod(uNoiseTexture,metres/(uNoiseDetailScale*32.0)+uDetailWindUV,detailLod).g;
  float erosion=cirrus?0.12:uCloudErosion;
  return shape*(1.0-erosion*(1.0-detail))/(0.5*(1.0-0.5*erosion));
}
float physicalCloudOptical(int layer,AtmosphereCloudColumn column) {
  return layer==1?column.mass.y*${PLANET_ATMOSPHERE_OPTICS.liquidExtinctionM2Kg.toFixed(1)}+column.mass.z*${PLANET_ATMOSPHERE_OPTICS.iceExtinctionM2Kg.toFixed(2)}:column.mass.x*${PLANET_ATMOSPHERE_OPTICS.liquidExtinctionM2Kg.toFixed(1)}+column.lower.w*${PLANET_ATMOSPHERE_OPTICS.iceExtinctionM2Kg.toFixed(2)};
}
float physicalCloudLayerDensity(vec3 position,float footprintMetres,int layer,AtmosphereCloudColumn column) {
  if(!uCloudEnabled||uSnapshotParams.z<0.5||layer>1)return 0.0;
  vec2 bounds=layer==1?column.altitude.zw:column.altitude.xy;
  float altitude=(length(position)-1.0)*uRadius,thickness=bounds.y-bounds.x;
  if(thickness<=0.0||altitude<=column.upper.w||altitude<=bounds.x||altitude>=bounds.y)return 0.0;
  float columnOptical=physicalCloudOptical(layer,column);if(columnOptical<=0.0)return 0.0;
  float height=physicalCloudProfile((altitude-bounds.x)/thickness,layer==1);
  // Both compact profiles integrate to .735. All diagnosed lower-layer mass
  // lives above its local base: no detached artistic fog share below the LCL.
  return columnOptical*height*physicalCloudMicro(position,footprintMetres,layer,column)/thickness;
}
vec2 physicalCloudOverlap(vec3 origin,vec3 direction,float from,float to,vec2 bounds,float surface) {
  if(bounds.y<=max(bounds.x,surface))return vec2(1.0,-1.0);
  vec2 outer=sphereInterval(origin,direction,1.0+bounds.y/uRadius);
  vec2 overlap=vec2(max(from,outer.x),min(to,outer.y));if(outer.y<=outer.x||overlap.y<=overlap.x)return vec2(1.0,-1.0);
  vec2 inner=sphereInterval(origin,direction,1.0+max(bounds.x,surface)/uRadius);
  // Primary and solar intervals split at closest approach. A monotone bin
  // contains only one side of the shell, even at a grazing/tangent view.
  if(inner.y>inner.x){if((from+to)*0.5<=-dot(origin,direction))overlap.y=min(overlap.y,inner.x);else overlap.x=max(overlap.x,inner.y);}
  return overlap;
}
int physicalCloudProfileCuts(vec3 origin,vec3 direction,vec2 overlap,vec2 bounds,bool upper,out float cuts[4]) {
  // The compact spline has two knees. Integrating each smooth piece keeps
  // column mass independent of where a coarse ray-bin boundary happens to fall.
  cuts[0]=overlap.x;cuts[1]=overlap.y;int count=2;
  bool outward=(overlap.x+overlap.y)*0.5>-dot(origin,direction);
  for(int knee=0;knee<2;knee++){
    float fraction=knee==0?(upper?0.18:0.08):(upper?0.65:0.55);
    vec2 crossing=sphereInterval(origin,direction,1.0+mix(bounds.x,bounds.y,fraction)/uRadius);
    float point=outward?crossing.y:crossing.x;
    if(crossing.y>crossing.x&&point>overlap.x&&point<overlap.y){cuts[count]=point;count++;}
  }
  for(int i=1;i<count;i++){float value=cuts[i];int at=i;for(int j=0;j<i;j++){if(at<=0||cuts[at-1]<=value)break;cuts[at]=cuts[at-1];at--;}cuts[at]=value;}
  return count;
}
vec2 physicalCloudPieceMean(vec3 origin,vec3 direction,vec2 piece,vec2 bounds,bool upper) {
  float sum=0.0,travelCenter=0.0;
  int nodes=clamp(uCloudSteps,1,4);
  for(int node=0;node<nodes;node++) {
    float fraction=node==0?0.06943184420297371:node==1?0.33000947820757187:node==2?0.6699905217924281:0.9305681557970262;
    float weight=node==0||node==3?0.1739274225687269:0.3260725774312731;
    float distanceRay=mix(piece.x,piece.y,fraction);
    float altitude=(length(origin+direction*distanceRay)-1.0)*uRadius;
    float contribution=weight*physicalCloudProfile((altitude-bounds.x)/(bounds.y-bounds.x),upper);
    sum+=contribution;travelCenter+=contribution*distanceRay;
  }
  return vec2(sum,sum>0.0?travelCenter/sum:(piece.x+piece.y)*0.5);
}
vec2 physicalCloudProfileMean(vec3 origin,vec3 direction,vec2 overlap,vec2 bounds,bool upper) {
  float cuts[4];int count=physicalCloudProfileCuts(origin,direction,overlap,bounds,upper,cuts);
  float sum=0.0,travelCenter=0.0;
  for(int part=0;part<count-1;part++){
    vec2 piece=physicalCloudPieceMean(origin,direction,vec2(cuts[part],cuts[part+1]),bounds,upper);
    float amount=piece.x*(cuts[part+1]-cuts[part]);sum+=amount;travelCenter+=amount*piece.y;
  }
  return vec2(sum/(overlap.y-overlap.x),sum>0.0?travelCenter/sum:(overlap.x+overlap.y)*0.5);
}
vec2 physicalCloudBinLayer(vec3 origin,vec3 direction,float from,float to,float footprintMetres,int layer,AtmosphereCloudColumn column) {
  vec2 bounds=layer==1?column.altitude.zw:column.altitude.xy;
  float columnOptical=physicalCloudOptical(layer,column);if(columnOptical<=0.0)return vec2(0.0);
  vec2 overlap=physicalCloudOverlap(origin,direction,from,to,bounds,column.upper.w);if(overlap.y<=overlap.x)return vec2(0.0);
  float lengthMetres=(overlap.y-overlap.x)*uRadius;
  vec2 profile=physicalCloudProfileMean(origin,direction,overlap,bounds,layer==1);
  float centre=profile.y;vec3 point=origin+direction*centre;
  float micro=physicalCloudMicro(point,max(footprintMetres,lengthMetres*0.5),layer,column);
  return vec2(columnOptical*lengthMetres*profile.x*micro/(bounds.y-bounds.x),centre);
}
float physicalCloudSourceDistance(vec3 origin,vec3 direction,float from,float to,int layer,AtmosphereCloudColumn column,float fraction) {
  vec2 bounds=layer==1?column.altitude.zw:column.altitude.xy;
  vec2 overlap=physicalCloudOverlap(origin,direction,from,to,bounds,column.upper.w);
  if(overlap.y<=overlap.x)return (from+to)*0.5;
  float cuts[4];int count=physicalCloudProfileCuts(origin,direction,overlap,bounds,layer==1,cuts);
  float masses[3];float total=0.0;
  for(int part=0;part<count-1;part++){masses[part]=physicalCloudPieceMean(origin,direction,vec2(cuts[part],cuts[part+1]),bounds,layer==1).x*(cuts[part+1]-cuts[part]);total+=masses[part];}
  float target=total*fraction,prefix=0.0;int selected=count-2;
  for(int part=0;part<count-1;part++){if(target<=prefix+masses[part]){selected=part;break;}prefix+=masses[part];}
  target=max(0.0,target-prefix);
  float start=cuts[selected],finish=cuts[selected+1],lo=start,hi=finish;
  if(target<=0.0)return start;if(target>=masses[selected])return finish;
  float entryAltitude=(length(origin+direction*lo)-1.0)*uRadius;
  float entryProfile=physicalCloudProfile((entryAltitude-bounds.x)/(bounds.y-bounds.x),layer==1);
  float point=entryProfile>0.0000001?clamp(lo+target/entryProfile,lo,hi):mix(lo,hi,pow(clamp(target/max(masses[selected],1e-12),0.0,1.0),1.0/3.0));
  // Safeguarded Newton in the same actual radial profile integral. Runtime
  // bounds keep this scalar-only inverse from expanding driver shader code.
  int iterations=clamp(uCloudSteps,8,10);
  for(int iteration=0;iteration<iterations;iteration++){
    float amount=point>start?physicalCloudPieceMean(origin,direction,vec2(start,point),bounds,layer==1).x*(point-start):0.0;
    float error=target-amount;if(abs(error)<=max(1e-12,target*0.00001))break;
    if(error>0.0)lo=point;else hi=point;
    float altitude=(length(origin+direction*point)-1.0)*uRadius;
    float derivative=physicalCloudProfile((altitude-bounds.x)/(bounds.y-bounds.x),layer==1);
    float next=point+error/max(derivative,0.0000001);
    point=next>lo&&next<hi?next:(lo+hi)*0.5;
  }
  return point;
}
float cloudLayerDensity(vec3 position,float footprintMetres,int layer) {
  return physicalCloudLayerDensity(position,footprintMetres,layer,atmosphereCloudColumn(position));
}
#else
float cloudLayerDensity(vec3 position,float footprintMetres,int layer) {
  vec4 settings=uCloudLayers[layer];
  if(!uCloudEnabled||settings.w<0.5||uCloudCoverage<=0.0||uCoverageGain<=0.0||uCloudDensity<=0.0||settings.z<=0.0)return 0.0;
  float h=(length(position)-1.0-settings.x)/settings.y;
  if(h<=0.0||h>=1.0)return 0.0;
  PlanetWeatherState state=cloudWeather(position);
  // No texture mip, erosion feather or lighting approximation may create a
  // cloud outside the common pressure/humidity condensation support.
  if(state.support<=0.0||state.coverage[layer]<=0.0)return 0.0;vec3 coverage=state.coverage,flow=state.flowDirection;
  vec3 metres=cloudMorph(flow*(length(position)*uRadius));
  float filterScale=layer==2?min(uNoiseShapeScale*0.22,settings.y*uRadius/4.0):uNoiseShapeScale;
  float shapeLod=clamp(log2(max(1.0,footprintMetres/filterScale)),0.0,5.0);
  float detailLod=clamp(log2(max(1.0,footprintMetres/uNoiseDetailScale)),0.0,5.0);
  vec3 shapeUV=metres/(uNoiseShapeScale*32.0)+uShapeWindUV;
  if(layer==2) {
    vec3 direction=normalize(metres);float longitude=atan(direction.x,direction.z)/(2.0*PI)+0.5;
    float periods=max(1.0,floor(2.0*PI*uRadius/(uNoiseShapeScale*32.0*8.0)+0.5));
    shapeUV=vec3(longitude*periods,asin(clamp(direction.y,-1.0,1.0))*uRadius/(uNoiseShapeScale*32.0*0.22),h*0.125)+uShapeWindUV;
  }
  vec4 shapeNoise=textureLod(uNoiseTexture,shapeUV,shapeLod);
  float base=shapeNoise.r;
  float detail=textureLod(uNoiseTexture,metres/(uNoiseDetailScale*32.0)+uDetailWindUV,detailLod).g;
  float shape=smoothstep(0.30,0.68,base);
  vec3 column=cloudMorph(flow*((1.0+settings.x)*uRadius));
  float top=layer==1?textureLod(uNoiseTexture,column/(uNoiseShapeScale*32.0)+uShapeWindUV,shapeLod).b:shapeNoise.b;
  float cumulusHeight=h/(0.55+0.45*top);
  float height=layer==0?smoothstep(0.0,0.002,h)*exp(-3.0*h)*(1.0-smoothstep(0.65,1.0,h)):
    layer==1?smoothstep(0.0,0.08,cumulusHeight)*(1.0-smoothstep(0.55,1.0,cumulusHeight)):smoothstep(0.0,0.18,h)*(1.0-smoothstep(0.65,1.0,h));
  float erosion=layer==2?0.12:uCloudErosion;
  return coverage[layer]*max(0.0,(shape*height-erosion*(1.0-detail)*0.35)/(1.0-0.35*erosion))*uCloudDensity*settings.z;
}
#endif

float cloudExtinction(vec3 position,float footprintMetres) {
#ifdef PLANET_SKY_SIMULATION
  if(!uCloudEnabled||uSnapshotParams.z<0.5)return 0.0;
  AtmosphereCloudColumn column=atmosphereCloudColumn(position);
  return physicalCloudLayerDensity(position,footprintMetres,0,column)+physicalCloudLayerDensity(position,footprintMetres,1,column);
#else
  float density=0.0;
  for(int layer=0;layer<3;layer++){float value=cloudLayerDensity(position,footprintMetres,layer);if(value>0.0)density+=value*(layer==0?4.0:layer==1?8.0:2.0)/(uCloudLayers[layer].y*uRadius);}
  return density;
#endif
}
bool cloudsActive() {return uCloudEnabled&&(uSnapshotParams.x>0.5||(uCloudCoverage>0.0&&uCoverageGain>0.0&&uCloudDensity>0.0));}
bool layerActive(vec4 settings) {return settings.w>0.5&&(uSnapshotParams.x>0.5||settings.z>0.0);}

vec2 airDensity(vec3 position) {
  if(!uAtmosphereEnabled)return vec2(0.0);
  float altitude=max(0.0,(length(position)-1.0)*uRadius);
  return exp(-altitude/vec2(uRayleighHeightMeters,uMieHeightMeters));
}

bool planetShadows(vec3 position) {
  vec2 body=sphereInterval(position,uSunDirection,1.0);
  return body.y>0.0000001&&body.x>0.0000001;
}

vec3 sunTransmittance(vec3 position) {
  if(planetShadows(position))return vec3(0.0);
  if(!uAtmosphereEnabled)return vec3(1.0);
  vec2 shell=sphereInterval(position,uSunDirection,1.0+uAtmosphereHeight);
  float lengthRay=max(0.0,shell.y);
  int count=clamp(uLightSteps,1,4);
  float stepRay=lengthRay/float(count);
  vec2 opticalDepth=vec2(0.0);float dustDepth=0.0;
  for(int i=0;i<count;i++) {
    vec3 point=position+uSunDirection*((float(i)+0.5)*stepRay);
    opticalDepth+=airDensity(point)*(stepRay*uRadius);
    dustDepth+=atmosphereDust(point)*(stepRay*uRadius);
  }
  return exp(-min(vec3(80.0),uRayleigh*opticalDepth.x+vec3(uMie*opticalDepth.y+dustDepth)));
}

float cloudSunTransmittance(vec3 position,float observerFootprintMetres) {
  if(!cloudsActive())return 1.0;
  // Direct planetary occlusion is already handled by sunTransmittance. Keep
  // this factor specific to clouds so a clear night cannot darken scene ambient.
  if(planetShadows(position))return 1.0;
  float opticalDepth=0.0;
  int layerCount=3;
#ifdef PLANET_SKY_SIMULATION
  layerCount=int(uSnapshotParams.w);
#endif
  for(int layer=0;layer<layerCount;layer++) {
    vec4 settings=uCloudLayers[layer];if(!layerActive(settings))continue;
    vec2 outer=sphereInterval(position,uSunDirection,1.0+settings.x+settings.y);
    if(outer.y<=max(0.0,outer.x))continue;
    vec2 inner=sphereInterval(position,uSunDirection,1.0+settings.x);
    vec2 segments[2];segments[0]=vec2(max(0.0,outer.x),outer.y);segments[1]=vec2(1.0,-1.0);
    if(inner.y>inner.x&&inner.x<outer.y&&inner.y>segments[0].x) {
      segments[1]=vec2(max(segments[0].x,inner.y),outer.y);segments[0].y=min(outer.y,inner.x);
    }
#ifdef PLANET_SKY_SIMULATION
    else{float turn=-dot(position,uSunDirection);if(turn>segments[0].x&&turn<segments[0].y){segments[1]=vec2(turn,segments[0].y);segments[0].y=turn;}}
#endif
    int partCount=segments[1].y>segments[1].x?2:1;
    for(int part=0;part<partCount;part++) {
      float start=segments[part].x,end=segments[part].y;if(end<=start)continue;
      // A bounded cone average avoids highly aliased sun shafts. At shallow
      // angles the finite cloud-shell segment is sampled, never the empty gap
      // below the cloud. The same extinction drives surfaces and air lighting.
      int count=clamp(uCloudLightSteps,1,4);float feature=cloudFeatureMetres(layer),metric=cloudRayMetric(start,end,feature);
      for(int i=0;i<count;i++) {
        float begin=cloudRayEdge(start,end,metric,feature,float(i)/float(count)),finish=cloudRayEdge(start,end,metric,feature,float(i+1)/float(count));
        float stepRay=finish-begin;
        vec3 middle=position+uSunDirection*((begin+finish)*0.5);
        float phase=cloudWorldPhase(middle,feature);
        vec3 point=position+uSunDirection*mix(begin,finish,phase);
#ifdef PLANET_SKY_SIMULATION
        AtmosphereCloudColumn column=atmosphereCloudColumn(point);
        opticalDepth+=physicalCloudBinLayer(position,uSunDirection,begin,finish,observerFootprintMetres,layer,column).x;
#else
        float density=cloudLayerDensity(point,max(observerFootprintMetres,stepRay*uRadius*0.5),layer);
        opticalDepth+=density*(layer==0?4.0:layer==1?8.0:2.0)*stepRay/settings.y;
#endif
      }
    }
    if(opticalDepth>12.0)break;
  }
  return exp(-min(80.0,opticalDepth));
}

float hgPhase(float cosine,float g) {
  return (1.0-g*g)/(4.0*PI*pow(max(0.001,1.0+g*g-2.0*g*cosine),1.5));
}

#ifdef PLANET_SKY_SIMULATION
void integratePhysicalCloudBin(vec3 origin,vec3 direction,float from,float to,float columnRay,bool cloudSegment,
                               float rayleighPhase,float miePhase,float cloudPhase,inout vec3 radiance,inout vec3 transmission) {
  vec3 columnPoint=origin+direction*columnRay;
  AtmosphereCloudColumn column;
  if(cloudSegment)column=atmosphereCloudColumn(columnPoint);
  else{column.mass=atmosphereMass(columnPoint);column.lower=vec4(normalize(columnPoint),0.0);column.upper=column.lower;column.altitude=vec4(0.0);}
  int layerCount=cloudSegment?int(uSnapshotParams.w):0;
  float cuts[6];cuts[0]=from;cuts[1]=to;int count=2;
  for(int layer=0;layer<layerCount;layer++){
    vec2 bounds=layer==1?column.altitude.zw:column.altitude.xy;
    if(physicalCloudOptical(layer,column)<=0.0)continue;
    vec2 overlap=physicalCloudOverlap(origin,direction,from,to,bounds,column.upper.w);
    if(overlap.y<=overlap.x)continue;
    if(overlap.x>from&&overlap.x<to){cuts[count]=overlap.x;count++;}
    if(overlap.y>from&&overlap.y<to){cuts[count]=overlap.y;count++;}
  }
  for(int i=1;i<count;i++){float value=cuts[i];int at=i;for(int j=0;j<i;j++){if(at<=0)break;if(cuts[at-1]<=value)break;cuts[at]=cuts[at-1];at--;}cuts[at]=value;}
  for(int part=0;part<count-1;part++){
    float begin=cuts[part],end=cuts[part+1];if(end<=begin)continue;
    if(max(transmission.r,max(transmission.g,transmission.b))<0.01)break;
    float distanceRay=(begin+end)*0.5,lengthMetres=(end-begin)*uRadius;
    vec3 point=origin+direction*distanceRay;vec2 air=airDensity(point);vec3 rayleigh=uRayleigh*air.x;float mie=uMie*air.y;
    float footprint=2.0*abs(uProjectionInverse[1][1])*distanceRay*uRadius/max(1.0,uLowSize.y);
    vec2 layerOptical[2];layerOptical[0]=vec2(0.0);layerOptical[1]=vec2(0.0);
    for(int layer=0;layer<layerCount;layer++)layerOptical[layer]=physicalCloudBinLayer(origin,direction,begin,end,footprint,layer,column);
    float cloudOptical=layerOptical[0].x+layerOptical[1].x,cloud=cloudOptical/max(0.000001,lengthMetres);
    float altitude=max(0.0,(length(point)-1.0)*uRadius),dustHeight=max(0.01,uRayleighHeightMeters);
    float dust=uAtmosphereEnabled?column.mass.w*${PLANET_ATMOSPHERE_OPTICS.dustExtinctionM2Kg.toFixed(1)}*exp(-altitude/dustHeight)/(dustHeight*max(0.000001,1.0-exp(-uAtmosphereHeight*uRadius/dustHeight))):0.0;
    vec3 dustAlbedo=vec3(0.90,0.72,0.48),extinction=rayleigh+vec3(mie+cloud+dust);
    vec3 lightPoints[3],lightCoefficients[3];int lightCount=1;
    lightPoints[0]=point;lightCoefficients[0]=rayleigh*rayleighPhase+vec3(mie*miePhase)+dust*dustAlbedo*hgPhase(dot(direction,uSunDirection),0.7);
    float daylight=smoothstep(-0.16,0.2,dot(normalize(point),uSunDirection));vec3 source=dust*dustAlbedo*(uSunIntensity*0.012*daylight);
    float cellOptical=max(0.0000001,(extinction.r+extinction.g+extinction.b)*lengthMetres/3.0);
    for(int layer=0;layer<layerCount;layer++){
      vec2 optical=layerOptical[layer];if(optical.x<=0.0)continue;
      vec3 massPoint=origin+direction*optical.y,radial=normalize(massPoint);
      if(!planetShadows(massPoint)){
        float muSun=dot(radial,uSunDirection);muSun=muSun<0.0?min(-0.0001,muSun):max(0.0001,muSun);
        float slope=-dot(radial,direction)/muSun;
        float fraction=cloudOpticalSourceFraction(cellOptical,slope*optical.x/cellOptical);
        float sourceRay=physicalCloudSourceDistance(origin,direction,begin,end,layer,column,fraction);
        lightPoints[lightCount]=origin+direction*sourceRay;lightCoefficients[lightCount]=vec3(cloudPhase*optical.x/max(0.000001,lengthMetres));lightCount++;
      }
      float cloudDaylight=smoothstep(-0.16,0.2,dot(radial,uSunDirection));
      source+=vec3(0.78,0.87,1.0)*(uSunIntensity*0.035*cloudDaylight)*(optical.x/max(0.000001,lengthMetres));
    }
    // One data-dependent lighting loop gives the driver one shadow callsite,
    // rather than inlining the full atlas/light marcher for every source.
    for(int light=0;light<lightCount;light++){
      float visibility=light>0||cloudOptical>0.0||uSkyEffects.y>0.0?cloudSunTransmittance(lightPoints[light],footprint):1.0;
      if(light==0&&cloudOptical<=0.0)visibility=mix(1.0,visibility,uSkyEffects.y);
      source+=sunTransmittance(lightPoints[light])*visibility*uSunIntensity*lightCoefficients[light];
    }
    vec3 segmentTransmission=exp(-min(vec3(80.0),extinction*lengthMetres));
    radiance+=transmission*source*(vec3(1.0)-segmentTransmission)/max(extinction,vec3(0.000000001));transmission*=segmentTransmission;
  }
}
#endif

void integrateSegment(vec3 origin,vec3 direction,float from,float to,int requested,int cloudLayer,
                      float rayleighPhase,float miePhase,float cloudPhase,inout vec3 radiance,inout vec3 transmission) {
  bool cloudSegment=cloudLayer>=0;
  if(to<=from||(!cloudSegment&&!uAtmosphereEnabled)||max(transmission.r,max(transmission.g,transmission.b))<0.01)return;
  int count=clamp(requested,1,32);
  float feature=cloudSegment?cloudFeatureMetres(cloudLayer):1.0;
  float metric=cloudSegment?cloudRayMetric(from,to,feature):0.0;
  // Runtime-bounded GLSL 3 transport keeps the exact clamped 1..32 budget.
  // Avoid expanding the nested weather and light evaluations at compile time.
  for(int i=0;i<count;i++) {
    if(max(transmission.r,max(transmission.g,transmission.b))<0.01)break;
    float begin=cloudSegment?cloudRayEdge(from,to,metric,feature,float(i)/float(count)):mix(from,to,float(i)/float(count));
    float end=cloudSegment?cloudRayEdge(from,to,metric,feature,float(i+1)/float(count)):mix(from,to,float(i+1)/float(count));
    float stepMetres=(end-begin)*uRadius;
    vec3 middle=origin+direction*((begin+end)*0.5);
    float phase=cloudSegment?cloudWorldPhase(middle,feature):0.5;
    float sampleRay=mix(begin,end,phase);
    vec3 point=origin+direction*sampleRay;
#ifdef PLANET_SKY_SIMULATION
    integratePhysicalCloudBin(origin,direction,begin,end,sampleRay,cloudSegment&&uSnapshotParams.z>0.5,rayleighPhase,miePhase,cloudPhase,radiance,transmission);
#else
    vec2 air=airDensity(point);
    vec3 rayleigh=uRayleigh*air.x;
    float mie=uMie*air.y;
    float distanceMetres=sampleRay*uRadius;
    float pixelFootprint=2.0*abs(uProjectionInverse[1][1])*distanceMetres/max(1.0,uLowSize.y);
    float cloud=0.0;vec3 cloudPoint=point;
#ifndef PLANET_SKY_SIMULATION
    cloud=cloudSegment?cloudExtinction(point,max(pixelFootprint,stepMetres*.5)):0.0;
#endif
    float dust=atmosphereDust(point);vec3 dustAlbedo=vec3(0.90,0.72,0.48);
    vec3 extinction=rayleigh+vec3(mie+cloud+dust);
    float shadow=cloudSegment||uSkyEffects.y>0.0?cloudSunTransmittance(point,max(pixelFootprint,cloudSegment?stepMetres*0.5:0.0)):1.0;
    if(!cloudSegment)shadow=mix(1.0,shadow,uSkyEffects.y);
    vec3 incoming=sunTransmittance(point)*shadow*uSunIntensity;
    vec3 source=incoming*(rayleigh*rayleighPhase+vec3(mie*miePhase)+dust*dustAlbedo*hgPhase(dot(direction,uSunDirection),0.7));
#ifndef PLANET_SKY_SIMULATION
    source+=incoming*(cloud*cloudPhase);
#endif
    float daylight=smoothstep(-0.16,0.2,dot(normalize(point),uSunDirection));
    // Bounded ambient multiple-scattering fill keeps thick shaded cloud faces
    // legible without making the night hemisphere glow like daylight.
    float cloudDaylight=smoothstep(-0.16,0.2,dot(normalize(cloudPoint),uSunDirection));
    source+=vec3(0.78,0.87,1.0)*(cloud*uSunIntensity*0.035*cloudDaylight);
    source+=dust*dustAlbedo*(uSunIntensity*0.012*daylight);
    vec3 segmentTransmission=exp(-min(vec3(80.0),extinction*stepMetres));
    vec3 integral=(vec3(1.0)-segmentTransmission)/max(extinction,vec3(0.000000001));
    radiance+=transmission*source*integral;
    transmission*=segmentTransmission;
#endif
  }
}

void main() {
  vec2 uv=vUv;
  if(uPixelStyle)uv=clamp((floor(uv*uOutputSize/max(1.0,uPixelSize))+0.5)*max(1.0,uPixelSize)/uOutputSize,vec2(0.0),vec2(1.0));
  // The nearest depth texel belongs to its own full-resolution camera ray.
  // Unproject that exact texel centre too: a subpixel orbital mismatch moves
  // the inferred terminal point kilometres through the dense atmosphere.
  uv=(clamp(floor(uv*uOutputSize),vec2(0.0),uOutputSize-1.0)+0.5)/uOutputSize;
  float depth=texture(tSceneDepth,uv).r;
  vec3 radiance=vec3(0.0),transmission=vec3(1.0);
  // Mid-clip unprojection stays finite with near=.1/far=50million; the inverse
  // projection's far-clip homogeneous w can round to zero in GPU float.
  vec4 unprojected=uProjectionInverse*vec4(uv*2.0-1.0,0.0,1.0);
  vec3 viewDirection=normalize(unprojected.xyz/unprojected.w);
  vec3 direction=normalize(uCameraRotation*viewDirection);
  vec2 atmosphere=sphereInterval(uCameraRadius,direction,1.0+uAtmosphereHeight);
  float from=max(0.0,atmosphere.x),to=atmosphere.y;
  if(depth<EMPTY_DEPTH)to=min(to,positiveViewDepth(depth)/(max(0.000001,-viewDirection.z)*uRadius));
  // The reference body is opaque to atmospheric transport. Coarse terrain
  // chords and below-sea-level ground must not add kilometres of underground
  // air. Captured above-body mountains still terminate the view ray earlier.
  vec2 body=sphereInterval(uCameraRadius,direction,1.0);
  if(body.y>body.x){if(body.x>0.0)to=min(to,body.x);else if(body.y>0.0)from=max(from,body.y);}
  if(atmosphere.y>atmosphere.x&&to>from&&(uAtmosphereEnabled||uCloudEnabled)) {
    // Split the conservative altitude envelopes, in order along this ray. An
    // orbital ray can traverse the near and far side; a ground/inside-cloud ray
    // keeps its exact shell entry. No atmospheric step can skip a thin layer.
    float cuts[14];cuts[0]=from;cuts[1]=to;int cutCount=2;
    int layerCount=3;
#ifdef PLANET_SKY_SIMULATION
    layerCount=int(uSnapshotParams.w);
    float turn=-dot(uCameraRadius,direction);if(turn>from&&turn<to){cuts[cutCount]=turn;cutCount++;}
#endif
    if(cloudsActive())for(int layer=0;layer<layerCount;layer++) {
      vec4 settings=uCloudLayers[layer];if(!layerActive(settings))continue;
      vec2 outer=sphereInterval(uCameraRadius,direction,1.0+settings.x+settings.y);
      vec2 inner=sphereInterval(uCameraRadius,direction,1.0+settings.x);
      for(int side=0;side<2;side++) {
        float point=outer[side];if(outer.y>outer.x&&point>from&&point<to){cuts[cutCount]=point;cutCount++;}
        point=inner[side];if(inner.y>inner.x&&point>from&&point<to){cuts[cutCount]=point;cutCount++;}
      }
    }
    cutCount=clamp(cutCount,2,14);
    for(int i=1;i<cutCount;i++){float value=cuts[i];int at=i;for(int j=0;j<i;j++){if(at<=0)break;if(cuts[at-1]<=value)break;cuts[at]=cuts[at-1];at--;}cuts[at]=value;}
    int segmentCount=cutCount-1;
    float airLength=0.0,cloudMetric=0.0;
    int cloudIntervals=0,airIntervals=0;
    for(int i=0;i<segmentCount;i++) {
      if(cuts[i+1]<=cuts[i])continue;
      float altitude=length(uCameraRadius+direction*((cuts[i]+cuts[i+1])*0.5))-1.0;
      bool cloudy=false;int cloudLayer=0;for(int layer=0;layer<layerCount;layer++){vec4 settings=uCloudLayers[layer];if(cloudsActive()&&layerActive(settings)&&altitude>=settings.x&&altitude<=settings.x+settings.y){if(!cloudy||cloudFeatureMetres(layer)<cloudFeatureMetres(cloudLayer))cloudLayer=layer;cloudy=true;}}
      if(cloudy){cloudMetric+=cloudRayMetric(cuts[i],cuts[i+1],cloudFeatureMetres(cloudLayer));cloudIntervals++;}
      else{airLength+=cuts[i+1]-cuts[i];airIntervals++;}
    }
    airLength=max(1e-30,airLength);
    float cosine=dot(direction,uSunDirection);
    float rayleighPhase=3.0*(1.0+cosine*cosine)/(16.0*PI);
    float miePhase=hgPhase(cosine,uMieG);
    float cloudPhase=0.8*hgPhase(cosine,0.65)+0.2*hgPhase(cosine,-0.25);
    float cloudPrefix=0.0,airPrefix=0.0;
    for(int i=0;i<segmentCount;i++) {
      float begin=cuts[i],end=cuts[i+1];if(end<=begin)continue;
      vec3 midpoint=uCameraRadius+direction*((begin+end)*0.5);float altitude=length(midpoint)-1.0;
      // Local lower/upper geometry may overlap; march their envelope union
      // once, with the tighter bandwidth, and sum both densities at each point.
      bool cloudy=false;int cloudLayer=0;for(int layer=0;layer<layerCount;layer++){vec4 settings=uCloudLayers[layer];if(cloudsActive()&&layerActive(settings)&&altitude>=settings.x&&altitude<=settings.x+settings.y){if(!cloudy||cloudFeatureMetres(layer)<cloudFeatureMetres(cloudLayer))cloudLayer=layer;cloudy=true;}}
      float measure=cloudy?cloudRayMetric(begin,end,cloudFeatureMetres(cloudLayer)):end-begin;
      int steps=cloudy?apportionedSteps(cloudPrefix,cloudPrefix+measure,cloudMetric,cloudIntervals,max(cloudIntervals,clamp(uCloudSteps,1,32))):apportionedSteps(airPrefix,airPrefix+measure,airLength,airIntervals,max(airIntervals,clamp(uAtmosphereSteps,1,24)));
      if(cloudy)cloudPrefix+=measure;else airPrefix+=measure;
      // One transport law from the ground to orbit: the common macro support
      // stays exact-zero and filtered 3D density erodes only its occupied banks.
      // No separate far-distance occupancy mixture changes the column physics.
      integrateSegment(uCameraRadius,direction,begin,end,steps,cloudy?cloudLayer:-1,rayleighPhase,miePhase,cloudPhase,radiance,transmission);
    }
  }
  float surfaceVisibility=1.0;
  if(depth<EMPTY_DEPTH&&uSkyEffects.x>0.0) {
    float distanceRay=positiveViewDepth(depth)/(max(0.000001,-viewDirection.z)*uRadius);
    vec3 surface=uCameraRadius+direction*distanceRay;
    float footprint=2.0*abs(uProjectionInverse[1][1])*distanceRay*uRadius/max(1.0,uLowSize.y);
    surfaceVisibility=mix(1.0,0.25+0.75*cloudSunTransmittance(surface,footprint),uSkyEffects.x);
  }
  skyRadiance=vec4(max(vec3(0.0),radiance),surfaceVisibility);
  // Linear radius-relative depth retains relative precision in RGBA16F. Storing
  // logarithmic window depth here amplifies half-float quantization into stripes.
  skyTransmittance=vec4(clamp(transmission,vec3(0.0),vec3(1.0)),depth<EMPTY_DEPTH?positiveViewDepth(depth)/uRadius:-1.0);
}
`;

/** Celestial sources stay at full canvas resolution, before optical transport,
 * so a small star or solar disc cannot disappear in a low-resolution volume. */
export const planetSkyCelestialGLSL=/* glsl */`
vec4 skyStarHash(ivec2 cell,uint salt) {
  uint value=uint(cell.x)*1597334677u^uint(cell.y)*3812015801u^salt*2246822519u;
  value=(value^(value>>16u))*2146121005u;value=(value^(value>>15u))*2221713035u;value=value^(value>>16u);
  uint a=value;value=(value^(value>>16u))*2146121005u;uint b=value;
  value=(value^(value>>15u))*2221713035u;uint c=value;value=value^(value>>16u);uint d=value;
  return vec4(float(a&65535u),float(b&65535u),float(c&65535u),float(d&65535u))/65535.0;
}
bool skyCelestialBody(vec3 origin,vec3 direction) {
  float along=dot(origin,direction);vec3 perpendicular=cross(origin,direction);float square=1.0-dot(perpendicular,perpendicular);
  return square>=0.0&&-along-sqrt(max(0.0,square))>0.0;
}
vec3 skyCelestialSources(vec3 direction,vec3 origin,vec3 sun,vec3 visibility) {
  if(skyCelestialBody(origin,direction))return vec3(0.0);
  float pixelAngle=2.0*abs(uProjectionInverse[1][1])/max(1.0,uOutputSize.y);
  vec3 result=vec3(0.0);
  if(uCelestial.x>0.5&&dot(direction,sun)>0.0) {
    float separation=length(cross(direction,sun)),radius=max(0.00001,uCelestial.y);
    float disc=1.0-smoothstep(max(0.0,radius-pixelAngle),radius+pixelAngle,separation);
    float glow=exp(-separation*separation/(radius*radius*36.0))*uCelestial.z*0.12;
    result+=vec3(1.0,0.965,0.89)*(disc*24.0+glow);
  }
  if(uStars.x<0.5||uStars.y<=0.0||uStars.z<=0.0||max(visibility.r,max(visibility.g,visibility.b))<0.0001)return result;
  vec3 up=normalize(origin);float outside=smoothstep(1.0+uSkyEffects.z,1.0+uSkyEffects.z*2.0,length(origin));
  float night=mix(1.0-smoothstep(-0.15,0.08,dot(up,sun)),1.0,outside);if(night<0.0001)return result;
  float cr=cos(uSkyClock.y),sr=sin(uSkyClock.y);
  vec3 ray=vec3(cr*direction.x+sr*direction.z,direction.y,-sr*direction.x+cr*direction.z);
  vec2 starUv=vec2(atan(ray.x,ray.z)/(2.0*PI)+0.5,acos(clamp(ray.y,-1.0,1.0))/PI);
  ivec2 center=ivec2(floor(starUv*vec2(512.0,256.0)));
  float vertical=max(0.02,dot(direction,up)),horizon=pow(1.0-clamp(vertical,0.0,1.0),3.0)*(1.0-outside);
  float atmosphericDim=mix(exp(-0.06*(1.0/vertical-1.0)),1.0,outside);
  float width=max(0.00012,pixelAngle*0.65);uint salt=uint(uSkyClock.w)^(uint(uSkyClock.z)<<16u);
  for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++) {
    ivec2 cell=ivec2((center.x+dx+512)%512,clamp(center.y+dy,0,255));vec4 random=skyStarHash(cell,salt);
    float colat=(float(cell.y)+random.y)/256.0*PI;if(random.w>uStars.y*0.045*sin(colat))continue;
    float longitude=((float(cell.x)+random.x)/512.0-0.5)*2.0*PI;
    vec3 starDirection=vec3(sin(longitude)*sin(colat),cos(colat),cos(longitude)*sin(colat));if(dot(starDirection,ray)<0.0)continue;
    float angle=length(cross(starDirection,ray)),point=exp(-angle*angle/(width*width));
    float flicker=1.0+uStars.w*(1.0-outside)*(0.06+horizon*0.54)*(sin(uSkyClock.x*(8.0+random.x*5.0)+random.z*90.0)*0.7+sin(uSkyClock.x*17.0+random.y*70.0)*0.3);
    vec3 color=mix(vec3(1.0,0.73,0.48),vec3(0.64,0.79,1.0),random.z);float brightness=(0.45+pow(random.z,7.0)*5.0)*uStars.z;
    result+=color*(point*brightness*night*atmosphericDim*max(0.0,flicker));
  }
  return result;
}
`;

export const planetSkyCompositeFragmentShader=/* glsl */`
precision highp float;
in vec2 vUv;
layout(location=0) out vec4 outColor;
#define gl_FragColor outColor
uniform sampler2D tSceneColor;
uniform sampler2D tSceneDepth;
uniform sampler2D tRadiance;
uniform sampler2D tTransmittance;
uniform vec2 uOutputSize;
uniform vec2 uLowSize;
uniform float uPixelSize;
uniform float uPaletteSteps;
uniform bool uPixelStyle;
uniform float uNear;
uniform float uFar;
uniform float uLogDepth;
uniform float uRadius;
uniform mat4 uProjectionInverse;
uniform mat3 uCameraRotation;
uniform vec3 uCameraRadius;
uniform vec3 uSunDirection;
uniform vec4 uCelestial;
uniform vec4 uStars;
uniform vec4 uSkyClock;
uniform vec4 uSkyEffects;
const float PI=3.141592653589793;
const float EMPTY_DEPTH=0.9999999;
uniform int uDiagnostic;

${planetSkyCelestialGLSL}

float positiveViewDepth(float depth) {
  if(uLogDepth>0.5)return exp2(depth*log2(uFar+1.0))-1.0;
  return uNear*uFar/max(0.0000001,uFar-depth*(uFar-uNear));
}

float depthNeighbour(ivec2 texel) {
  float sampleDepth=texelFetch(tSceneDepth,clamp(texel,ivec2(0),ivec2(uOutputSize)-1),0).r;
  return sampleDepth>=EMPTY_DEPTH?-1.0:positiveViewDepth(sampleDepth)/uRadius;
}

float continuousSlope(float expected,float before,float after) {
  if(before<0.0||after<0.0)return 0.0;
  float left=expected-before,right=after-expected;
  // A thin foreground object has background on both sides, so its differences
  // have opposite signs. A silhouette step keeps the smaller same-side slope.
  return left*right>0.0?min(abs(left),abs(right)):0.0;
}

float depthTolerance(float actual,vec2 uv) {
  if(actual>=EMPTY_DEPTH)return 0.0;
  float expected=positiveViewDepth(actual)/uRadius;
  ivec2 texel=ivec2(clamp(floor(uv*uOutputSize),vec2(0.0),uOutputSize-1.0));
  float sx=continuousSlope(expected,depthNeighbour(texel-ivec2(1,0)),depthNeighbour(texel+ivec2(1,0)));
  float sy=continuousSlope(expected,depthNeighbour(texel-ivec2(0,1)),depthNeighbour(texel+ivec2(0,1)));
  // Adjacent volume samples can be a whole low-resolution pixel away. A fixed
  // relative tolerance creates untreated horizontal rows on smooth horizons.
  float footprint=2.0*dot(vec2(sx,sy),uOutputSize/uLowSize);
  return max(max(1.0/uRadius,expected*0.03),footprint);
}

float compatibleDepth(float actual,float candidate,float tolerance) {
  if(uDiagnostic==5||uDiagnostic==6)return 1.0;
  bool emptyActual=actual>=EMPTY_DEPTH,emptyCandidate=candidate<0.0;
  if(emptyActual||emptyCandidate)return emptyActual&&emptyCandidate?1.0:0.0;
  float expected=positiveViewDepth(actual)/uRadius,difference=abs(candidate-expected);
  if(difference>tolerance)return 0.0;
  return exp(-difference/max(0.000000001,tolerance*0.35));
}

bool conservativeTransport(vec2 uv,float actualDepth,out vec3 radiance,out vec3 transmission,out float visibility) {
  bool emptyActual=actualDepth>=EMPTY_DEPTH,skyOnly=false;
  float expected=emptyActual?0.0:positiveViewDepth(actualDepth)/uRadius,total=0.0;
  ivec2 center=ivec2(clamp(floor(uv*uLowSize),vec2(0.0),uLowSize-1.0));
  radiance=vec3(0.0);transmission=vec3(0.0);visibility=0.0;
  for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++) {
    ivec2 texel=clamp(center+ivec2(x,y),ivec2(0),ivec2(uLowSize)-1);
    vec4 path=texelFetch(tTransmittance,texel,0);bool emptyCandidate=path.a<0.0;
    // A longer or empty ray may contain clouds behind a foreground object.
    // Never use it to repair that object's missing low-resolution sample.
    if(!emptyActual&&(emptyCandidate||path.a>expected))continue;
    if(emptyActual) {
      if(skyOnly&&!emptyCandidate)continue;
      if(emptyCandidate&&!skyOnly){skyOnly=true;total=0.0;radiance=vec3(0.0);transmission=vec3(0.0);visibility=0.0;}
    }
    vec2 delta=vec2(texel)+0.5-uv*uLowSize;
    float weight=1.0/(0.25+dot(delta,delta));vec4 light=texelFetch(tRadiance,texel,0);
    radiance+=light.rgb*weight;transmission+=path.rgb*weight;visibility+=light.a*weight;total+=weight;
  }
  if(total<=0.0)return false;
  radiance/=total;transmission/=total;visibility/=total;return true;
}

void main() {
  vec2 uv=vUv;
  if(uPixelStyle)uv=clamp((floor(uv*uOutputSize/max(1.0,uPixelSize))+0.5)*max(1.0,uPixelSize)/uOutputSize,vec2(0.0),vec2(1.0));
  vec4 sceneColor=texture(tSceneColor,uv);
  float actualDepth=texture(tSceneDepth,uv).r;
  float tolerance=depthTolerance(actualDepth,uv);
  vec3 radiance=vec3(0.0),transmission=vec3(0.0);
  float totalWeight=0.0,surfaceVisibility=0.0;
  if(uPixelStyle||uDiagnostic==6) {
    vec2 lowUv=(clamp(floor(uv*uLowSize),vec2(0.0),uLowSize-1.0)+0.5)/uLowSize;
    vec4 candidate=texture(tTransmittance,lowUv);
    totalWeight=compatibleDepth(actualDepth,candidate.a,tolerance);
    vec4 light=texture(tRadiance,lowUv);radiance=light.rgb*totalWeight;surfaceVisibility=light.a*totalWeight;
    transmission=candidate.rgb*totalWeight;
  }else {
    vec2 pixel=uv*uLowSize-0.5,base=floor(pixel),fraction=fract(pixel);
    for(int y=0;y<2;y++)for(int x=0;x<2;x++) {
      vec2 offset=vec2(float(x),float(y));
      vec2 lowUv=(clamp(base+offset,vec2(0.0),uLowSize-1.0)+0.5)/uLowSize;
      vec4 candidate=texture(tTransmittance,lowUv);
      vec2 factors=mix(vec2(1.0)-fraction,fraction,offset);
      float weight=factors.x*factors.y*compatibleDepth(actualDepth,candidate.a,tolerance);
      vec4 light=texture(tRadiance,lowUv);radiance+=light.rgb*weight;surfaceVisibility+=light.a*weight;
      transmission+=candidate.rgb*weight;
      totalWeight+=weight;
    }
  }
  // Horizon disocclusions can lack a bilaterally compatible sample. Reconstruct
  // only from the local foreground transport; a near silhouette with no such
  // sample keeps identity rather than receiving clouds from behind the object.
  if(totalWeight>0.00001) {
    radiance/=totalWeight;transmission/=totalWeight;surfaceVisibility/=totalWeight;
  }else if(!conservativeTransport(uv,actualDepth,radiance,transmission,surfaceVisibility)){radiance=vec3(0.0);transmission=vec3(1.0);surfaceVisibility=1.0;}
  vec3 source=sceneColor.rgb*surfaceVisibility;
  if(actualDepth>=EMPTY_DEPTH) {
    vec4 projected=uProjectionInverse*vec4(uv*2.0-1.0,0.0,1.0);
    vec3 ray=normalize(uCameraRotation*normalize(projected.xyz/projected.w));
    source=skyCelestialSources(ray,uCameraRadius,uSunDirection,transmission);
  }
  gl_FragColor=vec4(max(vec3(0.0),source*transmission+radiance),sceneColor.a);
  if(uDiagnostic==1)gl_FragColor=sceneColor;
  if(uDiagnostic==2)gl_FragColor=vec4(texture(tRadiance,uv).rgb,1.0);
  if(uDiagnostic==3)gl_FragColor=vec4(vec3(1.0)-texture(tTransmittance,uv).rgb,1.0);
  if(uDiagnostic==4)gl_FragColor=vec4(vec3(totalWeight>0.00001?1.0:0.0),1.0);
  if(uDiagnostic==7)gl_FragColor=vec4(vec3(surfaceVisibility),1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  if(uPixelStyle) {
    float levels=max(1.0,uPaletteSteps-1.0);
    gl_FragColor.rgb=floor(clamp(gl_FragColor.rgb,vec3(0.0),vec3(1.0))*levels+0.5)/levels;
  }
}
`;
