import {planetWeatherCoverageGLSL} from '../shared/planetWeather.ts';

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
in vec2 vUv;
layout(location=0) out vec4 skyRadiance;
layout(location=1) out vec4 skyTransmittance;

uniform sampler2D tSceneDepth;
uniform sampler3D uNoiseTexture;
uniform sampler3D uWeatherTexture;
uniform sampler2D tCirculationCoverage;
uniform sampler2D tCirculationEnvironment;
uniform vec4 uStormCenters[16];
uniform vec4 uStormProperties[16];
uniform int uStormCount;
uniform float uWeatherTimeDays;
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

${planetWeatherCoverageGLSL}

vec3 cloudRegionalCoverage(vec3 position) {
  vec3 coverage=planetWeatherCoverage(tCirculationCoverage,tCirculationEnvironment,normalize(position),uSunDirection,uWeatherTimeDays,uStormCenters,uStormProperties,uStormCount,uCoverageGain);
  return clamp(coverage*(textureLod(uWeatherTexture,position/2.2+0.5,0.0).r*2.0),vec3(0.0),vec3(1.0));
}

float cloudLayerDensity(vec3 position,float footprintMetres,int layer) {
  vec4 settings=uCloudLayers[layer];
  if(!uCloudEnabled||uCloudCoverage<=0.0||uCoverageGain<=0.0||uCloudDensity<=0.0||settings.w<0.5||settings.z<=0.0)return 0.0;
  float h=(length(position)-1.0-settings.x)/settings.y;
  if(h<=0.0||h>=1.0)return 0.0;
  vec3 metres=position*uRadius;vec3 radial=normalize(position);
  float latitudeDegrees=abs(asin(clamp(radial.y,-1.0,1.0)))*180.0/PI;
  float zonalWind=-8.0+30.0*smoothstep(25.0,38.0,latitudeDegrees)*(1.0-smoothstep(60.0,72.0,latitudeDegrees));
  float flowAngle=-zonalWind*uWeatherTimeDays*86400.0/6371000.0,flowCos=cos(flowAngle),flowSin=sin(flowAngle);
  metres=vec3(flowCos*metres.x+flowSin*metres.z,metres.y,-flowSin*metres.x+flowCos*metres.z);
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
  vec3 coverage=cloudRegionalCoverage(position);
  if(coverage[layer]<=0.0)return 0.0;
  float feather=0.06+0.1*clamp(footprintMetres/uNoiseShapeScale,0.0,2.0);
  float shape=smoothstep(1.0-coverage[layer]-feather,1.0-coverage[layer]+feather,base);
  float cumulusHeight=h/(0.55+0.45*shapeNoise.b);
  float height=layer==0?smoothstep(0.0,0.002,h)*exp(-3.0*h)*(1.0-smoothstep(0.65,1.0,h)):
    layer==1?smoothstep(0.0,0.08,cumulusHeight)*(1.0-smoothstep(0.55,1.0,cumulusHeight)):smoothstep(0.0,0.18,h)*(1.0-smoothstep(0.65,1.0,h));
  float erosion=layer==2?0.12:uCloudErosion;
  return max(0.0,(shape*height-erosion*(1.0-detail)*0.35)/(1.0-0.35*erosion))*uCloudDensity*settings.z;
}

float cloudExtinction(vec3 position,float footprintMetres) {
  float density=0.0;
  for(int layer=0;layer<3;layer++)density+=cloudLayerDensity(position,footprintMetres,layer)*(layer==0?4.0:layer==1?8.0:2.0)/(uCloudLayers[layer].y*uRadius);
  return density;
}

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
  vec2 opticalDepth=vec2(0.0);
  for(int i=0;i<4;i++) {
    if(i>=count)break;
    vec3 point=position+uSunDirection*((float(i)+0.5)*stepRay);
    opticalDepth+=airDensity(point)*(stepRay*uRadius);
  }
  return exp(-min(vec3(80.0),uRayleigh*opticalDepth.x+vec3(uMie*opticalDepth.y)));
}

