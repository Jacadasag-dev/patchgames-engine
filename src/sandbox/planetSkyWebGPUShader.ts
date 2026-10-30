import {planetWeatherCoverageWGSL} from '../shared/planetWeather.ts';

/** Engine-owned native WGSL. Positions are planet-radius relative, and scene
 * depth uses Three's native WebGPU (including its distinct logarithmic) curve.
 * The two output columns carry RGB radiance and RGB transmission + linear depth.
 * Validated loop budgets keep every quality preset bounded on the GPU. */
export const planetSkyWebGPUVolumeWGSL=/* wgsl */`
fn planetSkyVolume(
 uvIn:vec2<f32>,sceneDepth:texture_depth_2d,noise:texture_3d<f32>,noiseSampler:sampler,weather:texture_3d<f32>,weatherSampler:sampler,
 circulationCoverage:texture_2d<f32>,circulationEnvironment:texture_2d<f32>,circulationSampler:sampler,
 projectionInverse:mat4x4<f32>,cameraRotation:mat4x4<f32>,cameraRadius:vec3<f32>,sunDirection:vec3<f32>,rayleigh:vec3<f32>,
 shapeWind:vec3<f32>,detailWind:vec3<f32>,geometry:vec4<f32>,atmosphere:vec4<f32>,lighting:vec4<f32>,clouds:vec4<f32>,
 details:vec4<f32>,steps:vec4<f32>,dimensions:vec4<f32>,style:vec4<f32>,effects:vec4<f32>,
 fogLayer:vec4<f32>,cumulusLayer:vec4<f32>,cirrusLayer:vec4<f32>,weatherParams:vec4<f32>,condensationThreshold:f32,weatherEvolutionPhase:f32,
 stormCenters0:mat4x4<f32>,stormCenters1:mat4x4<f32>,stormCenters2:mat4x4<f32>,stormCenters3:mat4x4<f32>,
 stormProperties0:mat4x4<f32>,stormProperties1:mat4x4<f32>,stormProperties2:mat4x4<f32>,stormProperties3:mat4x4<f32>
)->mat4x4<f32>{
 let centers=array<vec4<f32>,16>(stormCenters0[0],stormCenters0[1],stormCenters0[2],stormCenters0[3],stormCenters1[0],stormCenters1[1],stormCenters1[2],stormCenters1[3],stormCenters2[0],stormCenters2[1],stormCenters2[2],stormCenters2[3],stormCenters3[0],stormCenters3[1],stormCenters3[2],stormCenters3[3]);
 let properties=array<vec4<f32>,16>(stormProperties0[0],stormProperties0[1],stormProperties0[2],stormProperties0[3],stormProperties1[0],stormProperties1[1],stormProperties1[2],stormProperties1[3],stormProperties2[0],stormProperties2[1],stormProperties2[2],stormProperties2[3],stormProperties3[0],stormProperties3[1],stormProperties3[2],stormProperties3[3]);
 let c=SkyConfig(geometry,atmosphere,lighting,clouds,details,steps,dimensions,projectionInverse,rayleigh,sunDirection,shapeWind,detailWind,fogLayer,cumulusLayer,cirrusLayer,effects,weatherParams,condensationThreshold,weatherEvolutionPhase,centers,properties);
 var uv=uvIn;
 if(style.x>0.5){uv=clamp((floor(uv*dimensions.xy/max(1.0,style.y))+0.5)*max(1.0,style.y)/dimensions.xy,vec2<f32>(0.0),vec2<f32>(1.0));}
 let texel=vec2<i32>(clamp(floor(uv*dimensions.xy),vec2<f32>(0.0),dimensions.xy-1.0));uv=(vec2<f32>(texel)+0.5)/dimensions.xy;
 let depth=textureLoad(sceneDepth,texel,0);
 let projected=projectionInverse*vec4<f32>(uv.x*2.0-1.0,1.0-uv.y*2.0,0.5,1.0);
 let viewDirection=normalize(projected.xyz/projected.w);let direction=normalize((cameraRotation*vec4<f32>(viewDirection,0.0)).xyz);
 let shell=skySphere(cameraRadius,direction,1.0+atmosphere.x);
 var rayStart=max(0.0,shell.x);var rayEnd=shell.y;
 if(depth<0.9999999){rayEnd=min(rayEnd,skyViewDepth(depth,geometry)/(max(0.000001,-viewDirection.z)*geometry.x));}
 let body=skySphere(cameraRadius,direction,1.0);
 if(body.y>body.x){if(body.x>0.0){rayEnd=min(rayEnd,body.x);}else if(body.y>0.0){rayStart=max(rayStart,body.y);}}
 var transport=mat4x4<f32>(vec4<f32>(0.0,0.0,0.0,1.0),vec4<f32>(1.0,1.0,1.0,0.0),vec4<f32>(0.0),vec4<f32>(0.0));
 if(shell.y>shell.x&&rayEnd>rayStart&&(details.w>0.5||lighting.w>0.5)){
  var cuts:array<f32,14>;cuts[0]=rayStart;cuts[1]=rayEnd;var cutCount=2;
  if(lighting.w>0.5&&clouds.z>0.0&&clouds.w>0.0&&weatherParams.z>0.0){for(var layer=0;layer<3;layer++){
   let settings=skyLayer(c,layer);if(settings.w<0.5||settings.z<=0.0){continue;}
   let outer=skySphere(cameraRadius,direction,1.0+settings.x+settings.y);let inner=skySphere(cameraRadius,direction,1.0+settings.x);
   for(var side=0;side<2;side++){var point=outer[side];if(outer.y>outer.x&&point>rayStart&&point<rayEnd){cuts[cutCount]=point;cutCount++;}point=inner[side];if(inner.y>inner.x&&point>rayStart&&point<rayEnd){cuts[cutCount]=point;cutCount++;}}
  }}
  cutCount=clamp(cutCount,2,14);let segmentCount=cutCount-1;
  for(var index=1;index<cutCount;index++){let value=cuts[index];var slot=index;for(var sortStep=0;sortStep<index;sortStep++){if(slot<=0){break;}if(cuts[slot-1]<=value){break;}cuts[slot]=cuts[slot-1];slot--;}cuts[slot]=value;}
  var airLength=0.0;var cloudMetric=0.0;var cloudIntervals=0;var airIntervals=0;
  for(var index=0;index<segmentCount;index++){
   if(cuts[index+1]<=cuts[index]){continue;}
   let cloudLayer=skyCloudLayerIndex(c,cameraRadius+direction*((cuts[index]+cuts[index+1])*0.5));
   if(cloudLayer>=0){cloudMetric+=skyRayMetric(c,cuts[index],cuts[index+1],skyFeatureMetres(c,cloudLayer));cloudIntervals++;}else{airLength+=cuts[index+1]-cuts[index];airIntervals++;}
  }
  let cosine=dot(direction,sunDirection);
  let phase=vec3<f32>(3.0*(1.0+cosine*cosine)/(16.0*3.141592653589793),skyHG(cosine,lighting.x),0.8*skyHG(cosine,0.65)+0.2*skyHG(cosine,-0.25));
  var cloudPrefix=0.0;var airPrefix=0.0;
  for(var index=0;index<segmentCount;index++){
   let begin=cuts[index];let end=cuts[index+1];if(end<=begin){continue;}
   let midpoint=cameraRadius+direction*((begin+end)*0.5);let cloudLayer=skyCloudLayerIndex(c,midpoint);let cloudy=cloudLayer>=0;
   var measure=end-begin;var count=0;
   if(cloudy){measure=skyRayMetric(c,begin,end,skyFeatureMetres(c,cloudLayer));count=skyApportionedSteps(cloudPrefix,cloudPrefix+measure,cloudMetric,cloudIntervals,max(cloudIntervals,clamp(i32(steps.z),1,32)));cloudPrefix+=measure;}
   else{count=skyApportionedSteps(airPrefix,airPrefix+measure,airLength,airIntervals,max(airIntervals,clamp(i32(steps.x),1,24)));airPrefix+=measure;}
   // The same support and transport law applies at every viewing distance.
   transport=skyIntegrate(c,noise,noiseSampler,weather,weatherSampler,circulationCoverage,circulationEnvironment,circulationSampler,cameraRadius,direction,begin,end,count,cloudLayer,phase,transport);
  }
 }
 var linearDepth=-1.0;var surfaceVisibility=1.0;
 if(depth<0.9999999){linearDepth=skyViewDepth(depth,geometry)/geometry.x;if(effects.x>0.0){
  let distanceRay=linearDepth/max(0.000001,-viewDirection.z);let p=cameraRadius+direction*distanceRay;
  let observerFootprint=2.0*abs(projectionInverse[1][1])*distanceRay*geometry.x/max(1.0,dimensions.w);
  let visible=skyCloudSun(c,noise,noiseSampler,weather,weatherSampler,circulationCoverage,circulationEnvironment,circulationSampler,p,observerFootprint);
  surfaceVisibility=mix(1.0,0.25+0.75*visible,effects.x);
 }}
 return mat4x4<f32>(vec4<f32>(max(vec3<f32>(0.0),transport[0].rgb),surfaceVisibility),vec4<f32>(clamp(transport[1].rgb,vec3<f32>(0.0),vec3<f32>(1.0)),linearDepth),vec4<f32>(0.0),vec4<f32>(0.0));
}
struct SkyConfig{
 geometry:vec4<f32>,atmosphere:vec4<f32>,lighting:vec4<f32>,clouds:vec4<f32>,details:vec4<f32>,steps:vec4<f32>,dimensions:vec4<f32>,
 projectionInverse:mat4x4<f32>,rayleigh:vec3<f32>,sun:vec3<f32>,shapeWind:vec3<f32>,detailWind:vec3<f32>,
 fogLayer:vec4<f32>,cumulusLayer:vec4<f32>,cirrusLayer:vec4<f32>,effects:vec4<f32>,weatherParams:vec4<f32>,condensationThreshold:f32,weatherEvolutionPhase:f32,stormCenters:array<vec4<f32>,16>,stormProperties:array<vec4<f32>,16>
}
fn skySphere(origin:vec3<f32>,direction:vec3<f32>,radius:f32)->vec2<f32>{
 let along=dot(origin,direction);let perpendicular=cross(origin,direction);let square=radius*radius-dot(perpendicular,perpendicular);
 if(square<0.0){return vec2<f32>(1.0,-1.0);}let extent=sqrt(max(0.0,square));return vec2<f32>(-along-extent,-along+extent);
}
fn skyViewDepth(depth:f32,g:vec4<f32>)->f32{if(g.w>0.5){return g.y*exp2(depth*log2(g.z/g.y));}return g.y*g.z/max(0.0000001,g.z-depth*(g.z-g.y));}
fn skyLayer(c:SkyConfig,index:i32)->vec4<f32>{if(index==0){return c.fogLayer;}if(index==1){return c.cumulusLayer;}return c.cirrusLayer;}
fn skyCloudLayerIndex(c:SkyConfig,p:vec3<f32>)->i32{
 if(c.lighting.w<0.5||c.clouds.z<=0.0||c.clouds.w<=0.0||c.weatherParams.z<=0.0){return -1;}let altitude=length(p)-1.0;var selected=-1;
 for(var index=0;index<3;index++){let layer=skyLayer(c,index);if(layer.w>0.5&&layer.z>0.0&&altitude>=layer.x&&altitude<=layer.x+layer.y){selected=index;}}return selected;
}
fn skyWeather(c:SkyConfig,weather:texture_3d<f32>,ws:sampler,circulationCoverage:texture_2d<f32>,circulationEnvironment:texture_2d<f32>,cs:sampler,p:vec3<f32>)->PlanetWeatherState{
 var state=planetWeatherState(circulationCoverage,circulationEnvironment,cs,normalize(p),c.sun,c.weatherParams.x,c.stormCenters,c.stormProperties,i32(c.weatherParams.y),c.weatherParams.z,c.weatherParams.w,c.condensationThreshold,c.geometry.x);
 state.coverage=clamp(state.coverage*(textureSampleLevel(weather,ws,p/2.2+0.5,0.0).r*2.0),vec3<f32>(0.0),vec3<f32>(1.0));
 return state;
}
fn skyMorph(c:SkyConfig,metres:vec3<f32>)->vec3<f32>{
 let evolution=c.weatherEvolutionPhase;let q=metres/c.details.y*0.35;
 return metres+sin(q.yzx+0.6*sin(q.zxy+vec3<f32>(evolution,-evolution,evolution)))*(c.details.y*0.28);
}
fn skyFeatureMetres(c:SkyConfig,index:i32)->f32{
 let thickness=skyLayer(c,index).y*c.geometry.x;var shape=c.details.y;if(index==2){shape=min(c.details.y*0.22,thickness/4.0);}
 return max(c.geometry.x/6371000.0,min(shape*0.25,thickness*0.125));
}
fn skyLog1p(value:f32)->f32{if(value<0.01){return value*(1.0+value*(-0.5+value/3.0));}return log(1.0+value);}
fn skyExpm1(value:f32)->f32{if(value<0.01){return value*(1.0+value*(0.5+value/6.0));}return exp(value)-1.0;}
fn skyRayMetric(c:SkyConfig,rayStart:f32,rayEnd:f32,feature:f32)->f32{return skyLog1p(max(0.0,rayEnd-rayStart)/(max(0.0,rayStart)+feature/c.geometry.x));}
fn skyRayEdge(c:SkyConfig,rayStart:f32,rayEnd:f32,metric:f32,feature:f32,fraction:f32)->f32{
 if(fraction<=0.0){return rayStart;}if(fraction>=1.0){return rayEnd;}
 return clamp(rayStart+(rayStart+feature/c.geometry.x)*skyExpm1(metric*fraction),rayStart,rayEnd);
}
fn skyWorldPhase(c:SkyConfig,noise:texture_3d<f32>,ns:sampler,midpoint:vec3<f32>,feature:f32)->f32{
 return 0.2+0.6*textureSampleLevel(noise,ns,midpoint*c.geometry.x/(feature*32.0),0.0).a;
}
fn skyApportionedSteps(before:f32,after:f32,total:f32,intervals:i32,budget:i32)->i32{
 let extra=max(0,budget-intervals);let start=i32(floor(f32(extra)*clamp(before/max(1e-30,total),0.0,1.0)));let end=i32(floor(f32(extra)*clamp(after/max(1e-30,total),0.0,1.0)));
 return 1+end-start;
}
fn skyCloudLayer(c:SkyConfig,noise:texture_3d<f32>,ns:sampler,weather:texture_3d<f32>,ws:sampler,circulationCoverage:texture_2d<f32>,circulationEnvironment:texture_2d<f32>,cs:sampler,p:vec3<f32>,footprint:f32,index:i32)->f32{
 let settings=skyLayer(c,index);if(c.lighting.w<0.5||c.clouds.z<=0.0||c.clouds.w<=0.0||c.weatherParams.z<=0.0||settings.w<0.5||settings.z<=0.0){return 0.0;}
 let h=(length(p)-1.0-settings.x)/settings.y;if(h<=0.0||h>=1.0){return 0.0;}
 let state=skyWeather(c,weather,ws,circulationCoverage,circulationEnvironment,cs,p);
 if(state.support<=0.0||state.coverage[index]<=0.0){return 0.0;}
 let metres=skyMorph(c,state.flowDirection*(length(p)*c.geometry.x));
 var filterScale=c.details.y;if(index==2){filterScale=min(c.details.y*0.22,settings.y*c.geometry.x/4.0);}
 let shapeLod=clamp(log2(max(1.0,footprint/filterScale)),0.0,5.0);let detailLod=clamp(log2(max(1.0,footprint/c.details.z)),0.0,5.0);
 var shapeUv=metres/(c.details.y*32.0)+c.shapeWind;
 if(index==2){let direction=normalize(metres);let longitude=atan2(direction.x,direction.z)/6.283185307179586+0.5;let periods=max(1.0,floor(6.283185307179586*c.geometry.x/(c.details.y*32.0*8.0)+0.5));shapeUv=vec3<f32>(longitude*periods,asin(clamp(direction.y,-1.0,1.0))*c.geometry.x/(c.details.y*32.0*0.22),h*0.125)+c.shapeWind;}
 let shapeNoise=textureSampleLevel(noise,ns,shapeUv,shapeLod);let base=shapeNoise.r;
 let detail=textureSampleLevel(noise,ns,metres/(c.details.z*32.0)+c.detailWind,detailLod).g;
 let shape=smoothstep(0.30,0.68,base);
 let column=skyMorph(c,state.flowDirection*((1.0+settings.x)*c.geometry.x));var top=shapeNoise.b;
 if(index==1){top=textureSampleLevel(noise,ns,column/(c.details.y*32.0)+c.shapeWind,shapeLod).b;}
 let cumulusHeight=h/(0.55+0.45*top);var height=0.0;
 if(index==0){height=smoothstep(0.0,0.002,h)*exp(-3.0*h)*(1.0-smoothstep(0.65,1.0,h));}else if(index==1){height=smoothstep(0.0,0.08,cumulusHeight)*(1.0-smoothstep(0.55,1.0,cumulusHeight));}else{height=smoothstep(0.0,0.18,h)*(1.0-smoothstep(0.65,1.0,h));}
 var erosion=c.details.x;if(index==2){erosion=0.12;}
 return state.coverage[index]*max(0.0,(shape*height-erosion*(1.0-detail)*0.35)/(1.0-0.35*erosion))*c.clouds.w*settings.z;
}
fn skyCloudExtinction(c:SkyConfig,noise:texture_3d<f32>,ns:sampler,weather:texture_3d<f32>,ws:sampler,circulationCoverage:texture_2d<f32>,circulationEnvironment:texture_2d<f32>,cs:sampler,p:vec3<f32>,footprint:f32)->f32{
 var extinction=0.0;for(var index=0;index<3;index++){let settings=skyLayer(c,index);var coefficient=2.0;if(index==0){coefficient=4.0;}else if(index==1){coefficient=8.0;}extinction+=skyCloudLayer(c,noise,ns,weather,ws,circulationCoverage,circulationEnvironment,cs,p,footprint,index)*coefficient/(settings.y*c.geometry.x);}return extinction;
}
fn skyAir(c:SkyConfig,p:vec3<f32>)->vec2<f32>{if(c.details.w<0.5){return vec2<f32>(0.0);}let altitude=max(0.0,(length(p)-1.0)*c.geometry.x);return exp(-altitude/c.atmosphere.yz);}
fn skyPlanetShadows(c:SkyConfig,p:vec3<f32>)->bool{let body=skySphere(p,c.sun,1.0);return body.y>0.0000001&&body.x>0.0000001;}
fn skySun(c:SkyConfig,p:vec3<f32>)->vec3<f32>{
 if(skyPlanetShadows(c,p)){return vec3<f32>(0.0);}if(c.details.w<0.5){return vec3<f32>(1.0);}
 let shell=skySphere(p,c.sun,1.0+c.atmosphere.x);let count=clamp(i32(c.steps.y),1,4);let stepRay=max(0.0,shell.y)/f32(count);var optical=vec2<f32>(0.0);
 for(var index=0;index<4;index++){if(index>=count){break;}optical+=skyAir(c,p+c.sun*((f32(index)+0.5)*stepRay))*(stepRay*c.geometry.x);}return exp(-min(vec3<f32>(80.0),c.rayleigh*optical.x+vec3<f32>(c.atmosphere.w*optical.y)));
}
fn skyCloudSun(c:SkyConfig,noise:texture_3d<f32>,ns:sampler,weather:texture_3d<f32>,ws:sampler,circulationCoverage:texture_2d<f32>,circulationEnvironment:texture_2d<f32>,cs:sampler,p:vec3<f32>,observerFootprint:f32)->f32{
 if(c.lighting.w<0.5||c.clouds.z<=0.0||c.clouds.w<=0.0||c.weatherParams.z<=0.0){return 1.0;}
 // Direct body occlusion belongs to skySun; a night surface's ambient light
 // must not be darkened by a second, falsely labelled cloud shadow.
 if(skyPlanetShadows(c,p)){return 1.0;}var optical=0.0;
 for(var layer=0;layer<3;layer++){let settings=skyLayer(c,layer);if(settings.w<0.5||settings.z<=0.0){continue;}
  let outer=skySphere(p,c.sun,1.0+settings.x+settings.y);if(outer.y<=max(0.0,outer.x)){continue;}let inner=skySphere(p,c.sun,1.0+settings.x);
  var segments:array<vec2<f32>,2>;segments[0]=vec2<f32>(max(0.0,outer.x),outer.y);segments[1]=vec2<f32>(1.0,-1.0);
  if(inner.y>inner.x&&inner.x<outer.y&&inner.y>segments[0].x){segments[1]=vec2<f32>(max(segments[0].x,inner.y),outer.y);segments[0].y=min(outer.y,inner.x);}
  for(var part=0;part<2;part++){let begin=segments[part].x;let end=segments[part].y;if(end<=begin){continue;}let count=clamp(i32(c.steps.w),1,4);let feature=skyFeatureMetres(c,layer);let metric=skyRayMetric(c,begin,end,feature);
   for(var index=0;index<count;index++){
    let start=skyRayEdge(c,begin,end,metric,feature,f32(index)/f32(count));let finish=skyRayEdge(c,begin,end,metric,feature,f32(index+1)/f32(count));let stepRay=finish-start;
    let middle=p+c.sun*((start+finish)*0.5);let samplePhase=skyWorldPhase(c,noise,ns,middle,feature);let point=p+c.sun*mix(start,finish,samplePhase);
    var coefficient=2.0;if(layer==0){coefficient=4.0;}else if(layer==1){coefficient=8.0;}optical+=skyCloudLayer(c,noise,ns,weather,ws,circulationCoverage,circulationEnvironment,cs,point,max(stepRay*c.geometry.x*0.5,observerFootprint),layer)*coefficient*stepRay/settings.y;
   }
  }if(optical>12.0){break;}
 }return exp(-min(80.0,optical));
}
fn skyHG(cosine:f32,g:f32)->f32{return (1.0-g*g)/(4.0*3.141592653589793*pow(max(0.001,1.0+g*g-2.0*g*cosine),1.5));}
fn skyIntegrate(c:SkyConfig,noise:texture_3d<f32>,ns:sampler,weather:texture_3d<f32>,ws:sampler,circulationCoverage:texture_2d<f32>,circulationEnvironment:texture_2d<f32>,cs:sampler,origin:vec3<f32>,direction:vec3<f32>,rayStart:f32,rayEnd:f32,requested:i32,cloudLayer:i32,phase:vec3<f32>,initial:mat4x4<f32>)->mat4x4<f32>{
 let cloudSegment=cloudLayer>=0;
 if(rayEnd<=rayStart||(!cloudSegment&&c.details.w<0.5)||max(initial[1].r,max(initial[1].g,initial[1].b))<0.01){return initial;}
 var radiance=initial[0].rgb;var transmission=initial[1].rgb;
 let count=clamp(requested,1,32);var feature=1.0;var metric=0.0;
 if(cloudSegment){feature=skyFeatureMetres(c,cloudLayer);metric=skyRayMetric(c,rayStart,rayEnd,feature);}
 for(var index=0;index<count;index++){if(max(transmission.r,max(transmission.g,transmission.b))<0.01){break;}
  var begin=mix(rayStart,rayEnd,f32(index)/f32(count));var end=mix(rayStart,rayEnd,f32(index+1)/f32(count));
  if(cloudSegment){begin=skyRayEdge(c,rayStart,rayEnd,metric,feature,f32(index)/f32(count));end=skyRayEdge(c,rayStart,rayEnd,metric,feature,f32(index+1)/f32(count));}
  let stepMetres=(end-begin)*c.geometry.x;let middle=origin+direction*((begin+end)*0.5);var samplePhase=0.5;
  if(cloudSegment){samplePhase=skyWorldPhase(c,noise,ns,middle,feature);}
  let distance=mix(begin,end,samplePhase);let p=origin+direction*distance;let air=skyAir(c,p);let rayleigh=c.rayleigh*air.x;let mie=c.atmosphere.w*air.y;
  let footprint=2.0*abs(c.projectionInverse[1][1])*distance*c.geometry.x/max(1.0,c.dimensions.w);
  var cloud=0.0;if(cloudSegment){cloud=skyCloudExtinction(c,noise,ns,weather,ws,circulationCoverage,circulationEnvironment,cs,p,max(footprint,stepMetres*0.5));}
  let extinction=rayleigh+vec3<f32>(mie+cloud);var shadow=1.0;
  if(cloudSegment||c.effects.y>0.0){var shadowFootprint=footprint;if(cloudSegment){shadowFootprint=max(footprint,stepMetres*0.5);}shadow=skyCloudSun(c,noise,ns,weather,ws,circulationCoverage,circulationEnvironment,cs,p,shadowFootprint);}if(!cloudSegment){shadow=mix(1.0,shadow,c.effects.y);}
  let incoming=skySun(c,p)*shadow*c.lighting.y;var source=incoming*(rayleigh*phase.x+vec3<f32>(mie*phase.y+cloud*phase.z));
  let daylight=smoothstep(-0.16,0.2,dot(normalize(p),c.sun));source+=vec3<f32>(0.78,0.87,1.0)*(cloud*c.lighting.y*0.035*daylight);
  let segment=exp(-min(vec3<f32>(80.0),extinction*stepMetres));let integral=(vec3<f32>(1.0)-segment)/max(extinction,vec3<f32>(0.000000001));radiance+=transmission*source*integral;transmission*=segment;
 }
 return mat4x4<f32>(vec4<f32>(radiance,1.0),vec4<f32>(transmission,0.0),vec4<f32>(0.0),vec4<f32>(0.0));
}
${planetWeatherCoverageWGSL}
`;

