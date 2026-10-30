import {planetWeatherCoverageWGSL} from '../shared/planetWeather.ts';
import {PLANET_ATMOSPHERE_OPTICS} from '../shared/planetAtmosphereSnapshot.ts';

/** Engine-owned native WGSL. Positions are planet-radius relative, and scene
 * depth uses Three's native WebGPU (including its distinct logarithmic) curve.
 * The two output columns carry RGB radiance and RGB transmission + linear depth.
 * Validated loop budgets keep every quality preset bounded on the GPU. */
export const planetSkyWebGPUVolumeWGSL=/* wgsl */`
fn planetSkyVolume(
 uvIn:vec2<f32>,sceneDepth:texture_depth_2d,noise:texture_3d<f32>,noiseSampler:sampler,weather:texture_3d<f32>,weatherSampler:sampler,
 circulationCoverage:texture_2d<f32>,circulationEnvironment:texture_2d<f32>,circulationSampler:sampler,
 snapshotCondensate0:texture_2d<f32>,snapshotCondensate1:texture_2d<f32>,snapshotLower0:texture_2d<f32>,snapshotLower1:texture_2d<f32>,snapshotUpper0:texture_2d<f32>,snapshotUpper1:texture_2d<f32>,snapshotAltitude0:texture_2d<f32>,snapshotAltitude1:texture_2d<f32>,snapshotParams:vec4<f32>,
 projectionInverse:mat4x4<f32>,cameraRotation:mat4x4<f32>,cameraRadius:vec3<f32>,sunDirection:vec3<f32>,rayleigh:vec3<f32>,
 shapeWind:vec3<f32>,detailWind:vec3<f32>,geometry:vec4<f32>,atmosphere:vec4<f32>,lighting:vec4<f32>,clouds:vec4<f32>,
 details:vec4<f32>,steps:vec4<f32>,dimensions:vec4<f32>,style:vec4<f32>,effects:vec4<f32>,
 fogLayer:vec4<f32>,cumulusLayer:vec4<f32>,cirrusLayer:vec4<f32>,weatherParams:vec4<f32>,condensationThreshold:f32,weatherEvolutionPhase:f32,
 stormCenters0:mat4x4<f32>,stormCenters1:mat4x4<f32>,stormCenters2:mat4x4<f32>,stormCenters3:mat4x4<f32>,
 stormProperties0:mat4x4<f32>,stormProperties1:mat4x4<f32>,stormProperties2:mat4x4<f32>,stormProperties3:mat4x4<f32>
)->mat4x4<f32>{
 let centers=array<vec4<f32>,16>(stormCenters0[0],stormCenters0[1],stormCenters0[2],stormCenters0[3],stormCenters1[0],stormCenters1[1],stormCenters1[2],stormCenters1[3],stormCenters2[0],stormCenters2[1],stormCenters2[2],stormCenters2[3],stormCenters3[0],stormCenters3[1],stormCenters3[2],stormCenters3[3]);
 let properties=array<vec4<f32>,16>(stormProperties0[0],stormProperties0[1],stormProperties0[2],stormProperties0[3],stormProperties1[0],stormProperties1[1],stormProperties1[2],stormProperties1[3],stormProperties2[0],stormProperties2[1],stormProperties2[2],stormProperties2[3],stormProperties3[0],stormProperties3[1],stormProperties3[2],stormProperties3[3]);
 let c=SkyConfig(geometry,atmosphere,lighting,clouds,details,steps,dimensions,projectionInverse,rayleigh,sunDirection,shapeWind,detailWind,fogLayer,cumulusLayer,cirrusLayer,effects,weatherParams,condensationThreshold,weatherEvolutionPhase,snapshotParams,centers,properties);
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
  if(snapshotParams.x>0.5){let turn=-dot(cameraRadius,direction);if(turn>rayStart&&turn<rayEnd){cuts[cutCount]=turn;cutCount++;}}
  var layerCount=3;if(snapshotParams.x>0.5){layerCount=i32(snapshotParams.w);}
  if(lighting.w>0.5&&(snapshotParams.x>0.5||(clouds.z>0.0&&clouds.w>0.0&&weatherParams.z>0.0))){for(var layer=0;layer<layerCount;layer++){
   let settings=skyLayer(c,layer);if(settings.w<0.5||(snapshotParams.x<0.5&&settings.z<=0.0)){continue;}
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
   transport=skyIntegrate(c,noise,noiseSampler,weather,weatherSampler,circulationCoverage,circulationEnvironment,circulationSampler,snapshotCondensate0,snapshotCondensate1,snapshotLower0,snapshotLower1,snapshotUpper0,snapshotUpper1,snapshotAltitude0,snapshotAltitude1,cameraRadius,direction,begin,end,count,cloudLayer,phase,transport);
  }
 }
 var linearDepth=-1.0;var surfaceVisibility=1.0;
 if(depth<0.9999999){linearDepth=skyViewDepth(depth,geometry)/geometry.x;if(effects.x>0.0){
  let distanceRay=linearDepth/max(0.000001,-viewDirection.z);let p=cameraRadius+direction*distanceRay;
  let observerFootprint=2.0*abs(projectionInverse[1][1])*distanceRay*geometry.x/max(1.0,dimensions.w);
  let visible=skyCloudSun(c,noise,noiseSampler,weather,weatherSampler,circulationCoverage,circulationEnvironment,circulationSampler,snapshotCondensate0,snapshotCondensate1,snapshotLower0,snapshotLower1,snapshotUpper0,snapshotUpper1,snapshotAltitude0,snapshotAltitude1,p,observerFootprint);
  surfaceVisibility=mix(1.0,0.25+0.75*visible,effects.x);
 }}
 return mat4x4<f32>(vec4<f32>(max(vec3<f32>(0.0),transport[0].rgb),surfaceVisibility),vec4<f32>(clamp(transport[1].rgb,vec3<f32>(0.0),vec3<f32>(1.0)),linearDepth),vec4<f32>(0.0),vec4<f32>(0.0));
}
struct SkyConfig{
 geometry:vec4<f32>,atmosphere:vec4<f32>,lighting:vec4<f32>,clouds:vec4<f32>,details:vec4<f32>,steps:vec4<f32>,dimensions:vec4<f32>,
 projectionInverse:mat4x4<f32>,rayleigh:vec3<f32>,sun:vec3<f32>,shapeWind:vec3<f32>,detailWind:vec3<f32>,
 fogLayer:vec4<f32>,cumulusLayer:vec4<f32>,cirrusLayer:vec4<f32>,effects:vec4<f32>,weatherParams:vec4<f32>,condensationThreshold:f32,weatherEvolutionPhase:f32,snapshotParams:vec4<f32>,stormCenters:array<vec4<f32>,16>,stormProperties:array<vec4<f32>,16>
}
fn skySphere(origin:vec3<f32>,direction:vec3<f32>,radius:f32)->vec2<f32>{
 let along=dot(origin,direction);let perpendicular=cross(origin,direction);let square=radius*radius-dot(perpendicular,perpendicular);
 if(square<0.0){return vec2<f32>(1.0,-1.0);}let extent=sqrt(max(0.0,square));return vec2<f32>(-along-extent,-along+extent);
}
fn skyViewDepth(depth:f32,g:vec4<f32>)->f32{if(g.w>0.5){return g.y*exp2(depth*log2(g.z/g.y));}return g.y*g.z/max(0.0000001,g.z-depth*(g.z-g.y));}
fn skyLayer(c:SkyConfig,index:i32)->vec4<f32>{if(index==0){return c.fogLayer;}if(index==1){return c.cumulusLayer;}return c.cirrusLayer;}
fn skyCloudLayerIndex(c:SkyConfig,p:vec3<f32>)->i32{
 if(c.lighting.w<0.5||(c.snapshotParams.x<0.5&&(c.clouds.z<=0.0||c.clouds.w<=0.0||c.weatherParams.z<=0.0))){return -1;}let altitude=length(p)-1.0;var selected=-1;
 var layerCount=3;if(c.snapshotParams.x>0.5){layerCount=i32(c.snapshotParams.w);}
 for(var index=0;index<layerCount;index++){let layer=skyLayer(c,index);if(layer.w>0.5&&(c.snapshotParams.x>0.5||layer.z>0.0)&&altitude>=layer.x&&altitude<=layer.x+layer.y){if(selected<0||skyFeatureMetres(c,index)<skyFeatureMetres(c,selected)){selected=index;}}}return selected;
}
fn skyWeather(c:SkyConfig,weather:texture_3d<f32>,ws:sampler,circulationCoverage:texture_2d<f32>,circulationEnvironment:texture_2d<f32>,cs:sampler,p:vec3<f32>)->PlanetWeatherState{
 var state=planetWeatherState(circulationCoverage,circulationEnvironment,cs,normalize(p),c.sun,c.weatherParams.x,c.stormCenters,c.stormProperties,i32(c.weatherParams.y),c.weatherParams.z,c.weatherParams.w,c.condensationThreshold,c.geometry.x);
 state.coverage=clamp(state.coverage*(textureSampleLevel(weather,ws,p/2.2+0.5,0.0).r*2.0),vec3<f32>(0.0),vec3<f32>(1.0));
 return state;
}
fn skySnapshotBilinear(field:texture_2d<f32>,direction:vec3<f32>)->vec4<f32>{
 let d=normalize(direction);let dimensions=vec2<i32>(textureDimensions(field));
 let uv=vec2<f32>(atan2(d.x,d.z)/6.283185307179586+0.5,asin(clamp(d.y,-1.0,1.0))/3.141592653589793+0.5);
 let point=uv*vec2<f32>(dimensions)-0.5;let base=vec2<i32>(floor(point));let fraction=fract(point);var result=vec4<f32>(0.0);
 for(var y=0;y<2;y++){for(var x=0;x<2;x++){
  let wrapped=((base.x+x)%dimensions.x+dimensions.x)%dimensions.x;let texel=vec2<i32>(wrapped,clamp(base.y+y,0,dimensions.y-1));
  let offset=vec2<f32>(f32(x),f32(y));let factors=mix(vec2<f32>(1.0)-fraction,fraction,offset);
  result+=textureLoad(field,texel,0)*(factors.x*factors.y);
 }}return result;
}
fn skySnapshotUnit(value:vec3<f32>,fallback:vec3<f32>)->vec3<f32>{
 if(dot(value,value)<=1e-8){return normalize(fallback);}return normalize(value);
}
fn skySnapshotLabel(previous:vec4<f32>,current:vec4<f32>,alpha:f32,direction:vec3<f32>)->vec3<f32>{
 return skySnapshotUnit(mix(skySnapshotUnit(previous.xyz,direction),skySnapshotUnit(current.xyz,direction),alpha),direction);
}
struct SkyAtmosphereCloudColumn{mass:vec4<f32>,lower:vec4<f32>,upper:vec4<f32>,altitude:vec4<f32>}
fn skySnapshotMass(c:SkyConfig,previous:texture_2d<f32>,current:texture_2d<f32>,p:vec3<f32>)->vec4<f32>{
 if(c.snapshotParams.x<0.5||c.snapshotParams.z<0.5){return vec4<f32>(0.0);}let direction=normalize(p);return max(vec4<f32>(0.0),mix(skySnapshotBilinear(previous,direction),skySnapshotBilinear(current,direction),c.snapshotParams.y));
}
fn skySnapshotColumn(c:SkyConfig,snapshotCondensate0:texture_2d<f32>,snapshotCondensate1:texture_2d<f32>,snapshotLower0:texture_2d<f32>,snapshotLower1:texture_2d<f32>,snapshotUpper0:texture_2d<f32>,snapshotUpper1:texture_2d<f32>,snapshotAltitude0:texture_2d<f32>,snapshotAltitude1:texture_2d<f32>,p:vec3<f32>)->SkyAtmosphereCloudColumn{
 let direction=normalize(p);let emptyMaterial=vec4<f32>(direction,0.0);
 if(c.snapshotParams.z<0.5){return SkyAtmosphereCloudColumn(vec4<f32>(0.0),emptyMaterial,emptyMaterial,vec4<f32>(0.0));}
 let alpha=c.snapshotParams.y;
 let mass=max(vec4<f32>(0.0),mix(skySnapshotBilinear(snapshotCondensate0,direction),skySnapshotBilinear(snapshotCondensate1,direction),alpha));
 let lower0=skySnapshotBilinear(snapshotLower0,direction);let lower1=skySnapshotBilinear(snapshotLower1,direction);let upper0=skySnapshotBilinear(snapshotUpper0,direction);let upper1=skySnapshotBilinear(snapshotUpper1,direction);
 let lower=vec4<f32>(skySnapshotLabel(lower0,lower1,alpha,direction),mix(lower0.a,lower1.a,alpha));let upper=vec4<f32>(skySnapshotLabel(upper0,upper1,alpha,direction),mix(upper0.a,upper1.a,alpha));
 let moments=mix(skySnapshotBilinear(snapshotAltitude0,direction),skySnapshotBilinear(snapshotAltitude1,direction),alpha);
 let lowerMass=mass.x+lower.a;let upperMass=mass.y+mass.z;var lowerBounds=vec2<f32>(0.0);var upperBounds=vec2<f32>(0.0);
 if(lowerMass>0.0){lowerBounds=moments.xy/lowerMass;}if(upperMass>0.0){upperBounds=moments.zw/upperMass;}
 return SkyAtmosphereCloudColumn(mass,lower,upper,vec4<f32>(lowerBounds,upperBounds));
}
fn skySnapshotDust(c:SkyConfig,previous:texture_2d<f32>,current:texture_2d<f32>,p:vec3<f32>)->f32{
 if(c.details.w<0.5||c.snapshotParams.x<0.5||c.snapshotParams.z<0.5){return 0.0;}
 let mass=mix(skySnapshotBilinear(previous,p).a,skySnapshotBilinear(current,p).a,c.snapshotParams.y);if(mass<=0.0){return 0.0;}
 let altitude=max(0.0,(length(p)-1.0)*c.geometry.x);let top=c.atmosphere.x*c.geometry.x;
 let height=max(0.01,c.atmosphere.y);let normalization=height*max(0.000001,1.0-exp(-top/height));
 return ${PLANET_ATMOSPHERE_OPTICS.dustExtinctionM2Kg.toFixed(2)}*mass*exp(-altitude/height)/normalization;
}
fn skyMorph(c:SkyConfig,metres:vec3<f32>)->vec3<f32>{
 let evolution=c.weatherEvolutionPhase;let q=metres/c.details.y*0.35;
 return metres+sin(q.yzx+0.6*sin(q.zxy+vec3<f32>(evolution,-evolution,evolution)))*(c.details.y*0.28);
}
fn skyFeatureMetres(c:SkyConfig,index:i32)->f32{
 let thickness=skyLayer(c,index).y*c.geometry.x;var shape=c.details.y;if((c.snapshotParams.x>0.5&&index==1)||(c.snapshotParams.x<0.5&&index==2)){shape=min(c.details.y*0.22,thickness/4.0);}
 return max(c.geometry.x/6371000.0,min(shape*0.25,thickness*0.125));
}
fn skyLog1p(value:f32)->f32{if(value<0.01){return value*(1.0+value*(-0.5+value/3.0));}return log(1.0+value);}
fn skyExpm1(value:f32)->f32{if(value<0.01){return value*(1.0+value*(0.5+value/6.0));}return exp(value)-1.0;}
fn skyOneMinusExp(value:f32)->f32{if(value<0.01){return value*(1.0+value*(-0.5+value/6.0));}return 1.0-exp(-value);}
fn skyOpticalSourceFraction(tau:f32,slope:f32)->f32{
 if(tau<=0.0){return 0.5;}
 if(tau<0.01&&abs((1.0+slope)*tau)<0.01){return clamp(0.5-(2.0+slope)*tau/24.0,0.0,1.0);}
 if(abs(slope)<0.001){var mean=tau*(0.5-tau/12.0);if(tau>=0.01){mean=1.0-tau*exp(-tau)/skyOneMinusExp(tau);}return clamp(mean/tau,0.0,1.0);}
 let rate=1.0+slope;let exponent=rate*tau;var logIntegral=0.0;
 if(abs(exponent)<0.01){logIntegral=log(tau)-exponent*0.5+exponent*exponent/24.0;}
 else if(rate>0.0){logIntegral=log(skyOneMinusExp(exponent))-log(rate);}
 else{logIntegral=-exponent+log(skyOneMinusExp(-exponent))-log(-rate);}
 return clamp(-(logIntegral-log(skyOneMinusExp(tau)))/(slope*tau),0.0,1.0);
}
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
fn skyPhysicalCloudProfile(h:f32,upper:bool)->f32{
 if(h<=0.0||h>=1.0){return 0.0;}
 if(upper){return smoothstep(0.0,0.18,h)*(1.0-smoothstep(0.65,1.0,h))/0.735;}
 return smoothstep(0.0,0.08,h)*(1.0-smoothstep(0.55,1.0,h))/0.735;
}
fn skyPhysicalCloudMicro(c:SkyConfig,noise:texture_3d<f32>,ns:sampler,p:vec3<f32>,footprint:f32,index:i32,column:SkyAtmosphereCloudColumn)->f32{
 let cirrus=index==1;var bounds=column.altitude.xy;if(cirrus){bounds=column.altitude.zw;}
 let altitude=(length(p)-1.0)*c.geometry.x;let thickness=bounds.y-bounds.x;
 var flow=column.lower.xyz;if(cirrus){flow=column.upper.xyz;}
 let h=(altitude-bounds.x)/thickness;let metres=skyMorph(c,flow*(length(p)*c.geometry.x));var filterScale=c.details.y;if(cirrus){filterScale=min(c.details.y*0.22,thickness/4.0);}
 let shapeLod=clamp(log2(max(1.0,footprint/filterScale)),0.0,5.0);let detailLod=clamp(log2(max(1.0,footprint/c.details.z)),0.0,5.0);var shapeUv=metres/(c.details.y*32.0)+c.shapeWind;
 if(cirrus){let direction=normalize(metres);let longitude=atan2(direction.x,direction.z)/6.283185307179586+0.5;let periods=max(1.0,floor(6.283185307179586*c.geometry.x/(c.details.y*32.0*8.0)+0.5));shapeUv=vec3<f32>(longitude*periods,asin(clamp(direction.y,-1.0,1.0))*c.geometry.x/(c.details.y*32.0*0.22),h*0.125)+c.shapeWind;}
 let shape=smoothstep(0.30,0.68,textureSampleLevel(noise,ns,shapeUv,shapeLod).r);let detail=textureSampleLevel(noise,ns,metres/(c.details.z*32.0)+c.detailWind,detailLod).g;
 var erosion=c.details.x;if(cirrus){erosion=0.12;}let micro=shape*(1.0-erosion*(1.0-detail))/(0.5*(1.0-0.5*erosion));
 return micro;
}
fn skyPhysicalCloudOptical(index:i32,column:SkyAtmosphereCloudColumn)->f32{
 if(index==1){return ${PLANET_ATMOSPHERE_OPTICS.liquidExtinctionM2Kg.toFixed(2)}*column.mass.y+${PLANET_ATMOSPHERE_OPTICS.iceExtinctionM2Kg.toFixed(2)}*column.mass.z;}
 return ${PLANET_ATMOSPHERE_OPTICS.liquidExtinctionM2Kg.toFixed(2)}*column.mass.x+${PLANET_ATMOSPHERE_OPTICS.iceExtinctionM2Kg.toFixed(2)}*column.lower.a;
}
fn skyPhysicalCloudLayer(c:SkyConfig,noise:texture_3d<f32>,ns:sampler,p:vec3<f32>,footprint:f32,index:i32,column:SkyAtmosphereCloudColumn)->f32{
 if(c.lighting.w<0.5||c.snapshotParams.z<0.5||index>1){return 0.0;}
 var bounds=column.altitude.xy;if(index==1){bounds=column.altitude.zw;}
 let altitude=(length(p)-1.0)*c.geometry.x;let thickness=bounds.y-bounds.x;
 if(thickness<=0.0||altitude<=column.upper.a||altitude<=bounds.x||altitude>=bounds.y){return 0.0;}
 let optical=skyPhysicalCloudOptical(index,column);if(optical<=0.0){return 0.0;}
 return optical*skyPhysicalCloudProfile((altitude-bounds.x)/thickness,index==1)*skyPhysicalCloudMicro(c,noise,ns,p,footprint,index,column)/thickness;
}
fn skyPhysicalCloudOverlap(c:SkyConfig,origin:vec3<f32>,direction:vec3<f32>,rayStart:f32,rayEnd:f32,bounds:vec2<f32>,surface:f32)->vec2<f32>{
 if(bounds.y<=max(bounds.x,surface)){return vec2<f32>(1.0,-1.0);}
 let outer=skySphere(origin,direction,1.0+bounds.y/c.geometry.x);var overlap=vec2<f32>(max(rayStart,outer.x),min(rayEnd,outer.y));
 if(outer.y<=outer.x||overlap.y<=overlap.x){return vec2<f32>(1.0,-1.0);}
 let inner=skySphere(origin,direction,1.0+max(bounds.x,surface)/c.geometry.x);
 if(inner.y>inner.x){if((rayStart+rayEnd)*0.5<=-dot(origin,direction)){overlap.y=min(overlap.y,inner.x);}else{overlap.x=max(overlap.x,inner.y);}}
 return overlap;
}
struct SkyPhysicalCloudCuts{values:array<f32,4>,count:i32}
fn skyPhysicalCloudProfileCuts(c:SkyConfig,origin:vec3<f32>,direction:vec3<f32>,overlap:vec2<f32>,bounds:vec2<f32>,upper:bool)->SkyPhysicalCloudCuts{
 var cuts:array<f32,4>;cuts[0]=overlap.x;cuts[1]=overlap.y;var count=2;
 let inward=(overlap.x+overlap.y)*0.5<=-dot(origin,direction);
 for(var knee=0;knee<2;knee++){
  var fraction=0.08;if(knee==1){fraction=0.55;}if(upper){fraction=0.18;if(knee==1){fraction=0.65;}}
  let roots=skySphere(origin,direction,1.0+mix(bounds.x,bounds.y,fraction)/c.geometry.x);var crossing=roots.y;if(inward){crossing=roots.x;}
  if(roots.y>roots.x&&crossing>overlap.x&&crossing<overlap.y){cuts[count]=crossing;count++;}
 }
 for(var index=1;index<count;index++){let value=cuts[index];var at=index;for(var step=0;step<index;step++){if(at<=0){break;}if(cuts[at-1]<=value){break;}cuts[at]=cuts[at-1];at--;}cuts[at]=value;}
 return SkyPhysicalCloudCuts(cuts,count);
}
fn skyPhysicalCloudPieceMean(c:SkyConfig,origin:vec3<f32>,direction:vec3<f32>,overlap:vec2<f32>,bounds:vec2<f32>,upper:bool)->vec2<f32>{
 var sum=0.0;var travelCenter=0.0;let nodes=clamp(i32(c.steps.z),1,4);
 for(var node=0;node<nodes;node++){
   var fraction=0.06943184420297371;var weight=0.1739274225687269;
   if(node==1){fraction=0.33000947820757187;weight=0.3260725774312731;}else if(node==2){fraction=0.6699905217924281;weight=0.3260725774312731;}else if(node==3){fraction=0.9305681557970262;}
   let distance=mix(overlap.x,overlap.y,fraction);let altitude=(length(origin+direction*distance)-1.0)*c.geometry.x;
   let contribution=weight*skyPhysicalCloudProfile((altitude-bounds.x)/(bounds.y-bounds.x),upper);sum+=contribution;travelCenter+=contribution*distance;
 }
 var centre=(overlap.x+overlap.y)*0.5;if(sum>0.0){centre=travelCenter/sum;}return vec2<f32>(sum,centre);
}
fn skyPhysicalCloudProfileMean(c:SkyConfig,origin:vec3<f32>,direction:vec3<f32>,overlap:vec2<f32>,bounds:vec2<f32>,upper:bool)->vec2<f32>{
 let cuts=skyPhysicalCloudProfileCuts(c,origin,direction,overlap,bounds,upper);var sum=0.0;var travelCenter=0.0;
 for(var piece=0;piece<cuts.count-1;piece++){
  let interval=vec2<f32>(cuts.values[piece],cuts.values[piece+1]);let mean=skyPhysicalCloudPieceMean(c,origin,direction,interval,bounds,upper);let contribution=mean.x*(interval.y-interval.x);sum+=contribution;travelCenter+=contribution*mean.y;
 }
 var centre=(overlap.x+overlap.y)*0.5;if(sum>0.0){centre=travelCenter/sum;}return vec2<f32>(sum/(overlap.y-overlap.x),centre);
}
fn skyPhysicalCloudBinLayer(c:SkyConfig,noise:texture_3d<f32>,ns:sampler,origin:vec3<f32>,direction:vec3<f32>,rayStart:f32,rayEnd:f32,footprint:f32,index:i32,column:SkyAtmosphereCloudColumn)->vec2<f32>{
 var bounds=column.altitude.xy;if(index==1){bounds=column.altitude.zw;}let optical=skyPhysicalCloudOptical(index,column);if(optical<=0.0){return vec2<f32>(0.0);}
 let overlap=skyPhysicalCloudOverlap(c,origin,direction,rayStart,rayEnd,bounds,column.upper.a);if(overlap.y<=overlap.x){return vec2<f32>(0.0);}
 let lengthMetres=(overlap.y-overlap.x)*c.geometry.x;let profile=skyPhysicalCloudProfileMean(c,origin,direction,overlap,bounds,index==1);
 let centre=profile.y;let point=origin+direction*centre;let micro=skyPhysicalCloudMicro(c,noise,ns,point,max(footprint,lengthMetres*0.5),index,column);
 return vec2<f32>(optical*lengthMetres*profile.x*micro/(bounds.y-bounds.x),centre);
}
fn skyPhysicalCloudSourceDistance(c:SkyConfig,origin:vec3<f32>,direction:vec3<f32>,rayStart:f32,rayEnd:f32,index:i32,column:SkyAtmosphereCloudColumn,fraction:f32)->f32{
 var bounds=column.altitude.xy;if(index==1){bounds=column.altitude.zw;}
 let overlap=skyPhysicalCloudOverlap(c,origin,direction,rayStart,rayEnd,bounds,column.upper.a);if(overlap.y<=overlap.x){return (rayStart+rayEnd)*0.5;}
 let cuts=skyPhysicalCloudProfileCuts(c,origin,direction,overlap,bounds,index==1);var masses:array<f32,3>;var total=0.0;
 for(var piece=0;piece<cuts.count-1;piece++){let interval=vec2<f32>(cuts.values[piece],cuts.values[piece+1]);masses[piece]=skyPhysicalCloudPieceMean(c,origin,direction,interval,bounds,index==1).x*(interval.y-interval.x);total+=masses[piece];}
 var requestedMass=total*fraction;var prefix=0.0;var selected=cuts.count-2;
 for(var piece=0;piece<cuts.count-1;piece++){if(requestedMass<=prefix+masses[piece]){selected=piece;break;}prefix+=masses[piece];}requestedMass=max(0.0,requestedMass-prefix);
 let interval=vec2<f32>(cuts.values[selected],cuts.values[selected+1]);var lo=interval.x;var hi=interval.y;
 if(requestedMass<=0.0){return interval.x;}if(requestedMass>=masses[selected]){return interval.y;}
 let entryAltitude=(length(origin+direction*lo)-1.0)*c.geometry.x;let entryProfile=skyPhysicalCloudProfile((entryAltitude-bounds.x)/(bounds.y-bounds.x),index==1);
 var point=mix(lo,hi,pow(clamp(requestedMass/max(1e-12,masses[selected]),0.0,1.0),1.0/3.0));if(entryProfile>0.0000001){point=clamp(lo+requestedMass/entryProfile,lo,hi);}let iterations=clamp(i32(c.steps.z),8,10);
 for(var iteration=0;iteration<iterations;iteration++){
  var amount=0.0;if(point>interval.x){amount=skyPhysicalCloudPieceMean(c,origin,direction,vec2<f32>(interval.x,point),bounds,index==1).x*(point-interval.x);}
  let error=requestedMass-amount;if(abs(error)<=max(1e-12,requestedMass*0.00001)){break;}if(error>0.0){lo=point;}else{hi=point;}
  let altitude=(length(origin+direction*point)-1.0)*c.geometry.x;let derivative=skyPhysicalCloudProfile((altitude-bounds.x)/(bounds.y-bounds.x),index==1);let next=point+error/max(derivative,0.0000001);
  if(next>lo&&next<hi){point=next;}else{point=(lo+hi)*0.5;}
 }
 return point;
}
fn skyCloudLayer(c:SkyConfig,noise:texture_3d<f32>,ns:sampler,weather:texture_3d<f32>,ws:sampler,circulationCoverage:texture_2d<f32>,circulationEnvironment:texture_2d<f32>,cs:sampler,snapshotCondensate0:texture_2d<f32>,snapshotCondensate1:texture_2d<f32>,snapshotLower0:texture_2d<f32>,snapshotLower1:texture_2d<f32>,snapshotUpper0:texture_2d<f32>,snapshotUpper1:texture_2d<f32>,snapshotAltitude0:texture_2d<f32>,snapshotAltitude1:texture_2d<f32>,p:vec3<f32>,footprint:f32,index:i32)->f32{
 if(c.snapshotParams.x>0.5){return skyPhysicalCloudLayer(c,noise,ns,p,footprint,index,skySnapshotColumn(c,snapshotCondensate0,snapshotCondensate1,snapshotLower0,snapshotLower1,snapshotUpper0,snapshotUpper1,snapshotAltitude0,snapshotAltitude1,p));}
 let settings=skyLayer(c,index);
 if(c.lighting.w<0.5||settings.w<0.5||c.clouds.z<=0.0||c.clouds.w<=0.0||c.weatherParams.z<=0.0||settings.z<=0.0){return 0.0;}
 let h=(length(p)-1.0-settings.x)/settings.y;if(h<=0.0||h>=1.0){return 0.0;}
 let state=skyWeather(c,weather,ws,circulationCoverage,circulationEnvironment,cs,p);if(state.support<=0.0||state.coverage[index]<=0.0){return 0.0;}let regional=state.coverage[index];let flow=state.flowDirection;
 let metres=skyMorph(c,flow*(length(p)*c.geometry.x));
 var filterScale=c.details.y;if(index==2){filterScale=min(c.details.y*0.22,settings.y*c.geometry.x/4.0);}
 let shapeLod=clamp(log2(max(1.0,footprint/filterScale)),0.0,5.0);let detailLod=clamp(log2(max(1.0,footprint/c.details.z)),0.0,5.0);
 var shapeUv=metres/(c.details.y*32.0)+c.shapeWind;
 if(index==2){let direction=normalize(metres);let longitude=atan2(direction.x,direction.z)/6.283185307179586+0.5;let periods=max(1.0,floor(6.283185307179586*c.geometry.x/(c.details.y*32.0*8.0)+0.5));shapeUv=vec3<f32>(longitude*periods,asin(clamp(direction.y,-1.0,1.0))*c.geometry.x/(c.details.y*32.0*0.22),h*0.125)+c.shapeWind;}
 let shapeNoise=textureSampleLevel(noise,ns,shapeUv,shapeLod);let base=shapeNoise.r;
 let detail=textureSampleLevel(noise,ns,metres/(c.details.z*32.0)+c.detailWind,detailLod).g;
 let shape=smoothstep(0.30,0.68,base);
 let column=skyMorph(c,flow*((1.0+settings.x)*c.geometry.x));var top=shapeNoise.b;
 if(index==1){top=textureSampleLevel(noise,ns,column/(c.details.y*32.0)+c.shapeWind,shapeLod).b;}
 let cumulusHeight=h/(0.55+0.45*top);var height=0.0;
 if(index==0){height=smoothstep(0.0,0.002,h)*exp(-3.0*h)*(1.0-smoothstep(0.65,1.0,h));}else if(index==1){height=smoothstep(0.0,0.08,cumulusHeight)*(1.0-smoothstep(0.55,1.0,cumulusHeight));}else{height=smoothstep(0.0,0.18,h)*(1.0-smoothstep(0.65,1.0,h));}
 var erosion=c.details.x;if(index==2){erosion=0.12;}
 return regional*max(0.0,(shape*height-erosion*(1.0-detail)*0.35)/(1.0-0.35*erosion))*c.clouds.w*settings.z;
}
fn skyCloudExtinction(c:SkyConfig,noise:texture_3d<f32>,ns:sampler,weather:texture_3d<f32>,ws:sampler,circulationCoverage:texture_2d<f32>,circulationEnvironment:texture_2d<f32>,cs:sampler,snapshotCondensate0:texture_2d<f32>,snapshotCondensate1:texture_2d<f32>,snapshotLower0:texture_2d<f32>,snapshotLower1:texture_2d<f32>,snapshotUpper0:texture_2d<f32>,snapshotUpper1:texture_2d<f32>,snapshotAltitude0:texture_2d<f32>,snapshotAltitude1:texture_2d<f32>,p:vec3<f32>,footprint:f32)->f32{
 if(c.snapshotParams.x>0.5){
  if(c.lighting.w<0.5||c.snapshotParams.z<0.5){return 0.0;}
  let column=skySnapshotColumn(c,snapshotCondensate0,snapshotCondensate1,snapshotLower0,snapshotLower1,snapshotUpper0,snapshotUpper1,snapshotAltitude0,snapshotAltitude1,p);
  return skyPhysicalCloudLayer(c,noise,ns,p,footprint,0,column)+skyPhysicalCloudLayer(c,noise,ns,p,footprint,1,column);
 }
 var extinction=0.0;for(var index=0;index<3;index++){let settings=skyLayer(c,index);var coefficient=2.0;if(index==0){coefficient=4.0;}else if(index==1){coefficient=8.0;}let density=skyCloudLayer(c,noise,ns,weather,ws,circulationCoverage,circulationEnvironment,cs,snapshotCondensate0,snapshotCondensate1,snapshotLower0,snapshotLower1,snapshotUpper0,snapshotUpper1,snapshotAltitude0,snapshotAltitude1,p,footprint,index);if(density>0.0){extinction+=density*coefficient/(settings.y*c.geometry.x);}}return extinction;
}
fn skyAir(c:SkyConfig,p:vec3<f32>)->vec2<f32>{if(c.details.w<0.5){return vec2<f32>(0.0);}let altitude=max(0.0,(length(p)-1.0)*c.geometry.x);return exp(-altitude/c.atmosphere.yz);}
fn skyPlanetShadows(c:SkyConfig,p:vec3<f32>)->bool{let body=skySphere(p,c.sun,1.0);return body.y>0.0000001&&body.x>0.0000001;}
fn skySun(c:SkyConfig,snapshotCondensate0:texture_2d<f32>,snapshotCondensate1:texture_2d<f32>,p:vec3<f32>)->vec3<f32>{
 if(skyPlanetShadows(c,p)){return vec3<f32>(0.0);}if(c.details.w<0.5){return vec3<f32>(1.0);}
 let shell=skySphere(p,c.sun,1.0+c.atmosphere.x);let count=clamp(i32(c.steps.y),1,4);let stepRay=max(0.0,shell.y)/f32(count);var optical=vec2<f32>(0.0);var dustOptical=0.0;
 for(var index=0;index<4;index++){if(index>=count){break;}let point=p+c.sun*((f32(index)+0.5)*stepRay);optical+=skyAir(c,point)*(stepRay*c.geometry.x);dustOptical+=skySnapshotDust(c,snapshotCondensate0,snapshotCondensate1,point)*(stepRay*c.geometry.x);}return exp(-min(vec3<f32>(80.0),c.rayleigh*optical.x+vec3<f32>(c.atmosphere.w*optical.y+dustOptical)));
}
fn skyCloudSun(c:SkyConfig,noise:texture_3d<f32>,ns:sampler,weather:texture_3d<f32>,ws:sampler,circulationCoverage:texture_2d<f32>,circulationEnvironment:texture_2d<f32>,cs:sampler,snapshotCondensate0:texture_2d<f32>,snapshotCondensate1:texture_2d<f32>,snapshotLower0:texture_2d<f32>,snapshotLower1:texture_2d<f32>,snapshotUpper0:texture_2d<f32>,snapshotUpper1:texture_2d<f32>,snapshotAltitude0:texture_2d<f32>,snapshotAltitude1:texture_2d<f32>,p:vec3<f32>,observerFootprint:f32)->f32{
 if(c.lighting.w<0.5||(c.snapshotParams.x<0.5&&(c.clouds.z<=0.0||c.clouds.w<=0.0||c.weatherParams.z<=0.0))){return 1.0;}
 // Direct body occlusion belongs to skySun; a night surface's ambient light
 // must not be darkened by a second, falsely labelled cloud shadow.
 if(skyPlanetShadows(c,p)){return 1.0;}var optical=0.0;
 var layerCount=3;if(c.snapshotParams.x>0.5){layerCount=i32(c.snapshotParams.w);}
 for(var layer=0;layer<layerCount;layer++){let settings=skyLayer(c,layer);if(settings.w<0.5||(c.snapshotParams.x<0.5&&settings.z<=0.0)){continue;}
  let outer=skySphere(p,c.sun,1.0+settings.x+settings.y);if(outer.y<=max(0.0,outer.x)){continue;}let inner=skySphere(p,c.sun,1.0+settings.x);
  var segments:array<vec2<f32>,2>;segments[0]=vec2<f32>(max(0.0,outer.x),outer.y);segments[1]=vec2<f32>(1.0,-1.0);
  if(inner.y>inner.x&&inner.x<outer.y&&inner.y>segments[0].x){segments[1]=vec2<f32>(max(segments[0].x,inner.y),outer.y);segments[0].y=min(outer.y,inner.x);}
  else if(c.snapshotParams.x>0.5){let turn=-dot(p,c.sun);if(turn>segments[0].x&&turn<segments[0].y){segments[1]=vec2<f32>(turn,segments[0].y);segments[0].y=turn;}}
  var partCount=1;if(segments[1].y>segments[1].x){partCount=2;}
  for(var part=0;part<partCount;part++){let begin=segments[part].x;let end=segments[part].y;if(end<=begin){continue;}let count=clamp(i32(c.steps.w),1,4);let feature=skyFeatureMetres(c,layer);let metric=skyRayMetric(c,begin,end,feature);
   for(var index=0;index<count;index++){
    let start=skyRayEdge(c,begin,end,metric,feature,f32(index)/f32(count));let finish=skyRayEdge(c,begin,end,metric,feature,f32(index+1)/f32(count));let stepRay=finish-start;
    let middle=p+c.sun*((start+finish)*0.5);let samplePhase=skyWorldPhase(c,noise,ns,middle,feature);let point=p+c.sun*mix(start,finish,samplePhase);
    if(c.snapshotParams.x>0.5){let column=skySnapshotColumn(c,snapshotCondensate0,snapshotCondensate1,snapshotLower0,snapshotLower1,snapshotUpper0,snapshotUpper1,snapshotAltitude0,snapshotAltitude1,point);optical+=skyPhysicalCloudBinLayer(c,noise,ns,p,c.sun,start,finish,observerFootprint,layer,column).x;}
    else{var coefficient=2.0;if(layer==0){coefficient=4.0;}else if(layer==1){coefficient=8.0;}let density=skyCloudLayer(c,noise,ns,weather,ws,circulationCoverage,circulationEnvironment,cs,snapshotCondensate0,snapshotCondensate1,snapshotLower0,snapshotLower1,snapshotUpper0,snapshotUpper1,snapshotAltitude0,snapshotAltitude1,point,max(stepRay*c.geometry.x*0.5,observerFootprint),layer);optical+=density*coefficient*stepRay/settings.y;}
   }
  }if(optical>12.0){break;}
 }return exp(-min(80.0,optical));
}
fn skyHG(cosine:f32,g:f32)->f32{return (1.0-g*g)/(4.0*3.141592653589793*pow(max(0.001,1.0+g*g-2.0*g*cosine),1.5));}
fn skyIntegratePhysicalCloudBin(c:SkyConfig,noise:texture_3d<f32>,ns:sampler,weather:texture_3d<f32>,ws:sampler,circulationCoverage:texture_2d<f32>,circulationEnvironment:texture_2d<f32>,cs:sampler,snapshotCondensate0:texture_2d<f32>,snapshotCondensate1:texture_2d<f32>,snapshotLower0:texture_2d<f32>,snapshotLower1:texture_2d<f32>,snapshotUpper0:texture_2d<f32>,snapshotUpper1:texture_2d<f32>,snapshotAltitude0:texture_2d<f32>,snapshotAltitude1:texture_2d<f32>,origin:vec3<f32>,direction:vec3<f32>,rayStart:f32,rayEnd:f32,columnRay:f32,cloudSegment:bool,phase:vec3<f32>,initial:mat4x4<f32>)->mat4x4<f32>{
 let columnPoint=origin+direction*columnRay;let emptyMaterial=vec4<f32>(normalize(columnPoint),0.0);var column=SkyAtmosphereCloudColumn(vec4<f32>(0.0),emptyMaterial,emptyMaterial,vec4<f32>(0.0));var layerCount=0;
 if(cloudSegment){column=skySnapshotColumn(c,snapshotCondensate0,snapshotCondensate1,snapshotLower0,snapshotLower1,snapshotUpper0,snapshotUpper1,snapshotAltitude0,snapshotAltitude1,columnPoint);layerCount=i32(c.snapshotParams.w);}else{column.mass=skySnapshotMass(c,snapshotCondensate0,snapshotCondensate1,columnPoint);}
 var radiance=initial[0].rgb;var transmission=initial[1].rgb;var cuts:array<f32,6>;cuts[0]=rayStart;cuts[1]=rayEnd;var count=2;
 for(var layer=0;layer<layerCount;layer++){
  var bounds=column.altitude.xy;if(layer==1){bounds=column.altitude.zw;}if(skyPhysicalCloudOptical(layer,column)<=0.0){continue;}
  let overlap=skyPhysicalCloudOverlap(c,origin,direction,rayStart,rayEnd,bounds,column.upper.a);if(overlap.y<=overlap.x){continue;}
  if(overlap.x>rayStart&&overlap.x<rayEnd){cuts[count]=overlap.x;count++;}if(overlap.y>rayStart&&overlap.y<rayEnd){cuts[count]=overlap.y;count++;}
 }
 for(var index=1;index<count;index++){let value=cuts[index];var at=index;for(var step=0;step<index;step++){if(at<=0){break;}if(cuts[at-1]<=value){break;}cuts[at]=cuts[at-1];at--;}cuts[at]=value;}
 for(var part=0;part<count-1;part++){
  let begin=cuts[part];let end=cuts[part+1];if(end<=begin){continue;}if(max(transmission.r,max(transmission.g,transmission.b))<0.01){break;}
  let distanceRay=(begin+end)*0.5;let lengthMetres=(end-begin)*c.geometry.x;let point=origin+direction*distanceRay;
  let air=skyAir(c,point);let rayleigh=c.rayleigh*air.x;let mie=c.atmosphere.w*air.y;let footprint=2.0*abs(c.projectionInverse[1][1])*distanceRay*c.geometry.x/max(1.0,c.dimensions.w);
  var layerOptical:array<vec2<f32>,2>;layerOptical[0]=vec2<f32>(0.0);layerOptical[1]=vec2<f32>(0.0);
  for(var layer=0;layer<layerCount;layer++){layerOptical[layer]=skyPhysicalCloudBinLayer(c,noise,ns,origin,direction,begin,end,footprint,layer,column);}let cloudOptical=layerOptical[0].x+layerOptical[1].x;let cloud=cloudOptical/max(0.000001,lengthMetres);
  let altitude=max(0.0,(length(point)-1.0)*c.geometry.x);let dustHeight=max(0.01,c.atmosphere.y);var dust=0.0;
  if(c.details.w>0.5){dust=column.mass.w*${PLANET_ATMOSPHERE_OPTICS.dustExtinctionM2Kg.toFixed(1)}*exp(-altitude/dustHeight)/(dustHeight*max(0.000001,1.0-exp(-c.atmosphere.x*c.geometry.x/dustHeight)));}
  let dustAlbedo=vec3<f32>(${PLANET_ATMOSPHERE_OPTICS.dustScatteringAlbedo.join(',')});let extinction=rayleigh+vec3<f32>(mie+cloud+dust);var lightPoints:array<vec3<f32>,3>;var lightCoefficients:array<vec3<f32>,3>;var lightCount=1;
  lightPoints[0]=point;lightCoefficients[0]=rayleigh*phase.x+vec3<f32>(mie*phase.y)+dust*dustAlbedo*skyHG(dot(direction,c.sun),0.7);
  let daylight=smoothstep(-0.16,0.2,dot(normalize(point),c.sun));var source=dust*dustAlbedo*(c.lighting.y*0.012*daylight);let cellOptical=max(0.0000001,(extinction.r+extinction.g+extinction.b)*lengthMetres/3.0);
  for(var layer=0;layer<layerCount;layer++){
   let optical=layerOptical[layer];if(optical.x<=0.0){continue;}
   let massPoint=origin+direction*optical.y;let radial=normalize(massPoint);
   if(!skyPlanetShadows(c,massPoint)){
    var muSun=dot(radial,c.sun);if(muSun<0.0){muSun=min(-0.0001,muSun);}else{muSun=max(0.0001,muSun);}
    let slope=-dot(radial,direction)/muSun;let fraction=skyOpticalSourceFraction(cellOptical,slope*optical.x/cellOptical);let sourceRay=skyPhysicalCloudSourceDistance(c,origin,direction,begin,end,layer,column,fraction);
    lightPoints[lightCount]=origin+direction*sourceRay;lightCoefficients[lightCount]=vec3<f32>(phase.z*optical.x/max(0.000001,lengthMetres));lightCount++;
   }
   let cloudDaylight=smoothstep(-0.16,0.2,dot(radial,c.sun));source+=vec3<f32>(0.78,0.87,1.0)*(c.lighting.y*0.035*cloudDaylight)*(optical.x/max(0.000001,lengthMetres));
  }
  for(var light=0;light<lightCount;light++){
   var visibility=1.0;if(light>0||cloudOptical>0.0||c.effects.y>0.0){visibility=skyCloudSun(c,noise,ns,weather,ws,circulationCoverage,circulationEnvironment,cs,snapshotCondensate0,snapshotCondensate1,snapshotLower0,snapshotLower1,snapshotUpper0,snapshotUpper1,snapshotAltitude0,snapshotAltitude1,lightPoints[light],footprint);}if(light==0&&cloudOptical<=0.0){visibility=mix(1.0,visibility,c.effects.y);}
   source+=skySun(c,snapshotCondensate0,snapshotCondensate1,lightPoints[light])*visibility*c.lighting.y*lightCoefficients[light];
  }
  let segment=exp(-min(vec3<f32>(80.0),extinction*lengthMetres));radiance+=transmission*source*(vec3<f32>(1.0)-segment)/max(extinction,vec3<f32>(0.000000001));transmission*=segment;
 }
 return mat4x4<f32>(vec4<f32>(radiance,1.0),vec4<f32>(transmission,0.0),vec4<f32>(0.0),vec4<f32>(0.0));
}
fn skyIntegrate(c:SkyConfig,noise:texture_3d<f32>,ns:sampler,weather:texture_3d<f32>,ws:sampler,circulationCoverage:texture_2d<f32>,circulationEnvironment:texture_2d<f32>,cs:sampler,snapshotCondensate0:texture_2d<f32>,snapshotCondensate1:texture_2d<f32>,snapshotLower0:texture_2d<f32>,snapshotLower1:texture_2d<f32>,snapshotUpper0:texture_2d<f32>,snapshotUpper1:texture_2d<f32>,snapshotAltitude0:texture_2d<f32>,snapshotAltitude1:texture_2d<f32>,origin:vec3<f32>,direction:vec3<f32>,rayStart:f32,rayEnd:f32,requested:i32,cloudLayer:i32,phase:vec3<f32>,initial:mat4x4<f32>)->mat4x4<f32>{
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
  let distance=mix(begin,end,samplePhase);let p=origin+direction*distance;
  if(c.snapshotParams.x>0.5){
   let transport=skyIntegratePhysicalCloudBin(c,noise,ns,weather,ws,circulationCoverage,circulationEnvironment,cs,snapshotCondensate0,snapshotCondensate1,snapshotLower0,snapshotLower1,snapshotUpper0,snapshotUpper1,snapshotAltitude0,snapshotAltitude1,origin,direction,begin,end,distance,cloudSegment&&c.snapshotParams.z>0.5,phase,mat4x4<f32>(vec4<f32>(radiance,1.0),vec4<f32>(transmission,0.0),vec4<f32>(0.0),vec4<f32>(0.0)));
   radiance=transport[0].rgb;transmission=transport[1].rgb;continue;
  }
  let air=skyAir(c,p);let rayleigh=c.rayleigh*air.x;let mie=c.atmosphere.w*air.y;
  let footprint=2.0*abs(c.projectionInverse[1][1])*distance*c.geometry.x/max(1.0,c.dimensions.w);
  var cloud=0.0;let cloudPoint=p;
  if(c.snapshotParams.x<0.5&&cloudSegment){cloud=skyCloudExtinction(c,noise,ns,weather,ws,circulationCoverage,circulationEnvironment,cs,snapshotCondensate0,snapshotCondensate1,snapshotLower0,snapshotLower1,snapshotUpper0,snapshotUpper1,snapshotAltitude0,snapshotAltitude1,p,max(footprint,stepMetres*0.5));}
  let dust=skySnapshotDust(c,snapshotCondensate0,snapshotCondensate1,p);let extinction=rayleigh+vec3<f32>(mie+cloud+dust);var shadow=1.0;
  if(cloudSegment||c.effects.y>0.0){var shadowFootprint=footprint;if(cloudSegment){shadowFootprint=max(footprint,stepMetres*0.5);}shadow=skyCloudSun(c,noise,ns,weather,ws,circulationCoverage,circulationEnvironment,cs,snapshotCondensate0,snapshotCondensate1,snapshotLower0,snapshotLower1,snapshotUpper0,snapshotUpper1,snapshotAltitude0,snapshotAltitude1,p,shadowFootprint);}if(!cloudSegment){shadow=mix(1.0,shadow,c.effects.y);}
  let incoming=skySun(c,snapshotCondensate0,snapshotCondensate1,p)*shadow*c.lighting.y;var source=incoming*(rayleigh*phase.x+vec3<f32>(mie*phase.y)+vec3<f32>(${PLANET_ATMOSPHERE_OPTICS.dustScatteringAlbedo.join(',')})*(dust*skyHG(dot(direction,c.sun),0.7)));
  if(c.snapshotParams.x<0.5){source+=incoming*(cloud*phase.z);}
  let daylight=smoothstep(-0.16,0.2,dot(normalize(p),c.sun));let cloudDaylight=smoothstep(-0.16,0.2,dot(normalize(cloudPoint),c.sun));source+=vec3<f32>(0.78,0.87,1.0)*(cloud*c.lighting.y*0.035*cloudDaylight)+vec3<f32>(${PLANET_ATMOSPHERE_OPTICS.dustScatteringAlbedo.join(',')})*(dust*c.lighting.y*0.012*daylight);
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
