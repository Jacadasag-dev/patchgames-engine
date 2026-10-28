/** Lossless host transport for large immutable placement meshes. The public
 * manifest remains ordinary objects; only the host envelope uses this codec. */
import type {WaterSystemManifest} from './waterSystem.ts';
import type {WaterWorldManifest} from './waterWorld.ts';
import {createImmutableWaterBoundaryData,createImmutableWaterBoundaryObjectFactory,sameWaterBoundaryMesh,validateWaterBoundaryMesh,type WaterBoundaryMesh} from './waterBoundaryGeometry.ts';

const MAX_BYTES=768*1024,MAX_NODES=300000,MAX_DEPTH=32,MAX_STRINGS=65536;
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const alphabetValues=new Int16Array(128).fill(-1);
for(let i=0;i<alphabet.length;i++)alphabetValues[alphabet.charCodeAt(i)]=i;
interface MeshTransfer {version:'water-mesh-transfer-v1';numbers:string;structure:string;strings:string[];shapes:number[][]}
export interface WaterSystemTransfer {value:WaterSystemManifest;boundaryMesh?:MeshTransfer}
export interface WaterWorldTransfer {value:WaterWorldManifest;boundaryMeshes?:Array<MeshTransfer|null>}

function base64(bytes:Uint8Array):string {
  const parts:string[]=[];let text='';
  for(let i=0;i<bytes.length;i+=3){const a=bytes[i],b=bytes[i+1]??0,c=bytes[i+2]??0;text+=alphabet[a>>2]+alphabet[(a&3)<<4|b>>4]+(i+1<bytes.length?alphabet[(b&15)<<2|c>>6]:'=')+(i+2<bytes.length?alphabet[c&63]:'=');if(text.length>=8192){parts.push(text);text='';}}
  parts.push(text);return parts.join('');
}
function unbase64(value:string):Uint8Array {
  if(typeof value!=='string'||value.length>MAX_BYTES*4/3||value.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw new Error('Invalid water mesh transfer base64');
  const padding=value.endsWith('==')?2:value.endsWith('=')?1:0,bytes=new Uint8Array(value.length/4*3-padding);let at=0;
  for(let i=0;i<value.length;i+=4){const a=alphabetValues[value.charCodeAt(i)],b=alphabetValues[value.charCodeAt(i+1)],c=alphabetValues[value.charCodeAt(i+2)],d=alphabetValues[value.charCodeAt(i+3)];
    if(a<0||b<0||c<0&&i+4!==value.length||d<0&&i+4!==value.length||i+4===value.length&&(padding===2&&(b&15)!==0||padding===1&&(c&3)!==0))throw new Error('Invalid water mesh transfer base64');
    bytes[at++]=a<<2|b>>4;if(at<bytes.length)bytes[at++]=(b&15)<<4|c>>2;if(at<bytes.length)bytes[at++]=(c&3)<<6|d;
  }return bytes;
}

/** Charge retained numeric/index storage as well as encoded JSON. Shared
 * active/display polygons, cells and faces are counted only once. */
export function waterMeshTransferStorage(mesh:WaterBoundaryMesh|undefined):number {
  if(!mesh)return 0;const seen=new Set<object>();let bytes=0,nodes=0;
  const visit=(value:unknown,depth:number)=>{if(++nodes>MAX_NODES||depth>MAX_DEPTH)throw new Error('Water mesh transfer graph budget exceeded');
    if(typeof value==='number'){bytes+=8;return;}if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);for(const child of Object.values(value))visit(child,depth+1);};
  visit(mesh,0);return bytes;
}

