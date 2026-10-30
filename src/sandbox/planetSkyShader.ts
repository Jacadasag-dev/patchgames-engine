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

float cloudDensity(vec3 position,float footprintMetres) {
  if(!uCloudEnabled||uCloudCoverage<=0.0||uCloudDensity<=0.0)return 0.0;
  float h=(length(position)-1.0-uCloudBottom)/uCloudThickness;
  if(h<=0.0||h>=1.0)return 0.0;
  vec3 metres=position*uRadius;
  float shapeLod=clamp(log2(max(1.0,footprintMetres/uNoiseShapeScale)),0.0,5.0);
  float detailLod=clamp(log2(max(1.0,footprintMetres/uNoiseDetailScale)),0.0,5.0);
  float base=textureLod(uNoiseTexture,metres/(uNoiseShapeScale*32.0)+uShapeWindUV,shapeLod).r;
  float detail=textureLod(uNoiseTexture,metres/(uNoiseDetailScale*32.0)+uDetailWindUV,detailLod).g;
  float weather=texture(uWeatherTexture,position/2.2+0.5).r;
  float field=clamp((weather*0.6+base*0.4-0.5)*2.5+0.5,0.0,1.0);
  float feather=0.04+0.1*clamp(footprintMetres/uNoiseShapeScale,0.0,2.0);
  float shape=smoothstep(1.0-uCloudCoverage-feather,1.0-uCloudCoverage+feather,field);
  float height=smoothstep(0.0,0.16,h)*(1.0-smoothstep(0.65,1.0,h));
  return max(0.0,(shape*height-uCloudErosion*(1.0-detail)*0.4)/(1.0-0.4*uCloudErosion))*uCloudDensity;
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

float cloudSunTransmittance(vec3 position) {
  if(!uCloudEnabled||uCloudCoverage<=0.0)return 1.0;
  float outer=1.0+uCloudBottom+uCloudThickness;
  if(length(position)>outer)return 1.0;
  vec2 shell=sphereInterval(position,uSunDirection,outer);
  if(shell.y<=0.0)return 1.0;
  // Bounded local self-shadow approximation. It deliberately does not scan an
  // entire hemisphere through a thin cloud layer at grazing sun angles.
  float lengthRay=min(shell.y,uCloudThickness*8.0);
  int count=clamp(uCloudLightSteps,1,4);
  float stepRay=lengthRay/float(count),opticalDepth=0.0;
  for(int i=0;i<4;i++) {
    if(i>=count)break;
    opticalDepth+=cloudDensity(position+uSunDirection*((float(i)+0.5)*stepRay),stepRay*uRadius)*stepRay;
  }
  return exp(-min(80.0,opticalDepth*2.0/uCloudThickness));
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
    float cloud=cloudSegment?cloudDensity(point,max(pixelFootprint,stepMetres*.5))*2.0/(uCloudThickness*uRadius):0.0;
    vec3 extinction=rayleigh+vec3(mie+cloud);
    vec3 incoming=sunTransmittance(point)*cloudSunTransmittance(point)*uSunIntensity;
    vec3 source=incoming*(rayleigh*rayleighPhase+vec3(mie*miePhase+cloud*cloudPhase));
    float daylight=clamp(dot(normalize(point),uSunDirection)*0.5+0.5,0.025,1.0);
    source+=vec3(0.78,0.87,1.0)*(cloud*uSunIntensity*0.025*daylight);
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
    vec2 first=vec2(1.0,-1.0),second=vec2(1.0,-1.0);
    if(uCloudEnabled&&uCloudCoverage>0.0&&uCloudDensity>0.0) {
      vec2 outer=sphereInterval(uCameraRadius,direction,1.0+uCloudBottom+uCloudThickness);
      float cloudFrom=max(from,outer.x),cloudTo=min(to,outer.y);
      if(outer.y>outer.x&&cloudTo>cloudFrom) {
        vec2 inner=sphereInterval(uCameraRadius,direction,1.0+uCloudBottom);
        if(inner.y>inner.x&&inner.x<cloudTo&&inner.y>cloudFrom) {
          first=vec2(cloudFrom,min(cloudTo,inner.x));
          second=vec2(max(cloudFrom,inner.y),cloudTo);
        }else first=vec2(cloudFrom,cloudTo);
      }
    }
    float cloudLength=max(0.0,first.y-first.x)+max(0.0,second.y-second.x);
    float airLength=max(0.0000001,to-from-cloudLength);
    float cosine=dot(direction,uSunDirection);
    float rayleighPhase=3.0*(1.0+cosine*cosine)/(16.0*PI);
    float miePhase=hgPhase(cosine,uMieG);
    float cloudPhase=0.8*hgPhase(cosine,0.65)+0.2*hgPhase(cosine,-0.25);
    float cursor=from;
    if(first.y>first.x) {
      integrateSegment(uCameraRadius,direction,cursor,first.x,airSteps(cursor,first.x,airLength),false,rayleighPhase,miePhase,cloudPhase,radiance,transmission);
      integrateSegment(uCameraRadius,direction,first.x,first.y,uCloudSteps,true,rayleighPhase,miePhase,cloudPhase,radiance,transmission);
      cursor=first.y;
    }
    if(second.y>second.x) {
      integrateSegment(uCameraRadius,direction,cursor,second.x,airSteps(cursor,second.x,airLength),false,rayleighPhase,miePhase,cloudPhase,radiance,transmission);
      integrateSegment(uCameraRadius,direction,second.x,second.y,uCloudSteps,true,rayleighPhase,miePhase,cloudPhase,radiance,transmission);
      cursor=second.y;
    }
    integrateSegment(uCameraRadius,direction,cursor,to,airSteps(cursor,to,airLength),false,rayleighPhase,miePhase,cloudPhase,radiance,transmission);
  }
  skyRadiance=vec4(max(vec3(0.0),radiance),1.0);
  // Linear radius-relative depth retains relative precision in RGBA16F. Storing
  // logarithmic window depth here amplifies half-float quantization into stripes.
  skyTransmittance=vec4(clamp(transmission,vec3(0.0),vec3(1.0)),depth<EMPTY_DEPTH?positiveViewDepth(depth)/uRadius:-1.0);
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
const float EMPTY_DEPTH=0.9999999;
uniform int uDiagnostic;

float positiveViewDepth(float depth) {
  if(uLogDepth>0.5)return exp2(depth*log2(uFar+1.0))-1.0;
  return uNear*uFar/max(0.0000001,uFar-depth*(uFar-uNear));
}

float compatibleDepth(float actual,float candidate) {
  if(uDiagnostic==5||uDiagnostic==6)return 1.0;
  bool emptyActual=actual>=EMPTY_DEPTH,emptyCandidate=candidate<0.0;
  if(emptyActual||emptyCandidate)return emptyActual&&emptyCandidate?1.0:0.0;
  float expected=positiveViewDepth(actual)/uRadius,difference=abs(candidate-expected);
  float tolerance=max(1.0/uRadius,expected*0.03);
  if(difference>tolerance)return 0.0;
  return exp(-difference/max(0.000000001,tolerance*0.35));
}

void main() {
  vec2 uv=vUv;
  if(uPixelStyle)uv=clamp((floor(uv*uOutputSize/max(1.0,uPixelSize))+0.5)*max(1.0,uPixelSize)/uOutputSize,vec2(0.0),vec2(1.0));
  vec4 sceneColor=texture(tSceneColor,uv);
  float actualDepth=texture(tSceneDepth,uv).r;
  vec3 radiance=vec3(0.0),transmission=vec3(0.0);
  float totalWeight=0.0;
  if(uPixelStyle||uDiagnostic==6) {
    vec2 lowUv=(clamp(floor(uv*uLowSize),vec2(0.0),uLowSize-1.0)+0.5)/uLowSize;
    vec4 candidate=texture(tTransmittance,lowUv);
    totalWeight=compatibleDepth(actualDepth,candidate.a);
    radiance=texture(tRadiance,lowUv).rgb*totalWeight;
    transmission=candidate.rgb*totalWeight;
  }else {
    vec2 pixel=uv*uLowSize-0.5,base=floor(pixel),fraction=fract(pixel);
    for(int y=0;y<2;y++)for(int x=0;x<2;x++) {
      vec2 offset=vec2(float(x),float(y));
      vec2 lowUv=(clamp(base+offset,vec2(0.0),uLowSize-1.0)+0.5)/uLowSize;
      vec4 candidate=texture(tTransmittance,lowUv);
      vec2 factors=mix(vec2(1.0)-fraction,fraction,offset);
      float weight=factors.x*factors.y*compatibleDepth(actualDepth,candidate.a);
      radiance+=texture(tRadiance,lowUv).rgb*weight;
      transmission+=candidate.rgb*weight;
      totalWeight+=weight;
    }
  }
  // A foreground silhouette with no depth-compatible low-resolution sample gets
  // identity instead of borrowing a behind-terrain cloud and producing a halo.
  if(totalWeight>0.00001) {
    radiance/=totalWeight;transmission/=totalWeight;
  }else {radiance=vec3(0.0);transmission=vec3(1.0);}
  gl_FragColor=vec4(max(vec3(0.0),sceneColor.rgb*transmission+radiance),sceneColor.a);
  if(uDiagnostic==1)gl_FragColor=sceneColor;
  if(uDiagnostic==2)gl_FragColor=vec4(texture(tRadiance,uv).rgb,1.0);
  if(uDiagnostic==3)gl_FragColor=vec4(vec3(1.0)-texture(tTransmittance,uv).rgb,1.0);
  if(uDiagnostic==4)gl_FragColor=vec4(vec3(totalWeight>0.00001?1.0:0.0),1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  if(uPixelStyle) {
    float levels=max(1.0,uPaletteSteps-1.0);
    gl_FragColor.rgb=floor(clamp(gl_FragColor.rgb,vec3(0.0),vec3(1.0))*levels+0.5)/levels;
  }
}
`;
