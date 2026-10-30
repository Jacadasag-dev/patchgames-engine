/** Engine-owned native WGSL. Positions are planet-radius relative, and scene
 * depth uses Three's native WebGPU (including its distinct logarithmic) curve.
 * The two output columns carry RGB radiance and RGB transmission + linear depth.
 * Fixed loop bounds keep every quality preset bounded on the GPU. */
export const planetSkyWebGPUVolumeWGSL=/* wgsl */`
fn planetSkyVolume(
  uvIn:vec2<f32>, sceneDepth:texture_depth_2d,
  noise:texture_3d<f32>, noiseSampler:sampler,
  weather:texture_3d<f32>, weatherSampler:sampler,
  projectionInverse:mat4x4<f32>, cameraRotation:mat4x4<f32>,
  cameraRadius:vec3<f32>, sunDirection:vec3<f32>, rayleigh:vec3<f32>,
  shapeWind:vec3<f32>, detailWind:vec3<f32>,
  geometry:vec4<f32>, atmosphere:vec4<f32>, lighting:vec4<f32>,
  clouds:vec4<f32>, details:vec4<f32>, steps:vec4<f32>,
  dimensions:vec4<f32>, style:vec4<f32>
) -> mat4x4<f32> {
  let c=SkyConfig(geometry,atmosphere,lighting,clouds,details,steps,dimensions,
    projectionInverse,rayleigh,sunDirection,shapeWind,detailWind);
  var uv=uvIn;
  if(style.x>0.5){uv=clamp((floor(uv*dimensions.xy/max(1.0,style.y))+0.5)*max(1.0,style.y)/dimensions.xy,vec2<f32>(0.0),vec2<f32>(1.0));}
  let texel=vec2<i32>(clamp(floor(uv*dimensions.xy),vec2<f32>(0.0),dimensions.xy-1.0));
  uv=(vec2<f32>(texel)+0.5)/dimensions.xy;
  let depth=textureLoad(sceneDepth,texel,0);
  // WebGPU texture rows run downwards; clip depth is zero through one.
  let projected=projectionInverse*vec4<f32>(uv.x*2.0-1.0,1.0-uv.y*2.0,0.5,1.0);
  let viewDirection=normalize(projected.xyz/projected.w);
  let direction=normalize((cameraRotation*vec4<f32>(viewDirection,0.0)).xyz);
  let shell=skySphere(cameraRadius,direction,1.0+atmosphere.x);
  var rayStart=max(0.0,shell.x);
  var rayEnd=shell.y;
  if(depth<0.9999999){rayEnd=min(rayEnd,skyViewDepth(depth,geometry)/(max(0.000001,-viewDirection.z)*geometry.x));}
  let body=skySphere(cameraRadius,direction,1.0);
  if(body.y>body.x){
    if(body.x>0.0){rayEnd=min(rayEnd,body.x);}
    else if(body.y>0.0){rayStart=max(rayStart,body.y);}
  }
  var transport=mat4x4<f32>(vec4<f32>(0.0,0.0,0.0,1.0),vec4<f32>(1.0,1.0,1.0,0.0),vec4<f32>(0.0),vec4<f32>(0.0));
  if(shell.y>shell.x&&rayEnd>rayStart&&(details.w>0.5||lighting.w>0.5)){
    var first=vec2<f32>(1.0,-1.0);
    var second=vec2<f32>(1.0,-1.0);
    if(lighting.w>0.5&&clouds.z>0.0&&clouds.w>0.0){
      let outer=skySphere(cameraRadius,direction,1.0+clouds.x+clouds.y);
      let cloudFrom=max(rayStart,outer.x);
      let cloudTo=min(rayEnd,outer.y);
      if(outer.y>outer.x&&cloudTo>cloudFrom){
        let inner=skySphere(cameraRadius,direction,1.0+clouds.x);
        if(inner.y>inner.x&&inner.x<cloudTo&&inner.y>cloudFrom){
          first=vec2<f32>(cloudFrom,min(cloudTo,inner.x));
          second=vec2<f32>(max(cloudFrom,inner.y),cloudTo);
        }else{first=vec2<f32>(cloudFrom,cloudTo);}
      }
    }
    let cloudLength=max(0.0,first.y-first.x)+max(0.0,second.y-second.x);
    let airLength=max(0.0000001,rayEnd-rayStart-cloudLength);
    let cosine=dot(direction,sunDirection);
    let phase=vec3<f32>(3.0*(1.0+cosine*cosine)/(16.0*3.141592653589793),skyHG(cosine,lighting.x),0.8*skyHG(cosine,0.65)+0.2*skyHG(cosine,-0.25));
    var cursor=rayStart;
    if(first.y>first.x){
      transport=skyIntegrate(c,noise,noiseSampler,weather,weatherSampler,cameraRadius,direction,cursor,first.x,skyAirSteps(cursor,first.x,airLength,steps.x),false,phase,transport);
      transport=skyIntegrate(c,noise,noiseSampler,weather,weatherSampler,cameraRadius,direction,first.x,first.y,i32(steps.z),true,phase,transport);
      cursor=first.y;
    }
    if(second.y>second.x){
      transport=skyIntegrate(c,noise,noiseSampler,weather,weatherSampler,cameraRadius,direction,cursor,second.x,skyAirSteps(cursor,second.x,airLength,steps.x),false,phase,transport);
      transport=skyIntegrate(c,noise,noiseSampler,weather,weatherSampler,cameraRadius,direction,second.x,second.y,i32(steps.z),true,phase,transport);
      cursor=second.y;
    }
    transport=skyIntegrate(c,noise,noiseSampler,weather,weatherSampler,cameraRadius,direction,cursor,rayEnd,skyAirSteps(cursor,rayEnd,airLength,steps.x),false,phase,transport);
  }
  var linearDepth=-1.0;
  if(depth<0.9999999){linearDepth=skyViewDepth(depth,geometry)/geometry.x;}
  return mat4x4<f32>(vec4<f32>(max(vec3<f32>(0.0),transport[0].rgb),1.0),vec4<f32>(clamp(transport[1].rgb,vec3<f32>(0.0),vec3<f32>(1.0)),linearDepth),vec4<f32>(0.0),vec4<f32>(0.0));
}

struct SkyConfig {
  geometry:vec4<f32>, atmosphere:vec4<f32>, lighting:vec4<f32>,
  clouds:vec4<f32>, details:vec4<f32>, steps:vec4<f32>, dimensions:vec4<f32>,
  projectionInverse:mat4x4<f32>, rayleigh:vec3<f32>, sun:vec3<f32>,
  shapeWind:vec3<f32>, detailWind:vec3<f32>
}
fn skySphere(origin:vec3<f32>,direction:vec3<f32>,radius:f32)->vec2<f32>{
  let along=dot(origin,direction);
  let perpendicular=cross(origin,direction);
  let square=radius*radius-dot(perpendicular,perpendicular);
  if(square<0.0){return vec2<f32>(1.0,-1.0);}
  let extent=sqrt(max(0.0,square));
  return vec2<f32>(-along-extent,-along+extent);
}
fn skyViewDepth(depth:f32,g:vec4<f32>)->f32{
  // Native Three uses near-relative logarithmic depth, unlike WebGLRenderer.
  if(g.w>0.5){return g.y*exp2(depth*log2(g.z/g.y));}
  return g.y*g.z/max(0.0000001,g.z-depth*(g.z-g.y));
}
fn skyCloud(c:SkyConfig,noise:texture_3d<f32>,ns:sampler,weather:texture_3d<f32>,ws:sampler,p:vec3<f32>,footprint:f32)->f32{
  if(c.lighting.w<0.5||c.clouds.z<=0.0||c.clouds.w<=0.0){return 0.0;}
  let h=(length(p)-1.0-c.clouds.x)/c.clouds.y;
  if(h<=0.0||h>=1.0){return 0.0;}
  let metres=p*c.geometry.x;
  let shapeLod=clamp(log2(max(1.0,footprint/c.details.y)),0.0,5.0);
  let detailLod=clamp(log2(max(1.0,footprint/c.details.z)),0.0,5.0);
  let base=textureSampleLevel(noise,ns,metres/(c.details.y*32.0)+c.shapeWind,shapeLod).r;
  let detail=textureSampleLevel(noise,ns,metres/(c.details.z*32.0)+c.detailWind,detailLod).g;
  let weatherValue=textureSampleLevel(weather,ws,p/2.2+0.5,0.0).r;
  let field=clamp((weatherValue*0.6+base*0.4-0.5)*2.5+0.5,0.0,1.0);
  let feather=0.04+0.1*clamp(footprint/c.details.y,0.0,2.0);
  let shape=smoothstep(1.0-c.clouds.z-feather,1.0-c.clouds.z+feather,field);
  let height=smoothstep(0.0,0.16,h)*(1.0-smoothstep(0.65,1.0,h));
  return max(0.0,(shape*height-c.details.x*(1.0-detail)*0.4)/(1.0-0.4*c.details.x))*c.clouds.w;
}
fn skyAir(c:SkyConfig,p:vec3<f32>)->vec2<f32>{
  if(c.details.w<0.5){return vec2<f32>(0.0);}
  let altitude=max(0.0,(length(p)-1.0)*c.geometry.x);
  return exp(-altitude/c.atmosphere.yz);
}
fn skySun(c:SkyConfig,p:vec3<f32>)->vec3<f32>{
  let body=skySphere(p,c.sun,1.0);
  if(body.y>0.0000001&&body.x>0.0000001){return vec3<f32>(0.0);}
  if(c.details.w<0.5){return vec3<f32>(1.0);}
  let shell=skySphere(p,c.sun,1.0+c.atmosphere.x);
  let count=clamp(i32(c.steps.y),1,4);
  let stepRay=max(0.0,shell.y)/f32(count);
  var optical=vec2<f32>(0.0);
  for(var i=0;i<4;i++){
    if(i>=count){break;}
    optical+=skyAir(c,p+c.sun*((f32(i)+0.5)*stepRay))*(stepRay*c.geometry.x);
  }
  return exp(-min(vec3<f32>(80.0),c.rayleigh*optical.x+vec3<f32>(c.atmosphere.w*optical.y)));
}
fn skyCloudSun(c:SkyConfig,noise:texture_3d<f32>,ns:sampler,weather:texture_3d<f32>,ws:sampler,p:vec3<f32>)->f32{
  if(c.lighting.w<0.5||c.clouds.z<=0.0){return 1.0;}
  let outer=1.0+c.clouds.x+c.clouds.y;
  if(length(p)>outer){return 1.0;}
  let shell=skySphere(p,c.sun,outer);
  if(shell.y<=0.0){return 1.0;}
  let count=clamp(i32(c.steps.w),1,4);
  let stepRay=min(shell.y,c.clouds.y*8.0)/f32(count);
  var optical=0.0;
  for(var i=0;i<4;i++){
    if(i>=count){break;}
    optical+=skyCloud(c,noise,ns,weather,ws,p+c.sun*((f32(i)+0.5)*stepRay),stepRay*c.geometry.x)*stepRay;
  }
  return exp(-min(80.0,optical*2.0/c.clouds.y));
}
fn skyHG(cosine:f32,g:f32)->f32{
  return (1.0-g*g)/(4.0*3.141592653589793*pow(max(0.001,1.0+g*g-2.0*g*cosine),1.5));
}
fn skyAirSteps(rayStart:f32,rayEnd:f32,total:f32,requested:f32)->i32{
  let fraction=clamp(max(0.0,rayEnd-rayStart)/max(0.0000001,total),0.0,1.0);
  return clamp(i32(ceil(clamp(requested,1.0,24.0)*fraction-0.0001)),1,24);
}
fn skyIntegrate(c:SkyConfig,noise:texture_3d<f32>,ns:sampler,weather:texture_3d<f32>,ws:sampler,
  origin:vec3<f32>,direction:vec3<f32>,rayStart:f32,rayEnd:f32,requested:i32,cloudSegment:bool,phase:vec3<f32>,initial:mat4x4<f32>)->mat4x4<f32>{
  var radiance=initial[0].rgb;
  var transmission=initial[1].rgb;
  if(rayEnd<=rayStart||(!cloudSegment&&c.details.w<0.5)||max(transmission.r,max(transmission.g,transmission.b))<0.01){return initial;}
  let count=clamp(requested,1,32);
  let stepRay=(rayEnd-rayStart)/f32(count);
  let stepMetres=stepRay*c.geometry.x;
  for(var i=0;i<32;i++){
    if(i>=count||max(transmission.r,max(transmission.g,transmission.b))<0.01){break;}
    let distance=rayStart+(f32(i)+0.5)*stepRay;
    let p=origin+direction*distance;
    let air=skyAir(c,p);
    let rayleigh=c.rayleigh*air.x;
    let mie=c.atmosphere.w*air.y;
    let footprint=2.0*abs(c.projectionInverse[1][1])*distance*c.geometry.x/max(1.0,c.dimensions.w);
    var cloud=0.0;
    if(cloudSegment){cloud=skyCloud(c,noise,ns,weather,ws,p,max(footprint,stepMetres*0.5))*2.0/(c.clouds.y*c.geometry.x);}
    let extinction=rayleigh+vec3<f32>(mie+cloud);
    let incoming=skySun(c,p)*skyCloudSun(c,noise,ns,weather,ws,p)*c.lighting.y;
    var source=incoming*(rayleigh*phase.x+vec3<f32>(mie*phase.y+cloud*phase.z));
    let daylight=clamp(dot(normalize(p),c.sun)*0.5+0.5,0.025,1.0);
    source+=vec3<f32>(0.78,0.87,1.0)*(cloud*c.lighting.y*0.025*daylight);
    let segment=exp(-min(vec3<f32>(80.0),extinction*stepMetres));
    let integral=(vec3<f32>(1.0)-segment)/max(extinction,vec3<f32>(0.000000001));
    radiance+=transmission*source*integral;
    transmission*=segment;
  }
  return mat4x4<f32>(vec4<f32>(radiance,1.0),vec4<f32>(transmission,0.0),vec4<f32>(0.0),vec4<f32>(0.0));
}
`;