function encodeMesh(mesh:WaterBoundaryMesh):MeshTransfer {
  const numbers:number[]=[],numberIds=new Map<number|string,number>(),strings:string[]=[],stringIds=new Map<string,number>(),shapes:number[][]=[],shapeIds=new Map<string,number>(),structure:number[]=[],objects=new Map<object,number>(),active=new Set<object>();let nodes=0,stringBytes=0;
  const uint=(n:number)=>{do{const byte=n%128;n=Math.floor(n/128);structure.push(byte|(n?128:0));}while(n);if(structure.length+numbers.length*8>MAX_BYTES)throw new Error('Water mesh transfer byte budget exceeded');};
  const string=(s:string)=>{let id=stringIds.get(s);if(id===undefined){if(strings.length>=MAX_STRINGS||s.length>1024||(stringBytes+=s.length)>MAX_BYTES)throw new Error('Water mesh transfer string budget exceeded');id=strings.length;strings.push(s);stringIds.set(s,id);}return id;};
  const visit=(value:unknown,depth:number)=>{
    if(++nodes>MAX_NODES||depth>MAX_DEPTH)throw new Error('Water mesh transfer graph budget exceeded');
    if(value===null){uint(0);return;}if(value===false){uint(1);return;}if(value===true){uint(2);return;}
    if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('Non-finite water mesh transfer value');const key=Object.is(value,-0)?'-0':value;let id=numberIds.get(key);if(id===undefined){id=numbers.length;numbers.push(value);numberIds.set(key,id);}uint(id*8+3);return;}
    if(typeof value==='string'){uint(string(value)*8+4);return;}
    if(!value||typeof value!=='object'||active.has(value))throw new Error('Invalid water mesh transfer graph');
    const prior=objects.get(value);if(prior!==undefined){uint(prior*8+7);return;}objects.set(value,objects.size);active.add(value);
    if(Array.isArray(value)){uint(value.length*8+5);for(const child of value)visit(child,depth+1);}
    else{if(Object.getPrototypeOf(value)!==Object.prototype)throw new Error('Invalid water mesh transfer object');const entries=Object.entries(value),keys=entries.map(([key])=>string(key)),signature=keys.join(',');let shape=shapeIds.get(signature);if(shape===undefined){if(shapes.length>=64||keys.length>32)throw new Error('Water mesh transfer shape budget exceeded');shape=shapes.length;shapes.push(keys);shapeIds.set(signature,shape);}uint(shape*8+6);for(const [,child] of entries)visit(child,depth+1);}
    active.delete(value);
  };
  visit(mesh,0);const data=new Uint8Array(numbers.length*8),view=new DataView(data.buffer);numbers.forEach((n,i)=>view.setFloat64(i*8,n,true));
  return{version:'water-mesh-transfer-v1',numbers:base64(data),structure:base64(Uint8Array.from(structure)),strings,shapes};
}
function decodeMesh(packet:MeshTransfer):WaterBoundaryMesh {
  if(!packet||packet.version!=='water-mesh-transfer-v1'||Object.keys(packet).some(k=>!['version','numbers','structure','strings','shapes'].includes(k))||!Array.isArray(packet.strings)||packet.strings.length>MAX_STRINGS||packet.strings.some(s=>typeof s!=='string'||s.length>1024)||packet.strings.reduce((n,s)=>n+s.length,0)>MAX_BYTES||!Array.isArray(packet.shapes)||packet.shapes.length>64||packet.shapes.some(keys=>!Array.isArray(keys)||keys.length>32||new Set(keys).size!==keys.length||keys.some(id=>!Number.isSafeInteger(id)||id<0||id>=packet.strings.length||packet.strings[id]==='__proto__')))throw new Error('Invalid water mesh transfer packet');
  const numbers=unbase64(packet.numbers),structure=unbase64(packet.structure);if(numbers.length%8||numbers.length+structure.length>MAX_BYTES)throw new Error('Water mesh transfer byte budget exceeded');
  const data=new DataView(numbers.buffer),values:number[]=Array(numbers.length/8),objects:(object|undefined)[]=[],active:boolean[]=[];
  for(let i=0;i<values.length;i++){const value=data.getFloat64(i*8,true);if(!Number.isFinite(value))throw new Error('Non-finite water mesh transfer value');values[i]=value;}
  const shapeNames=packet.shapes.map(keys=>keys.map(key=>packet.strings[key])),shapeConstructors=shapeNames.map(createImmutableWaterBoundaryObjectFactory);let at=0,nodes=0;
  const uint=()=>{if(at>=structure.length)throw new Error('Truncated water mesh transfer');const first=structure[at++];if(first<128)return first;
    let result=first&127,multiplier=128;for(let k=1;k<5;k++){if(at>=structure.length)throw new Error('Truncated water mesh transfer');const byte=structure[at++];result+=(byte&127)*multiplier;if(result>0xffffffff)throw new Error('Invalid water mesh transfer integer');if(!(byte&128)){if(byte===0)throw new Error('Noncanonical water mesh transfer integer');return result;}multiplier*=128;}throw new Error('Invalid water mesh transfer integer');};
  const visit=(depth:number):unknown=>{
    if(++nodes>MAX_NODES||depth>MAX_DEPTH)throw new Error('Water mesh transfer graph budget exceeded');const token=uint(),kind=token&7,id=token>>>3;
    if(kind<3){if(id)throw new Error('Invalid water mesh transfer tag');return kind===0?null:kind===2;}
    if(kind===3){if(id>=values.length)throw new Error('Invalid water mesh transfer number reference');return values[id];}
    if(kind===4){if(id>=packet.strings.length)throw new Error('Invalid water mesh transfer string reference');return packet.strings[id];}
    if(kind===7){if(id>=objects.length||active[id])throw new Error('Invalid water mesh transfer object reference');return objects[id];}
    if(kind===6&&id>=shapeNames.length)throw new Error('Invalid water mesh transfer shape reference');const keys=kind===6?shapeNames[id]:[],count=kind===5?id:keys.length;if(count>MAX_NODES-nodes||count>structure.length-at)throw new Error('Water mesh transfer collection budget exceeded');
    const objectId=objects.length;objects.push(undefined);active[objectId]=true;
    const value=kind===5?createImmutableWaterBoundaryData(count,()=>visit(depth+1)):shapeConstructors[id](()=>visit(depth+1));
    objects[objectId]=value;active[objectId]=false;return value;
  };
  const mesh=visit(0) as WaterBoundaryMesh;if(at!==structure.length)throw new Error('Trailing water mesh transfer data');return mesh;
}

