/** Shared presentation of accepted local velocity. Two overlapping advection
 * phases hide texture resets; no geometry, wet area or physical force changes. */
export const WATER_CURRENT_GLSL = `
vec3 waterCurrentNoiseGradient(vec2 p) {
  vec2 i=floor(p), f=fract(p), derivative=6.0*f*(1.0-f); f=f*f*(3.0-2.0*f);
  vec4 h=fract(sin(vec4(dot(i,vec2(127.1,311.7)),dot(i+vec2(1.0,0.0),vec2(127.1,311.7)),dot(i+vec2(0.0,1.0),vec2(127.1,311.7)),dot(i+vec2(1.0),vec2(127.1,311.7))))*43758.5453);
  return vec3(mix(mix(h.x,h.y,f.x),mix(h.z,h.w,f.x),f.y),derivative.x*mix(h.y-h.x,h.w-h.z,f.y),derivative.y*mix(h.z-h.x,h.w-h.y,f.x));
}
float waterCurrentNoise(vec2 p){return waterCurrentNoiseGradient(p).x;}
vec3 waterCurrentPattern(vec2 p,vec2 direction) {
  // Average a short local trail instead of rotating the entire world position
  // by a spatially changing direction (which creates zebra/moire contours).
  vec2 q=p*4.0, trail=direction*1.3;
  vec3 value=waterCurrentNoiseGradient(q)*0.5+waterCurrentNoiseGradient(q-trail)*0.25+waterCurrentNoiseGradient(q+trail)*0.25;
  return value*vec3(1.0,4.0,4.0);
}
// XY: optical slope; Z: flowing glints; W: actual terrain-contact foam.
vec4 waterCurrentDetail(vec2 p,vec2 flow,float depth,float shore,float seconds) {
  float speed=length(flow), activity=smoothstep(0.025,0.7,speed);
  vec2 direction=speed>0.0001?flow/speed:vec2(1.0,0.0);
  float a=fract(seconds*0.25), b=fract(seconds*0.25+0.5);
  float blend=abs(1.0-2.0*a);
  vec2 p0=p-flow*a*4.0, p1=p-flow*b*4.0;
  vec3 pattern=mix(waterCurrentPattern(p0,direction),waterCurrentPattern(p1,direction),blend);
  float footprint=max(length(dFdx(p0*4.0)),length(dFdy(p0*4.0)));
  footprint=max(footprint,max(length(dFdx(p1*4.0)),length(dFdy(p1*4.0))));
  float filtered=1.0-smoothstep(0.25,1.0,footprint);
  float aa=max(0.01,fwidth(pattern.x));
  float streak=smoothstep(0.55-aa,0.78+aa,pattern.x)*activity*smoothstep(0.002,0.035,depth)*filtered;
  vec2 slope=-pattern.yz*0.012*activity*smoothstep(0.002,0.03,depth)*filtered;
  float coast=shore*(1.0-smoothstep(0.012,0.16,depth))*smoothstep(0.001,0.012,depth);
  float lace=waterCurrentNoise(p*12.0-flow*seconds*0.6+vec2(seconds*0.04*activity));
  float wash=0.6+0.4*sin(depth*65.0-seconds*(0.8+speed)*activity);
  float foam=coast*smoothstep(0.38,0.7,lace)*(0.18+0.25*activity)*wash;
  return vec4(slope,streak,foam);
}
`;
