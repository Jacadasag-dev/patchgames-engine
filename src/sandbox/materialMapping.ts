import * as THREE from 'three';

/** Box UVs in model metres, with a consistent outside-facing frame on every face.
 * Bake dimensions into geometry before calling; later nonuniform mesh scaling changes density.
 * Does not touch bounded object-surface atlases, which already encode physical dimensions.
 */
export function mapBoxMaterialMeters(geometry:THREE.BoxGeometry):void{
  const {width,height,depth}=geometry.parameters;
  if(![width,height,depth].every(v=>Number.isFinite(v)&&v>0))throw Error('Box dimensions must be positive finite metres.');
  const uv=geometry.getAttribute('uv'),position=geometry.getAttribute('position'),normal=geometry.getAttribute('normal');
  for(let i=0;i<uv.count;i++){
    const x=position.getX(i),y=position.getY(i),z=position.getZ(i),nx=normal.getX(i),ny=normal.getY(i);
    const u=nx>0?-z+depth/2:nx<0?z+depth/2:x+width/2;
    const v=ny>0?-z+depth/2:ny<0?z+depth/2:y+height/2;
    uv.setXY(i,nx===0&&ny===0&&normal.getZ(i)<0?width-u:u,v);
  }
  uv.needsUpdate=true;geometry.deleteAttribute('tangent');
  geometry.userData.materialMapping='model-metres';
}

export interface TextureDensity {minimum:number;maximum:number;anisotropy:number;triangles:number;degenerateTriangles:number}
/** Actual UV-to-surface metric, in texels per model metre. Includes texture repeat.
 * Singular values detect stretching even on skewed triangles, not just axis-aligned boxes.
 */
export function inspectTextureDensity(geometry:THREE.BufferGeometry,textureSize:[number,number],repeat:[number,number]=[1,1]):TextureDensity{
  if(![...textureSize,...repeat].every(v=>Number.isFinite(v)&&v>0))throw Error('Texture dimensions and repeats must be positive and finite.');
  const p=geometry.getAttribute('position'),uv=geometry.getAttribute('uv'),index=geometry.index;
  if(!p||!uv)throw Error('Density inspection requires positions and UVs.');
  let minimum=Infinity,maximum=0,anisotropy=1,triangles=0,degenerateTriangles=0;
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3();
  for(let k=0;k<(index?.count??p.count);k+=3){
    const i=index?index.getX(k):k,j=index?index.getX(k+1):k+1,l=index?index.getX(k+2):k+2;
    a.fromBufferAttribute(p,i);b.fromBufferAttribute(p,j).sub(a);c.fromBufferAttribute(p,l).sub(a);
    const length=b.length(),cx=length?c.dot(b)/length:0,cy=Math.sqrt(Math.max(0,c.lengthSq()-cx*cx));
    const du1=(uv.getX(j)-uv.getX(i))*textureSize[0]*repeat[0],dv1=(uv.getY(j)-uv.getY(i))*textureSize[1]*repeat[1];
    const du2=(uv.getX(l)-uv.getX(i))*textureSize[0]*repeat[0],dv2=(uv.getY(l)-uv.getY(i))*textureSize[1]*repeat[1];
    if(length<1e-10||cy<1e-10){degenerateTriangles++;continue;}
    const aa=du1/length,cc=dv1/length,bb=(du2-aa*cx)/cy,dd=(dv2-cc*cx)/cy;
    const trace=aa*aa+bb*bb+cc*cc+dd*dd,det=(aa*dd-bb*cc)**2,delta=Math.sqrt(Math.max(0,trace*trace-4*det));
    const hi=Math.sqrt((trace+delta)/2),lo=hi?Math.sqrt(det)/hi:0;
    minimum=Math.min(minimum,lo);maximum=Math.max(maximum,hi);anisotropy=Math.max(anisotropy,lo?hi/lo:Infinity);triangles++;
  }
  return{minimum:minimum===Infinity?0:minimum,maximum,anisotropy,triangles,degenerateTriangles};
}

/** WebGL lab overlay. Checker cells use physical coordinates; density uses the actual UV Jacobian.
 * Red = below target, blue = above, green = target; magenta = >2x directional distortion.
 * Set modelMetersPerUnit for display-only preview scaling. Own and dispose the returned material.
 */
export function createMaterialMappingDebug(options:{mode:'checker'|'density';textureSize:[number,number];repeat?:[number,number];uvMeters?:[number,number];targetTexelsPerMeter?:number;modelMetersPerUnit?:number}){
  const repeat=options.repeat??[1,1],target=options.targetTexelsPerMeter??256,unit=options.modelMetersPerUnit??1;
  if(![...options.textureSize,...repeat,target,unit].every(v=>Number.isFinite(v)&&v>0))throw Error('Debug mapping values must be positive and finite.');
  return new THREE.ShaderMaterial({side:THREE.DoubleSide,uniforms:{densityMode:{value:options.mode==='density'},uvMeters:{value:new THREE.Vector2(...options.uvMeters??[1,1])},texels:{value:new THREE.Vector2(...options.textureSize).multiply(new THREE.Vector2(...repeat))},target:{value:target},unit:{value:unit}},
    vertexShader:`varying vec2 texUv; varying vec3 point; varying vec3 faceNormal;
      void main(){texUv=uv;point=position;faceNormal=normal;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`uniform bool densityMode;uniform vec2 uvMeters;uniform vec2 texels;uniform float target;uniform float unit;varying vec2 texUv;varying vec3 point;varying vec3 faceNormal;
      void main(){
        vec2 cell=texUv*uvMeters*4.;vec2 edge=min(fract(cell),1.-fract(cell));
        float line=1.-smoothstep(0.,1.5,min(edge.x/max(fwidth(cell.x),.00001),edge.y/max(fwidth(cell.y),.00001)));
        vec3 color=mix(vec3(.83),vec3(.12),mod(floor(cell.x)+floor(cell.y),2.));color=mix(color,vec3(.12,.65,.9),line);
        if(densityMode){
          vec3 px=dFdx(point)*unit,py=dFdy(point)*unit;vec2 tx=dFdx(texUv)*texels,ty=dFdy(texUv)*texels;
          float len=max(length(px),1e-12),cx=dot(py,px)/len,cy=max(length(cross(px,py))/len,1e-12);
          vec2 a=tx/len,b=(ty-a*cx)/cy;float tr=dot(a,a)+dot(b,b),det=a.x*b.y-a.y*b.x;
          float hi=sqrt(max(0.,(tr+sqrt(max(0.,tr*tr-4.*det*det)))*.5)),lo=abs(det)/max(hi,1e-12);
          float ratio=sqrt(max(lo*hi,0.))/target;
          color=ratio<1.?mix(vec3(.9,.13,.08),vec3(.15,.8,.25),clamp(ratio,0.,1.)):mix(vec3(.15,.8,.25),vec3(.15,.35,1.),clamp(log2(ratio),0.,1.));
          if(hi/max(lo,.00001)>2.)color=mix(color,vec3(1.,0.,1.),.7);
        }
        gl_FragColor=vec4(color,1.);
        #include <colorspace_fragment>
      }`});
}