export function encodeWaterSystemTransfer(system:WaterSystemManifest):WaterSystemTransfer {
  if(!system.water.boundaryMesh)return{value:system};
  const {boundaryMesh,...water}=system.water;
  return{value:{...system,water},boundaryMesh:encodeMesh(boundaryMesh)};
}
export function decodeWaterSystemTransfer(answer:WaterSystemTransfer):WaterSystemManifest {
  if(!answer.boundaryMesh)return answer.value;
  const system=answer.value;if(!system?.water?.boundaryCells||system.water.boundaryMesh)throw new Error('Invalid water mesh transfer manifest');
  const mesh=decodeMesh(answer.boundaryMesh);validateWaterBoundaryMesh(system.water,mesh);
  return{...system,water:{...system.water,boundaryMesh:mesh}};
}

/** A world uses the same exact per-layer mesh codec and the same outer bridge
 * byte cap. Static topology is compiled once by the trusted water engine. */
export function encodeWaterWorldTransfer(world:WaterWorldManifest):WaterWorldTransfer {
  const packets=world.layers.map(layer=>encodeWaterSystemTransfer(layer.system));
  return{value:{...world,layers:world.layers.map((layer,i)=>({...layer,system:packets[i].value}))},boundaryMeshes:packets.map(packet=>packet.boundaryMesh??null)};
}
export function decodeWaterWorldTransfer(answer:WaterWorldTransfer):WaterWorldManifest {
  const world=answer?.value,meshes=answer?.boundaryMeshes;
  if(!world||world.version!=='water-world-v1'||!Array.isArray(world.layers)||!world.layers.length||world.layers.length>8
    ||!Array.isArray(meshes)||meshes.length!==world.layers.length)throw new Error('Invalid water world transfer layers');
  for(let i=0;i<meshes.length;i++)if(!Object.hasOwn(meshes,i)||!world.layers[i]?.system?.water||meshes[i]===null&&world.layers[i].system.water.boundaryCells
    ||meshes[i]!==null&&(!meshes[i]||typeof meshes[i]!=='object'))throw new Error('Invalid water world transfer mesh');
  return{...world,layers:world.layers.map((layer,i)=>({...layer,system:decodeWaterSystemTransfer({value:layer.system,...(meshes[i]===null?{}:{boundaryMesh:meshes[i]})})}))};
}

/** Raw-state operations also carry immutable geometry. A compiled reference
 * keeps large create/decode/step calls within the same transfer cap; edited
 * geometry is literal and receives the same structural validation. */
function mapStateMesh(value:unknown,map:(mesh:unknown)=>unknown):unknown {
  if(!value||typeof value!=='object')return value;
  const record=value as Record<string,any>,state=record.water?record:record.state;
  if(!state?.water?.boundary?.mesh)return value;
  const mesh=map(state.water.boundary.mesh);if(mesh===state.water.boundary.mesh)return value;
  const next={...state,water:{...state.water,boundary:{...state.water.boundary,mesh}}};return state===record?next:{...record,state:next};
}
export function encodeWaterStateTransfer(system:WaterSystemManifest,value:unknown):unknown {
  return mapStateMesh(value,raw=>{
    const mesh=raw as WaterBoundaryMesh,base=system.water.boundaryMesh;
    return base&&sameWaterBoundaryMesh(mesh,base)?{waterMeshTransfer:'manifest',revision:base.revision}:{waterMeshTransfer:'literal',data:encodeMesh(mesh)};
  });
}
export function decodeWaterStateTransfer(system:WaterSystemManifest,value:unknown):unknown {
  return mapStateMesh(value,raw=>{
    const marker=raw as Record<string,any>;if(!Object.hasOwn(marker,'waterMeshTransfer'))return raw;
    let mesh:WaterBoundaryMesh;
    if(marker.waterMeshTransfer==='manifest'&&Object.keys(marker).length===2&&marker.revision===system.water.boundaryMesh?.revision)mesh=system.water.boundaryMesh!;
    else if(marker.waterMeshTransfer==='literal'&&Object.keys(marker).length===2){mesh=decodeMesh(marker.data);validateWaterBoundaryMesh(system.water,mesh);}
    else throw new Error('Invalid water state mesh transfer reference');
    return mesh;
  });
}