/** Full-resolution celestial sources. They are composed before optical RGB
 * transmission, so clouds and the atmosphere extinguish both discs and stars.
 * No screen derivatives are evaluated inside depth-dependent branches. */
export const planetSkyWebGPUCelestialWGSL=/* wgsl */`
fn skyStarHash(cell:vec2<i32>,salt:u32)->vec4<f32>{
  var value=((u32(cell.x)*1597334677u)^(u32(cell.y)*3812015801u))^(salt*2246822519u);
  value=(value^(value>>16u))*2146121005u;value=(value^(value>>15u))*2221713035u;value=value^(value>>16u);
  let a=value;
  value=(value^(value>>16u))*2146121005u;let b=value;
  value=(value^(value>>15u))*2221713035u;let c=value;
  value=value^(value>>16u);let d=value;
  return vec4<f32>(f32(a&65535u),f32(b&65535u),f32(c&65535u),f32(d&65535u))/65535.0;
}
fn skyCelestialBody(origin:vec3<f32>,direction:vec3<f32>)->bool{
  let along=dot(origin,direction);let perpendicular=cross(origin,direction);let square=1.0-dot(perpendicular,perpendicular);
  return square>=0.0&&-along-sqrt(max(0.0,square))>0.0;
}
fn skyCelestialSources(direction:vec3<f32>,origin:vec3<f32>,sun:vec3<f32>,projectionInverse:mat4x4<f32>,dimensions:vec4<f32>,
  celestial:vec4<f32>,stars:vec4<f32>,clock:vec4<f32>,effects:vec4<f32>,visibility:vec3<f32>)->vec3<f32>{
  if(skyCelestialBody(origin,direction)){return vec3<f32>(0.0);}
  let pixelAngle=2.0*abs(projectionInverse[1][1])/max(1.0,dimensions.y);
  var result=vec3<f32>(0.0);
  if(celestial.x>0.5&&dot(direction,sun)>0.0){
    let separation=length(cross(direction,sun));let radius=max(0.00001,celestial.y);
    let disc=1.0-smoothstep(max(0.0,radius-pixelAngle),radius+pixelAngle,separation);
    let glow=exp(-separation*separation/(radius*radius*36.0))*celestial.z*0.12;
    result+=vec3<f32>(1.0,0.965,0.89)*(disc*24.0+glow);
  }
  if(stars.x<0.5||stars.y<=0.0||stars.z<=0.0||max(visibility.r,max(visibility.g,visibility.b))<0.0001){return result;}
  let up=normalize(origin);let outside=smoothstep(1.0+effects.z,1.0+effects.z*2.0,length(origin));
  let night=mix(1.0-smoothstep(-0.15,0.08,dot(up,sun)),1.0,outside);
  if(night<0.0001){return result;}
  let rotation=clock.y;let cr=cos(rotation);let sr=sin(rotation);
  let ray=vec3<f32>(cr*direction.x+sr*direction.z,direction.y,-sr*direction.x+cr*direction.z);
  let starUv=vec2<f32>(atan2(ray.x,ray.z)/6.283185307179586+0.5,acos(clamp(ray.y,-1.0,1.0))/3.141592653589793);
  let grid=vec2<f32>(512.0,256.0);let center=vec2<i32>(floor(starUv*grid));
  let vertical=max(0.02,dot(direction,up));let horizon=pow(1.0-clamp(vertical,0.0,1.0),3.0)*(1.0-outside);
  let atmosphericDim=mix(exp(-0.06*(1.0/vertical-1.0)),1.0,outside);
  let width=max(0.00012,pixelAngle*0.65);let salt=u32(clock.w)^(u32(clock.z)<<16u);
  for(var dy=-1;dy<=1;dy++){for(var dx=-1;dx<=1;dx++){
    let cell=vec2<i32>((center.x+dx+512)%512,clamp(center.y+dy,0,255));
    let random=skyStarHash(cell,salt);let colat=(f32(cell.y)+random.y)/256.0*3.141592653589793;
    if(random.w>stars.y*0.045*sin(colat)){continue;}
    let longitude=((f32(cell.x)+random.x)/512.0-0.5)*6.283185307179586;
    let starDirection=vec3<f32>(sin(longitude)*sin(colat),cos(colat),cos(longitude)*sin(colat));
    if(dot(starDirection,ray)<0.0){continue;}
    let angle=length(cross(starDirection,ray));let point=exp(-angle*angle/(width*width));
    let flicker=1.0+stars.w*(1.0-outside)*(0.06+horizon*0.54)*(sin(clock.x*(8.0+random.x*5.0)+random.z*90.0)*0.7+sin(clock.x*17.0+random.y*70.0)*0.3);
    let color=mix(vec3<f32>(1.0,0.73,0.48),vec3<f32>(0.64,0.79,1.0),random.z);
    let brightness=(0.45+pow(random.z,7.0)*5.0)*stars.z;
    result+=color*(point*brightness*night*atmosphericDim*max(0.0,flicker));
  }}
  return result;
}
`;

