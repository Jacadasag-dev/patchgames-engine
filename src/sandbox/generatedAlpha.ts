import {BackSide,DoubleSide,FrontSide,Material,MeshBasicMaterial,MeshDepthMaterial,MeshDistanceMaterial,MeshLambertMaterial,MeshMatcapMaterial,MeshNormalMaterial,MeshPhongMaterial,MeshStandardMaterial,MeshToonMaterial,RGBADepthPacking,Texture} from 'three';

const owned=new WeakSet<Material>();
const nativeAlphaTest=Object.getOwnPropertyDescriptor(Material.prototype,'alphaTest');
interface GeneratedAlphaShadows {depth:MeshDepthMaterial;distance:MeshDistanceMaterial;dispose():void}
const sources=new WeakMap<Material,GeneratedAlphaShadows>();
/** Read native material data without evaluating an authored accessor. */
function value(material:Material,key:string):{valid:boolean;value:unknown}{
  let at:object|null=material;for(let depth=0;at&&depth<16;depth++,at=Object.getPrototypeOf(at)){
    const descriptor=Object.getOwnPropertyDescriptor(at,key);if(descriptor){
      if(key==='alphaTest'&&at===Material.prototype&&descriptor.get===nativeAlphaTest?.get&&descriptor.set===nativeAlphaTest?.set){const backing=Object.getOwnPropertyDescriptor(material,'_alphaTest');return backing&&'value'in backing?{valid:true,value:backing.value}:{valid:false,value:undefined};}
      return'value'in descriptor?{valid:true,value:descriptor.value}:{valid:false,value:undefined};
    }
  }return{valid:true,value:undefined};
}
function nativeHashFields(material:Material):boolean{
  const read=(key:string,check:(entry:unknown)=>boolean)=>{const field=value(material,key);return field.valid&&check(field.value);};
  return read('alphaHash',v=>v===true)&&read('alphaTest',v=>v===0)&&read('alphaToCoverage',v=>v===false)&&read('transparent',v=>v===false)
    &&read('opacity',v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1)
    &&read('side',v=>v===FrontSide||v===BackSide||v===DoubleSide)
    &&read('map',v=>v===null||v===undefined||v instanceof Texture)&&read('alphaMap',v=>v===null||v===undefined||v instanceof Texture)
    &&read('wireframe',v=>v===false||v===undefined)&&read('displacementMap',v=>v===null||v===undefined)
    &&read('onBeforeRender',v=>v===Material.prototype.onBeforeRender)&&read('onBeforeCompile',v=>v===Material.prototype.onBeforeCompile)
    &&read('customProgramCacheKey',v=>v===Material.prototype.customProgramCacheKey);
}
/** Only engine-created, still-unmodified native shadow materials qualify for
 * generated LOD and the WebGPU facade. A public tag cannot confer ownership. */
export function isGeneratedAlphaShadowMaterial(material:Material|undefined):boolean{
  return !!material&&owned.has(material)&&nativeHashFields(material)
    &&(material instanceof MeshDepthMaterial?value(material,'depthPacking').value===RGBADepthPacking:material instanceof MeshDistanceMaterial);
}
/** Classic WebGL does not propagate alphaHash into its default shadow material.
 * These native depth/distance variants retain fractional leaf coverage for both
 * projected and point-light shadows. Textures are borrowed from the source. */
export function createGeneratedAlphaShadows(source:Material):GeneratedAlphaShadows{
  if(!(source instanceof MeshStandardMaterial||source instanceof MeshBasicMaterial||source instanceof MeshLambertMaterial||source instanceof MeshPhongMaterial||source instanceof MeshToonMaterial||source instanceof MeshNormalMaterial||source instanceof MeshMatcapMaterial)||!nativeHashFields(source))throw Error('Generated alpha shadows require a native opaque hashed material without authored shader or displacement callbacks.');
  const cached=sources.get(source);if(cached)return cached;
  const options={map:value(source,'map').value as Texture|null,alphaMap:value(source,'alphaMap').value as Texture|null,side:value(source,'side').value as typeof FrontSide,opacity:value(source,'opacity').value as number,alphaHash:true,alphaTest:0,alphaToCoverage:false,transparent:false};
  const depth=new MeshDepthMaterial({...options,depthPacking:RGBADepthPacking}),distance=new MeshDistanceMaterial(options);
  for(const material of [depth,distance]){owned.add(material);material.addEventListener('dispose',()=>owned.delete(material));}
  let disposed=false;const handle:GeneratedAlphaShadows={depth,distance,dispose(){if(disposed)return;disposed=true;source.removeEventListener('dispose',handle.dispose);if(sources.get(source)===handle)sources.delete(source);depth.dispose();distance.dispose();}};
  sources.set(source,handle);source.addEventListener('dispose',handle.dispose);return handle;
}