export const planetSkyWebGPUCompositeWGSL=/* wgsl */`
fn planetSkyComposite(uvIn:vec2<f32>,sceneColor:texture_2d<f32>,sceneSampler:sampler,
  sceneDepth:texture_depth_2d,radianceTexture:texture_2d<f32>,transmissionTexture:texture_2d<f32>,
  geometry:vec4<f32>,dimensions:vec4<f32>,style:vec4<f32>)->vec4<f32>{
  var uv=uvIn;
  if(style.x>0.5){uv=clamp((floor(uv*dimensions.xy/max(1.0,style.y))+0.5)*max(1.0,style.y)/dimensions.xy,vec2<f32>(0.0),vec2<f32>(1.0));}
  let color=textureSampleLevel(sceneColor,sceneSampler,uv,0.0);
  let fullTexel=vec2<i32>(clamp(floor(uv*dimensions.xy),vec2<f32>(0.0),dimensions.xy-1.0));
  let actualDepth=textureLoad(sceneDepth,fullTexel,0);
  let tolerance=skyDepthTolerance(sceneDepth,fullTexel,actualDepth,geometry,dimensions);
  var radiance=vec3<f32>(0.0);
  var transmission=vec3<f32>(0.0);
  var totalWeight=0.0;
  if(style.x>0.5||style.w>5.5){
    let texel=vec2<i32>(clamp(floor(uv*dimensions.zw),vec2<f32>(0.0),dimensions.zw-1.0));
    let candidate=textureLoad(transmissionTexture,texel,0);
    totalWeight=skyCompatibleDepth(actualDepth,candidate.a,geometry,style.w,tolerance);
    radiance=textureLoad(radianceTexture,texel,0).rgb*totalWeight;
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
      radiance+=textureLoad(radianceTexture,texel,0).rgb*weight;
      transmission+=candidate.rgb*weight;
      totalWeight+=weight;
    }}
  }
  if(totalWeight>0.00001){radiance/=totalWeight;transmission/=totalWeight;}
  else{radiance=vec3<f32>(0.0);transmission=vec3<f32>(1.0);}
  var result=vec4<f32>(max(vec3<f32>(0.0),color.rgb*transmission+radiance),color.a);
  let diagnosticMode=i32(style.w);
  let diagnosticTexel=vec2<i32>(clamp(floor(uv*dimensions.zw),vec2<f32>(0.0),dimensions.zw-1.0));
  if(diagnosticMode==1){result=color;}
  if(diagnosticMode==2){result=vec4<f32>(textureLoad(radianceTexture,diagnosticTexel,0).rgb,1.0);}
  if(diagnosticMode==3){result=vec4<f32>(vec3<f32>(1.0)-textureLoad(transmissionTexture,diagnosticTexel,0).rgb,1.0);}
  if(diagnosticMode==4){result=vec4<f32>(vec3<f32>(select(0.0,1.0,totalWeight>0.00001)),1.0);}
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
  if(diagnosticMode>4.5){return 1.0;}
  let emptyActual=actual>=0.9999999;
  let emptyCandidate=candidate<0.0;
  if(emptyActual||emptyCandidate){return select(0.0,1.0,emptyActual&&emptyCandidate);}
  let expected=skyCompositeViewDepth(actual,g)/g.x;
  let difference=abs(candidate-expected);
  if(difference>tolerance){return 0.0;}
  return exp(-difference/max(0.000000001,tolerance*0.35));
}
`;

/** Applied after native tone mapping / working-to-output conversion. */
export const planetSkyWebGPUPaletteWGSL=/* wgsl */`
fn planetSkyPalette(color:vec4<f32>,style:vec4<f32>)->vec4<f32>{
  if(style.x<0.5){return color;}
  let levels=max(1.0,style.z-1.0);
  return vec4<f32>(floor(clamp(color.rgb,vec3<f32>(0.0),vec3<f32>(1.0))*levels+0.5)/levels,color.a);
}
`;