float cloudSunTransmittance(vec3 position,float observerFootprintMetres) {
  if(!uCloudEnabled||uCloudCoverage<=0.0||uCoverageGain<=0.0||uCloudDensity<=0.0)return 1.0;
  // Direct planetary occlusion is already handled by sunTransmittance. Keep
  // this factor specific to clouds so a clear night cannot darken scene ambient.
  if(planetShadows(position))return 1.0;
  float opticalDepth=0.0;
  for(int layer=0;layer<3;layer++) {
    vec4 settings=uCloudLayers[layer];if(settings.w<0.5||settings.z<=0.0)continue;
    vec2 outer=sphereInterval(position,uSunDirection,1.0+settings.x+settings.y);
    if(outer.y<=max(0.0,outer.x))continue;
    vec2 inner=sphereInterval(position,uSunDirection,1.0+settings.x);
    vec2 segments[2];segments[0]=vec2(max(0.0,outer.x),outer.y);segments[1]=vec2(1.0,-1.0);
    if(inner.y>inner.x&&inner.x<outer.y&&inner.y>segments[0].x) {
      segments[1]=vec2(max(segments[0].x,inner.y),outer.y);segments[0].y=min(outer.y,inner.x);
    }
    for(int part=0;part<2;part++) {
      float start=segments[part].x,end=segments[part].y;if(end<=start)continue;
      // A bounded cone average avoids highly aliased sun shafts. At shallow
      // angles the finite cloud-shell segment is sampled, never the empty gap
      // below the cloud. The same extinction drives surfaces and air lighting.
      int count=clamp(uCloudLightSteps,1,4);float stepRay=(end-start)/float(count);
      for(int i=0;i<4;i++) {
        if(i>=count)break;
        vec3 point=position+uSunDirection*(start+(float(i)+0.5)*stepRay);
        float density=cloudLayerDensity(point,max(observerFootprintMetres,stepRay*uRadius*0.3),layer);
        opticalDepth+=density*(layer==0?4.0:layer==1?8.0:2.0)*stepRay/settings.y;
      }
    }
    if(opticalDepth>12.0)break;
  }
  return exp(-min(80.0,opticalDepth));
}

float hgPhase(float cosine,float g) {
  return (1.0-g*g)/(4.0*PI*pow(max(0.001,1.0+g*g-2.0*g*cosine),1.5));
}

void integrateSegment(vec3 origin,vec3 direction,float from,float to,int requested,bool cloudSegment,
                      float rayleighPhase,float miePhase,float cloudPhase,inout vec3 radiance,inout vec3 transmission) {
  if(to<=from||(!cloudSegment&&!uAtmosphereEnabled)||max(transmission.r,max(transmission.g,transmission.b))<0.01)return;
  int count=clamp(requested,1,32);
  float stepRay=(to-from)/float(count),stepMetres=stepRay*uRadius;
  for(int i=0;i<32;i++) {
    if(i>=count||max(transmission.r,max(transmission.g,transmission.b))<0.01)break;
    vec3 point=origin+direction*(from+(float(i)+0.5)*stepRay);
    vec2 air=airDensity(point);
    vec3 rayleigh=uRayleigh*air.x;
    float mie=uMie*air.y;
    float distanceMetres=(from+(float(i)+0.5)*stepRay)*uRadius;
    float pixelFootprint=2.0*abs(uProjectionInverse[1][1])*distanceMetres/max(1.0,uLowSize.y);
    float cloud=cloudSegment?cloudExtinction(point,max(pixelFootprint,stepMetres*.5)):0.0;
    vec3 extinction=rayleigh+vec3(mie+cloud);
    float shadow=cloudSegment||uSkyEffects.y>0.0?cloudSunTransmittance(point,pixelFootprint):1.0;
    if(!cloudSegment)shadow=mix(1.0,shadow,uSkyEffects.y);
    vec3 incoming=sunTransmittance(point)*shadow*uSunIntensity;
    vec3 source=incoming*(rayleigh*rayleighPhase+vec3(mie*miePhase+cloud*cloudPhase));
    float daylight=smoothstep(-0.16,0.2,dot(normalize(point),uSunDirection));
    // Bounded ambient multiple-scattering fill keeps thick shaded cloud faces
    // legible without making the night hemisphere glow like daylight.
    source+=vec3(0.78,0.87,1.0)*(cloud*uSunIntensity*0.035*daylight);
    vec3 segmentTransmission=exp(-min(vec3(80.0),extinction*stepMetres));
    vec3 integral=(vec3(1.0)-segmentTransmission)/max(extinction,vec3(0.000000001));
    radiance+=transmission*source*integral;
    transmission*=segmentTransmission;
  }
}

