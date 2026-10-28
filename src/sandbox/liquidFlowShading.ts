import type {WebGLProgramParametersWithUniforms} from 'three';

/** Small optical corrugations on exposed vertical water. These never move the
 * mesh or invent wet area; the accepted simulation clock also pauses replay. */
export function addLiquidFlowShading(shader:WebGLProgramParametersWithUniforms,clock:{value:number}):void {
 shader.uniforms.liquidFlowClock=clock;
 shader.vertexShader='varying vec3 liquidFlowPosition;\nvarying vec3 liquidFlowUp;\n'+shader.vertexShader;
 shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',`#include <project_vertex>
liquidFlowPosition=transformed;
liquidFlowUp=normalize((modelViewMatrix*vec4(0.0,1.0,0.0,0.0)).xyz);`);
 shader.fragmentShader='uniform float liquidFlowClock;\nvarying vec3 liquidFlowPosition;\nvarying vec3 liquidFlowUp;\n'+shader.fragmentShader;
 shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
float liquidVertical=1.0-smoothstep(0.25,0.8,abs(dot(normal,liquidFlowUp)));
float liquidAcross=dot(liquidFlowPosition.xz,vec2(0.81,0.59));
float liquidPhase=liquidAcross*34.0+sin(liquidAcross*7.0)+liquidFlowPosition.y*2.4+liquidFlowClock*2.2;
float liquidFilter=1.0-smoothstep(0.4,1.8,fwidth(liquidPhase));
vec3 liquidSide=cross(normal,liquidFlowUp);
vec3 liquidCorrugation=liquidVertical*liquidFilter*(liquidSide*cos(liquidPhase)*0.045+liquidFlowUp*sin(liquidPhase*0.71)*0.012);
normal=normalize(normal+liquidCorrugation);`);
 shader.fragmentShader=shader.fragmentShader.replace('#include <clearcoat_normal_fragment_maps>',`#include <clearcoat_normal_fragment_maps>
#ifdef USE_CLEARCOAT
clearcoatNormal=normalize(clearcoatNormal+liquidCorrugation);
#endif`);
 shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`
#ifdef USE_COLOR_ALPHA
// Vertex alpha stores normal-path absorption for finite-volume films. Keep
// their water/air interface reflection as tint fades with optical thickness.
// Zero coverage still vanishes, including a clipped shoreline or pool join.
if(vColor.a<0.9999){
float liquidAbsorption=clamp(diffuseColor.a,0.0,1.0);
float liquidInterface=smoothstep(0.0,0.0005,liquidAbsorption);
float liquidFresnel=0.02037+0.97963*pow(1.0-abs(dot(normal,geometryViewDir)),5.0);
float liquidCompositeAlpha=liquidAbsorption+(1.0-liquidAbsorption)*liquidFresnel*liquidInterface;
vec3 liquidReflection=reflectedLight.directSpecular+reflectedLight.indirectSpecular;
#ifdef USE_CLEARCOAT
// PhysicalMaterial layers this interface after its base reflection. Preserve
// both terms: treating the coat as diffuse would absorb its highlights in a
// thin sheet and leave only the thick material intervals visibly reflective.
liquidReflection=liquidReflection*(1.0-material.clearcoat*Fcc)+(clearcoatSpecularDirect+clearcoatSpecularIndirect)*material.clearcoat;
#endif
outgoingLight=(max(outgoingLight-liquidReflection,vec3(0.0))*liquidAbsorption+liquidReflection*liquidInterface)/max(liquidCompositeAlpha,0.00001);
diffuseColor.a=liquidCompositeAlpha;
}
#endif
#include <opaque_fragment>`);
}
