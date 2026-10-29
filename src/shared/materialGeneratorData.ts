import {parseMaterialFracture} from './materialFracture.ts';
import type {ResolvedMaterialGenerator} from './materialGenerator.ts';
const common={version:1,seed:1,name:'Generated material',tileMeters:[2,2],color:'#967b60',secondaryColor:'#514637',variation:0.3,roughness:0.8,weathering:0.15,reliefMeters:0.008};
const patterns:Record<string,Record<string,unknown>>={
  masonry:{shape:'rectangle',blockMeters:[0.4,0.2],bond:'staggered',mortarMeters:0.012,irregularity:0.2,chipping:0.15},
  rock:{grainMeters:0.08,fractures:0.3,layering:0.2},wood:{plankMeters:0.2,grain:0.7,knots:0.3,gapMeters:0.004,direction:'vertical'},
  dirt:{grainMeters:0.05,clumping:0.6,moisture:0.1,stones:0.2},gravel:{stoneMeters:0.08,roundness:0.6,sizeVariation:0.4},
  grass:{bladeMeters:0.03,density:0.8,dryness:0.2,barePatches:0.15},metal:{brushing:0.4,oxidation:0.1,metalness:0.95},plaster:{grainMeters:0.02,cracks:0.15},
  bark:{ridgeMeters:.04,fissures:.7,peeling:.2,knots:.3,direction:'vertical'},
  leaf:{lengthMeters:.18,widthMeters:.08,veinSpacingMeters:.015,veins:.7,edgeSerration:.2,damage:.05,outline:'pointed'},
  needle:{lengthMeters:.12,widthMeters:.006,taper:.8,veins:.5,damage:0},
  'exposed-wood':{ringMeters:.008,grain:.6,knots:.2,cut:'end'},
};
function object(value:unknown,keys:string[],where:string):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.keys(value).some(k=>!keys.includes(k)))throw Error(where+': expected plain recipe data with supported fields.');return value as Record<string,unknown>;
}
function num(value:unknown,min:number,max:number,where:string,integer=false):number{if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||integer&&!Number.isInteger(value))throw Error(where+': number outside bounds.');return value;}
function pair(value:unknown,where:string){if(!Array.isArray(value)||value.length!==2)throw Error(where+': expected two dimensions.');return Array.from(value,v=>num(v,0.002,100,where));}
/** Dependency-free counterpart to materialGeneratorSchema, safe in authoritative game logic. */
export function parseMaterialGeneratorData(input:unknown):ResolvedMaterialGenerator{
  const data=object(input,[...Object.keys(common),'output','pattern','optics','fracture'],'Material generator');
  const raw=object(data.pattern,['family',...new Set(Object.values(patterns).flatMap(p=>Object.keys(p)))],'Pattern'),family=raw.family;
  if(typeof family!=='string'||!Object.hasOwn(patterns,family))throw Error('Unknown material family.');
  object(raw,['family',...Object.keys(patterns[family])],'Pattern');
  const defined=(value:Record<string,unknown>)=>Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined));
  const result={...common,...defined(data),pattern:{...patterns[family],...defined(raw)},output:{resolution:256,style:'realistic',paletteSteps:8,...defined(object(data.output===undefined?{}:data.output,['resolution','style','paletteSteps'],'Output'))}};
  if(data.fracture!==undefined)Object.assign(result,{fracture:parseMaterialFracture(data.fracture)});
  if(data.optics!==undefined){const optics={transmission:0,ior:1.5,thicknessMeters:.02,attenuationColor:'#ffffff',attenuationDistanceMeters:1,envMapIntensity:1,...defined(object(data.optics,['transmission','ior','thicknessMeters','attenuationColor','attenuationDistanceMeters','envMapIntensity'],'Optics'))};
    num(optics.transmission,0,1,'Transmission');num(optics.ior,1,2.5,'IOR');num(optics.thicknessMeters,0,2,'Thickness');num(optics.attenuationDistanceMeters,.001,100,'Attenuation distance');num(optics.envMapIntensity,0,4,'Environment intensity');if(typeof optics.attenuationColor!=='string'||!/^#[0-9a-f]{6}$/i.test(optics.attenuationColor))throw Error('Invalid attenuation color.');Object.assign(result,{optics});
  }
  if(result.version!==1)throw Error('Unsupported material version.');num(result.seed,-2147483648,2147483647,'Seed',true);
  if(typeof result.name!=='string'||result.name.length<1||result.name.length>120)throw Error('Invalid material name.');
  for(const key of ['color','secondaryColor']as const)if(typeof result[key]!=='string'||!/^#[0-9a-f]{6}$/i.test(result[key]))throw Error('Invalid material color.');
  result.tileMeters=pair(result.tileMeters,'Tile size');for(const key of ['variation','roughness','weathering']as const)num(result[key],0,1,key);num(result.reliefMeters,0,0.2,'Relief');
  for(const[key,value]of Object.entries(result.pattern)){
    if(key==='family')continue;
    if(key==='blockMeters'){result.pattern[key]=pair(value,key);continue;}
    const choices:Record<string,string[]>={shape:['rectangle','square','triangle'],bond:['stack','staggered'],direction:['vertical','horizontal'],outline:['pointed','oval','lobed','palmate'],cut:['end','lengthwise']};
    if(choices[key]){if(!choices[key].includes(String(value)))throw Error('Invalid '+key);continue;}
    num(value,key.endsWith('Meters')&&!['mortarMeters','gapMeters'].includes(key)?0.002:0,key==='mortarMeters'?0.1:key==='gapMeters'?0.05:key.endsWith('Meters')?100:1,key);
  }
  if(![32,64,128,256,512,1024,2048].includes(result.output.resolution))throw Error('Invalid material resolution.');
  if(!['realistic','stylized','pixel'].includes(result.output.style))throw Error('Invalid material style.');num(result.output.paletteSteps,2,32,'Palette steps',true);
  if(family==='masonry'&&(result.pattern.mortarMeters as number)>=Math.min(...result.pattern.blockMeters as number[])/2)throw Error('Mortar must be thinner than half a block.');
  if(family==='wood'&&(result.pattern.gapMeters as number)>=(result.pattern.plankMeters as number)/2)throw Error('Gap must be thinner than half a plank.');
  return result as ResolvedMaterialGenerator;
}