export const planetSkyWebGPUCompositeWGSL=/* wgsl */`
fn planetSkyComposite(uvIn:vec2<f32>,sceneColor:texture_2d<f32>,sceneSampler:sampler,
  sceneDepth:texture_depth_2d,radianceTexture:texture_2d<f32>,transmissionTexture:texture_2d<f32>,
  geometry:vec4<f32>,dimensions:vec4<f32>,style:vec4<f32>,projectionInverse:mat4x4<f32>,cameraRotation:mat4x4<f32>,cameraRadius:vec3<f32>,sunDirection:vec3<f32>,celestial:vec4<f32>,stars:vec4<f32>,clock:vec4<f32>,effects:vec4<f32>)->vec4<f32>{
  var uv=uvIn;
  if(style.x>0.5){uv=clamp((floor(uv*dimensions.xy/max(1.0,style.y))+0.5)*max(1.0,style.y)/dimensions.xy,vec2<f32>(0.0),vec2<f32>(1.0));}
  let color=textureSampleLevel(sceneColor,sceneSampler,uv,0.0);
  let fullTexel=vec2<i32>(clamp(floor(uv*dimensions.xy),vec2<f32>(0.0),dimensions.xy-1.0));
  let actualDepth=textureLoad(sceneDepth,fullTexel,0);
  let tolerance=skyDepthTolerance(sceneDepth,fullTexel,actualDepth,geometry,dimensions);
  var radiance=vec3<f32>(0.0);
  var transmission=vec3<f32>(0.0);
  var surfaceVisibility=0.0;
  var totalWeight=0.0;
  if(style.x>0.5||style.w==6.0){
    let texel=vec2<i32>(clamp(floor(uv*dimensions.zw),vec2<f32>(0.0),dimensions.zw-1.0));
    let candidate=textureLoad(transmissionTexture,texel,0);
    totalWeight=skyCompatibleDepth(actualDepth,candidate.a,geometry,style.w,tolerance);
    let light=textureLoad(radianceTexture,texel,0);radiance=light.rgb*totalWeight;surfaceVisibility=light.a*totalWeight;
    transmission=candidate.rgb*totalWeight;
  }else{
    let pixel=uv*dimensions.zw-0.5;
    let base=floor(pixel);
    let fraction=fract(pixel);
    for(var y=0;y<2;y++){for(var x=0;x<2;x++){
      let offset=vec2<f32>(f32(x),f32(y));
      let texel=vec2<i32>(clamp(base+offset,vec2<f32>(0.0),dimensions.zw-1.0));
      let candidate=textureLoad(transmissionTexture,texel,0);
      let factors=mix(vec2<f32>(1.0)-fraction,fraction,offset);
      let weight=factors.x*factors.y*skyCompatibleDepth(actualDepth,candidate.a,geometry,style.w,tolerance);
      let light=textureLoad(radianceTexture,texel,0);radiance+=light.rgb*weight;surfaceVisibility+=light.a*weight;
      transmission+=candidate.rgb*weight;
      totalWeight+=weight;
    }}
  }
  if(totalWeight>0.00001){radiance/=totalWeight;transmission/=totalWeight;surfaceVisibility/=totalWeight;}
  else{
    let fallback=skyConservativeTransport(uv,actualDepth,geometry,dimensions,radianceTexture,transmissionTexture);
    if(fallback.valid){radiance=fallback.radiance;transmission=fallback.transmission;surfaceVisibility=fallback.visibility;}
    else{radiance=vec3<f32>(0.0);transmission=vec3<f32>(1.0);surfaceVisibility=1.0;}
  }
  var source=color.rgb*surfaceVisibility;
  if(actualDepth>=0.9999999){
    let projected=projectionInverse*vec4<f32>(uv.x*2.0-1.0,1.0-uv.y*2.0,0.5,1.0);
    let ray=normalize((cameraRotation*vec4<f32>(normalize(projected.xyz/projected.w),0.0)).xyz);
    source=skyCelestialSources(ray,cameraRadius,sunDirection,projectionInverse,dimensions,celestial,stars,clock,effects,transmission);
  }
  var result=vec4<f32>(max(vec3<f32>(0.0),source*transmission+radiance),color.a);
  let diagnosticMode=i32(style.w);
  let diagnosticTexel=vec2<i32>(clamp(floor(uv*dimensions.zw),vec2<f32>(0.0),dimensions.zw-1.0));
  if(diagnosticMode==1){result=color;}
  if(diagnosticMode==2){result=vec4<f32>(textureLoad(radianceTexture,diagnosticTexel,0).rgb,1.0);}
  if(diagnosticMode==3){result=vec4<f32>(vec3<f32>(1.0)-textureLoad(transmissionTexture,diagnosticTexel,0).rgb,1.0);}
  if(diagnosticMode==4){result=vec4<f32>(vec3<f32>(select(0.0,1.0,totalWeight>0.00001)),1.0);}
  if(diagnosticMode==7){result=vec4<f32>(vec3<f32>(surfaceVisibility),1.0);}
  return result;
}
fn skyCompositeViewDepth(depth:f32,g:vec4<f32>)->f32{
  if(g.w>0.5){return g.y*exp2(depth*log2(g.z/g.y));}
  return g.y*g.z/max(0.0000001,g.z-depth*(g.z-g.y));
}
fn skyDepthNeighbour(depthTexture:texture_depth_2d,texel:vec2<i32>,g:vec4<f32>,dimensions:vec4<f32>)->f32{
  let depth=textureLoad(depthTexture,clamp(texel,vec2<i32>(0),vec2<i32>(dimensions.xy)-1),0);
  if(depth>=0.9999999){return -1.0;}
  return skyCompositeViewDepth(depth,g)/g.x;
}
fn skyContinuousSlope(expected:f32,before:f32,after:f32)->f32{
  if(before<0.0||after<0.0){return 0.0;}
  let left=expected-before;
  let right=after-expected;
  if(left*right<=0.0){return 0.0;}
  return min(abs(left),abs(right));
}
fn skyDepthTolerance(depthTexture:texture_depth_2d,texel:vec2<i32>,depth:f32,g:vec4<f32>,dimensions:vec4<f32>)->f32{
  if(depth>=0.9999999){return 0.0;}
  let expected=skyCompositeViewDepth(depth,g)/g.x;
  let sx=skyContinuousSlope(expected,skyDepthNeighbour(depthTexture,texel-vec2<i32>(1,0),g,dimensions),skyDepthNeighbour(depthTexture,texel+vec2<i32>(1,0),g,dimensions));
  let sy=skyContinuousSlope(expected,skyDepthNeighbour(depthTexture,texel-vec2<i32>(0,1),g,dimensions),skyDepthNeighbour(depthTexture,texel+vec2<i32>(0,1),g,dimensions));
  let footprint=2.0*dot(vec2<f32>(sx,sy),dimensions.xy/dimensions.zw);
  return max(max(1.0/g.x,expected*0.03),footprint);
}
fn skyCompatibleDepth(actual:f32,candidate:f32,g:vec4<f32>,diagnosticMode:f32,tolerance:f32)->f32{
  if(diagnosticMode==5.0||diagnosticMode==6.0){return 1.0;}
  let emptyActual=actual>=0.9999999;
  let emptyCandidate=candidate<0.0;
  if(emptyActual||emptyCandidate){return select(0.0,1.0,emptyActual&&emptyCandidate);}
  let expected=skyCompositeViewDepth(actual,g)/g.x;
  let difference=abs(candidate-expected);
  if(difference>tolerance){return 0.0;}
  return exp(-difference/max(0.000000001,tolerance*0.35));
}
struct SkyConservativeResult{radiance:vec3<f32>,transmission:vec3<f32>,visibility:f32,valid:bool}
fn skyConservativeTransport(uv:vec2<f32>,actualDepth:f32,g:vec4<f32>,dimensions:vec4<f32>,radianceTexture:texture_2d<f32>,transmissionTexture:texture_2d<f32>)->SkyConservativeResult{
  let emptyActual=actualDepth>=0.9999999;var skyOnly=false;var expected=0.0;
  if(!emptyActual){expected=skyCompositeViewDepth(actualDepth,g)/g.x;}
  let center=vec2<i32>(clamp(floor(uv*dimensions.zw),vec2<f32>(0.0),dimensions.zw-1.0));
  var radiance=vec3<f32>(0.0);var transmission=vec3<f32>(0.0);var visibility=0.0;var total=0.0;
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
    let texel=clamp(center+vec2<i32>(x,y),vec2<i32>(0),vec2<i32>(dimensions.zw)-1);
    let path=textureLoad(transmissionTexture,texel,0);let emptyCandidate=path.a<0.0;
    // Never introduce a cloud path behind a finite foreground object.
    if(!emptyActual&&(emptyCandidate||path.a>expected)){continue;}
    if(emptyActual){
      if(skyOnly&&!emptyCandidate){continue;}
      if(emptyCandidate&&!skyOnly){skyOnly=true;total=0.0;radiance=vec3<f32>(0.0);transmission=vec3<f32>(0.0);visibility=0.0;}
    }
    let delta=vec2<f32>(texel)+0.5-uv*dimensions.zw;let weight=1.0/(0.25+dot(delta,delta));let light=textureLoad(radianceTexture,texel,0);
    radiance+=light.rgb*weight;transmission+=path.rgb*weight;visibility+=light.a*weight;total+=weight;
  }}
  if(total<=0.0){return SkyConservativeResult(vec3<f32>(0.0),vec3<f32>(1.0),1.0,false);}
  return SkyConservativeResult(radiance/total,transmission/total,visibility/total,true);
}
${planetSkyWebGPUCelestialWGSL}
`;

/** Applied after native tone mapping / working-to-output conversion. */
export const planetSkyWebGPUPaletteWGSL=/* wgsl */`
fn planetSkyPalette(color:vec4<f32>,style:vec4<f32>)->vec4<f32>{
  if(style.x<0.5){return color;}
  let levels=max(1.0,style.z-1.0);
  return vec4<f32>(floor(clamp(color.rgb,vec3<f32>(0.0),vec3<f32>(1.0))*levels+0.5)/levels,color.a);
}
`;