int airSteps(float from,float to,float totalAirLength) {
  float fraction=clamp(max(0.0,to-from)/max(0.0000001,totalAirLength),0.0,1.0);
  // Divide before multiplying. N*length/length can round just above integer N
  // and ceil into N+1 in alternating pixels, visibly changing the quadrature.
  return clamp(int(ceil(float(clamp(uAtmosphereSteps,1,24))*fraction-0.0001)),1,24);
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
    // Split all three spherical altitude layers, in order along this ray. An
    // orbital ray can traverse the near and far side; a ground/inside-cloud ray
    // keeps its exact shell entry. No atmospheric step can skip a thin layer.
    float cuts[14];cuts[0]=from;cuts[1]=to;int cutCount=2;
    if(uCloudEnabled&&uCloudCoverage>0.0&&uCoverageGain>0.0&&uCloudDensity>0.0)for(int layer=0;layer<3;layer++) {
      vec4 settings=uCloudLayers[layer];if(settings.w<0.5||settings.z<=0.0)continue;
      vec2 outer=sphereInterval(uCameraRadius,direction,1.0+settings.x+settings.y);
      vec2 inner=sphereInterval(uCameraRadius,direction,1.0+settings.x);
      for(int side=0;side<2;side++) {
        float point=outer[side];if(outer.y>outer.x&&point>from&&point<to){cuts[cutCount]=point;cutCount++;}
        point=inner[side];if(inner.y>inner.x&&point>from&&point<to){cuts[cutCount]=point;cutCount++;}
      }
    }
    for(int i=1;i<14;i++){if(i>=cutCount)break;float value=cuts[i];int at=i;for(int j=0;j<13;j++){if(at<=0)break;if(cuts[at-1]<=value)break;cuts[at]=cuts[at-1];at--;}cuts[at]=value;}
    float cloudLength=0.0;
    for(int i=0;i<13;i++) {
      if(i+1>=cutCount)break;
      float altitude=length(uCameraRadius+direction*((cuts[i]+cuts[i+1])*0.5))-1.0;
      bool cloudy=false;for(int layer=0;layer<3;layer++){vec4 settings=uCloudLayers[layer];if(uCloudEnabled&&uCloudCoverage>0.0&&uCoverageGain>0.0&&uCloudDensity>0.0&&settings.w>0.5&&settings.z>0.0&&altitude>=settings.x&&altitude<=settings.x+settings.y)cloudy=true;}
      if(cloudy)cloudLength+=max(0.0,cuts[i+1]-cuts[i]);
    }
    float airLength=max(0.0000001,to-from-cloudLength);
    float cosine=dot(direction,uSunDirection);
    float rayleighPhase=3.0*(1.0+cosine*cosine)/(16.0*PI);
    float miePhase=hgPhase(cosine,uMieG);
    float cloudPhase=0.8*hgPhase(cosine,0.65)+0.2*hgPhase(cosine,-0.25);
    for(int i=0;i<13;i++) {
      if(i+1>=cutCount)break;float begin=cuts[i],end=cuts[i+1];if(end<=begin)continue;
      vec3 midpoint=uCameraRadius+direction*((begin+end)*0.5);float altitude=length(midpoint)-1.0;
      bool cloudy=false;int cloudLayer=0;for(int layer=0;layer<3;layer++){vec4 settings=uCloudLayers[layer];if(uCloudEnabled&&uCloudCoverage>0.0&&uCoverageGain>0.0&&uCloudDensity>0.0&&settings.w>0.5&&settings.z>0.0&&altitude>=settings.x&&altitude<=settings.x+settings.y){cloudy=true;cloudLayer=layer;}}
      int steps=cloudy?clamp(int(ceil(float(uCloudSteps)*(end-begin)/max(cloudLength,0.0000001))),4,32):airSteps(begin,end,airLength);
      vec3 beforeRadiance=radiance,beforeTransmission=transmission;
      integrateSegment(uCameraRadius,direction,begin,end,steps,cloudy,rayleighPhase,miePhase,cloudPhase,radiance,transmission);
      if(cloudy) {
        float footprint=2.0*abs(uProjectionInverse[1][1])*((begin+end)*0.5)*uRadius/max(1.0,uLowSize.y);
        float scale=cloudLayer==2?min(uNoiseShapeScale*0.22,uCloudLayers[cloudLayer].y*uRadius/4.0):uNoiseShapeScale;
        float far=smoothstep(scale,scale*4.0,footprint);
        if(far>0.0) {
          // Filter column transmittance, not average microscopic density. A
          // half-covered distant pixel is half clear; it must not accumulate
          // twenty half-dense samples into an almost opaque white sheet.
          // A one-point clear-air alternative preserves Rayleigh transport in
          // long grazing shells. It is independent of the full cloud column;
          // mixing the two transmittances keeps unresolved coverage coherent.
          float occupied=mix(1.0,cloudRegionalCoverage(midpoint)[cloudLayer],far);
          vec3 clearRadiance=beforeRadiance,clearTransmission=beforeTransmission;
          integrateSegment(uCameraRadius,direction,begin,end,1,false,rayleighPhase,miePhase,cloudPhase,clearRadiance,clearTransmission);
          radiance=mix(clearRadiance,radiance,occupied);
          transmission=mix(clearTransmission,transmission,occupied);
        }
      }
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
  // A foreground silhouette with no depth-compatible low-resolution sample gets
  // identity instead of borrowing a behind-terrain cloud and producing a halo.
  if(totalWeight>0.00001) {
    radiance/=totalWeight;transmission/=totalWeight;surfaceVisibility/=totalWeight;
  }else {radiance=vec3(0.0);transmission=vec3(1.0);surfaceVisibility=1.0;}
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
