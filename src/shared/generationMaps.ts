/** Serializable, deterministic generation fields. No renderer, editor or executable callbacks. */
export type GenerationUnit='normalized'|'metres'|'radians'|'scalar';
export type GenerationSpace='world'|'object'|'surface';
export interface GenerationSampleContext {
  world?:readonly[number,number,number];object?:readonly[number,number,number];surface?:readonly[number,number,number];
  objectId?:string;partId?:string;timeSeconds?:number;
}
export type GenerationMapNode=
 |{type:'constant';value:number;unit?:GenerationUnit}
 |{type:'noise';space:GenerationSpace;scaleMeters:number;octaves?:number;seed?:number;ridged?:boolean}
 |{type:'gradient';space:GenerationSpace;axis:'x'|'y'|'z';from:number;to:number}
 |{type:'distance';space:GenerationSpace;center:readonly[number,number,number];radiusMeters:number}
 |{type:'random';scope:'object'|'part';channel?:string}
 |{type:'add';inputs:readonly{map:string;weight?:number}[]}
 |{type:'mix';inputs:readonly{map:string;weight?:number}[];fallback?:number}
 |{type:'multiply';inputs:readonly string[]}
 |{type:'remap';input:string;from:readonly[number,number];to:readonly[number,number];unit?:GenerationUnit;clamp?:boolean}
 |{type:'clamp';input:string;range:readonly[number,number]}
 |{type:'time';periodSeconds:number};
export interface GenerationMapRecipe {kind:'generation-maps';version:1;seed:number;maps:Record<string,GenerationMapNode>}
export interface GenerationOutput {unit:GenerationUnit;range:readonly[number,number];dynamic:boolean;cost:number;spaces:readonly GenerationSpace[];scopes:readonly('object'|'part')[]}
export interface GenerationInspection {mapId:string;revision:string;value:number;output:GenerationOutput;context:GenerationSampleContext;trace:readonly{mapId:string;type:GenerationMapNode['type'];value:number;output:GenerationOutput}[]}
export interface CompiledGenerationMaps {readonly recipe:GenerationMapRecipe;readonly revision:string;sample(mapId:string,context?:GenerationSampleContext):number;output(mapId:string):GenerationOutput;inspect(mapId:string,context?:GenerationSampleContext):GenerationInspection}
export const GENERATION_MAP_LIMITS=Object.freeze({maps:64,depth:16,inputs:16,cost:4096});
export class GenerationMapError extends Error {readonly code:string;readonly mapId?:string;constructor(code:string,message:string,mapId?:string){super((typeof mapId==='string'?'Map '+mapId+': ':'Generation maps: ')+message);this.name='GenerationMapError';this.code=code;this.mapId=typeof mapId==='string'?mapId:undefined;}}
const units:readonly GenerationUnit[]=['normalized','metres','radians','scalar'],spaces:readonly GenerationSpace[]=['world','object','surface'];
const idPattern=/^[a-z][a-z0-9._-]{0,79}$/i;
const fail=(code:string,message:string,id?:string):never=>{throw new GenerationMapError(code,message,id);};
function plain(value:unknown,keys:readonly string[],id?:string):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail('invalid-data','expected supported plain recipe data.',id);if(Object.getOwnPropertySymbols(value).length)fail('invalid-data','symbol fields are not serializable.',id);for(const key of Object.getOwnPropertyNames(value)){if(!keys.includes(key))fail('unknown-field','unsupported field '+key+'.',id);const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value'in d)||!d.enumerable)fail('invalid-data','accessors and hidden properties are not recipe data.',id);}return value as Record<string,unknown>;}
function finite(value:unknown,name:string,id?:string,min=-1e9,max=1e9){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)fail('invalid-number',name+' must be finite in ['+min+', '+max+'].',id);return value as number;}
function integer(value:unknown,name:string,id?:string,min=-2147483648,max=2147483647){const n=finite(value,name,id,min,max);if(!Number.isInteger(n))fail('invalid-number',name+' must be an integer.',id);return n;}
function mapId(value:unknown,id?:string){if(typeof value!=='string'||!idPattern.test(value))fail('invalid-id','use a stable alphanumeric map ID starting with a letter (max 80 characters).',id);return value as string;}
function unit(value:unknown,id:string){if(typeof value!=='string'||!units.includes(value as GenerationUnit))fail('invalid-unit','unknown output unit.',id);return value as GenerationUnit;}
function space(value:unknown,id:string){if(typeof value!=='string'||!spaces.includes(value as GenerationSpace))fail('invalid-space','space must be world, object or surface.',id);return value as GenerationSpace;}
function dataArray(value:unknown,id:string){if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||Object.getOwnPropertySymbols(value).length||Object.keys(value).length!==value.length)fail('invalid-data','expected a dense serializable array.',id);for(let i=0;i<(value as unknown[]).length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d))fail('invalid-data','array accessors and sparse entries are not recipe data.',id);}return value as unknown[];}
function tuple(value:unknown,size:2,id:string):[number,number];
function tuple(value:unknown,size:3,id:string):[number,number,number];
function tuple(value:unknown,size:number,id:string):number[]{const array=dataArray(value,id);if(array.length!==size)fail('invalid-range','expected '+size+' finite coordinates.',id);return array.map(v=>finite(v,'coordinate',id));}
function flag(value:unknown,name:string,id:string){if(typeof value!=='boolean')fail('invalid-data',name+' must be boolean.',id);return value as boolean;}
function inputs(value:unknown,id:string){const array=dataArray(value,id);if(!array.length||array.length>GENERATION_MAP_LIMITS.inputs)fail('input-budget','use 1–16 inputs.',id);return array;}
function parseNode(input:unknown,id:string):GenerationMapNode{
 const raw=plain(input,['type','value','unit','space','scaleMeters','octaves','seed','ridged','axis','from','to','center','radiusMeters','scope','channel','inputs','fallback','input','clamp','range','periodSeconds'],id);
 if(typeof raw.type!=='string')fail('unknown-node','map type must be a supported string.',id);
 switch(raw.type){
 case'constant':{plain(raw,['type','value','unit'],id);const n=finite(raw.value,'value',id),u=raw.unit===undefined?'scalar':unit(raw.unit,id);if(u==='normalized'&&(n<0||n>1))fail('invalid-range','normalized constants must be in [0,1].',id);return{type:'constant',value:n,unit:u};}
 case'noise':plain(raw,['type','space','scaleMeters','octaves','seed','ridged'],id);return{type:'noise',space:space(raw.space,id),scaleMeters:finite(raw.scaleMeters,'scaleMeters',id,.001,1e6),octaves:integer(raw.octaves??1,'octaves',id,1,8),seed:integer(raw.seed??0,'seed',id),ridged:raw.ridged===undefined?false:flag(raw.ridged,'ridged',id)};
 case'gradient':{plain(raw,['type','space','axis','from','to'],id);if(typeof raw.axis!=='string'||!['x','y','z'].includes(raw.axis))fail('invalid-axis','axis must be x, y or z.',id);const from=finite(raw.from,'from',id),to=finite(raw.to,'to',id);if(from===to)fail('invalid-range','gradient endpoints must differ.',id);return{type:'gradient',space:space(raw.space,id),axis:raw.axis as 'x'|'y'|'z',from,to};}
 case'distance':plain(raw,['type','space','center','radiusMeters'],id);return{type:'distance',space:space(raw.space,id),center:tuple(raw.center,3,id),radiusMeters:finite(raw.radiusMeters,'radiusMeters',id,.001,1e6)};
 case'random':{plain(raw,['type','scope','channel'],id);if(typeof raw.scope!=='string'||!['object','part'].includes(raw.scope))fail('invalid-scope','random scope must be object or part.',id);return{type:'random',scope:raw.scope as 'object'|'part',channel:raw.channel===undefined?'value':mapId(raw.channel,id)};}
 case'add':case'mix':{plain(raw,raw.type==='mix'?['type','inputs','fallback']:['type','inputs'],id);const items=inputs(raw.inputs,id).map(input=>{const p=plain(input,['map','weight'],id);return{map:mapId(p.map,id),weight:finite(p.weight??1,'weight',id,raw.type==='mix'?0:-1e6,1e6)};});if(raw.type==='mix'){const sum=items.reduce((s,p)=>s+p.weight,0);if(sum===0&&raw.fallback===undefined)fail('zero-weights','zero-weight mix requires an explicit fallback.',id);return{type:'mix',inputs:items,...(raw.fallback===undefined?{}:{fallback:finite(raw.fallback,'fallback',id)})};}return{type:'add',inputs:items};}
 case'multiply':plain(raw,['type','inputs'],id);return{type:'multiply',inputs:inputs(raw.inputs,id).map(v=>mapId(v,id))};
 case'remap':{plain(raw,['type','input','from','to','unit','clamp'],id);const from=tuple(raw.from,2,id),to=tuple(raw.to,2,id);if(from[0]===from[1])fail('invalid-range','remap input range must have nonzero extent.',id);return{type:'remap',input:mapId(raw.input,id),from,to,...(raw.unit===undefined?{}:{unit:unit(raw.unit,id)}),clamp:raw.clamp===undefined?true:flag(raw.clamp,'clamp',id)};}
 case'clamp':{plain(raw,['type','input','range'],id);const range=tuple(raw.range,2,id);if(range[0]>range[1])fail('invalid-range','clamp bounds must be ordered.',id);return{type:'clamp',input:mapId(raw.input,id),range};}
 case'time':plain(raw,['type','periodSeconds'],id);return{type:'time',periodSeconds:finite(raw.periodSeconds,'periodSeconds',id,.001,1e6)};
 default:return fail('unknown-node','unknown map type '+raw.type+'.',id);
 }
}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const entry of Object.values(value))freeze(entry);Object.freeze(value);}return value;}
function canonical(value:unknown):string{if(Array.isArray(value))return'['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return'{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value);}
function hash(text:string,seed=2166136261){let h=seed;for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619);h=Math.imul(h^(h>>>16),0x7feb352d);h=Math.imul(h^(h>>>15),0x846ca68b);return(h^(h>>>16))>>>0;}
/** Stable signed seed for object/part identities; never include a cache revision. */
export function generationIdentitySeed(seed:number,stableId:string,channel:string):number{integer(seed,'seed');if(typeof stableId!=='string'||!stableId.length||stableId.length>256)fail('invalid-identity','stableId must be a nonempty string up to 256 characters.');if(typeof channel!=='string'||!channel.length||channel.length>256)fail('invalid-identity','channel must be a nonempty string up to 256 characters.');return hash(canonical([seed,stableId,channel]))|0;}
/** Canonical cache fingerprint for bounded plain recipe data. Undefined object
 * fields are omitted, matching JSON; identity randomness must use stable IDs instead. */
export function generationDataRevision(value:unknown):string{
 let count=0,characters=0;const active=new Set<object>();
 const copy=(v:unknown,depth:number):unknown=>{if(++count>65536||depth>32)fail('data-budget','recipe fingerprint exceeds node/depth budget.');
  if(v===null||typeof v==='boolean')return v;
  if(typeof v==='number'){if(!Number.isFinite(v))fail('invalid-data','fingerprints require finite JSON numbers.');return v;}
  if(typeof v==='string'){characters+=v.length;if(characters>1048576)fail('data-budget','recipe fingerprint exceeds 1 MiB character budget.');return v;}
  if(!v||typeof v!=='object')return fail('invalid-data','fingerprints require plain JSON recipe data.');
  if(active.has(v))fail('cycle','cyclic fingerprint data is not allowed.');active.add(v);let result:unknown;
  if(Array.isArray(v)){const a=dataArray(v,'fingerprint');result=a.map(item=>copy(item,depth+1));}
  else{const keys=Object.getOwnPropertyNames(v),r=plain(v,keys,'fingerprint'),entries:[string,unknown][]=[];for(const key of keys){characters+=key.length;if(characters>1048576)fail('data-budget','recipe fingerprint exceeds 1 MiB character budget.');if(r[key]!==undefined)entries.push([key,copy(r[key],depth+1)]);}result=Object.fromEntries(entries);}
  active.delete(v);return result;
 };
 const serialized=canonical(copy(value,0));if(serialized.length>1048576)fail('data-budget','recipe fingerprint exceeds 1 MiB serialized character budget.');
 return'generation-data-v1:'+Array.from([2166136261,0x9e3779b9,0x85ebca6b,0xc2b2ae35],seed=>hash(serialized,seed).toString(16).padStart(8,'0')).join('');
}
function randomKey(seed:number,id:string,channel:string){return hash(canonical([seed,id,channel]))/4294967296;}
const clamp01=(n:number)=>Math.max(0,Math.min(1,n));
function valueNoise(x:number,y:number,z:number,seed:number){const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z),s=(t:number)=>t*t*(3-2*t),fx=s(x-ix),fy=s(y-iy),fz=s(z-iz);let value=0;for(let dz=0;dz<2;dz++)for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){let h=Math.imul((ix+dx)^seed,374761393)^Math.imul(iy+dy,668265263)^Math.imul(iz+dz,1274126177);h=Math.imul(h^(h>>>13),1274126177);value+=((h^(h>>>16))>>>0)/4294967296*(dx?fx:1-fx)*(dy?fy:1-fy)*(dz?fz:1-fz);}return value;}
function refs(node:GenerationMapNode):string[]{switch(node.type){case'add':case'mix':return node.inputs.map(p=>p.map);case'multiply':return[...node.inputs];case'remap':case'clamp':return[node.input];default:return[];}}
function dimensionless(u:GenerationUnit){return u==='scalar'||u==='normalized';}
function sameUnits(outputs:GenerationOutput[],id:string):GenerationUnit{const physical=[...new Set(outputs.map(o=>o.unit).filter(u=>!dimensionless(u)))];if(physical.length>1||physical.length&&outputs.some(o=>dimensionless(o.unit)))fail('unit-mismatch','add/mix inputs must share units; remap normalized fields to the intended physical unit first.',id);return physical[0]??'scalar';}
function checkedRange(range:readonly[number,number],id:string):[number,number]{if(!range.every(Number.isFinite)||Math.max(Math.abs(range[0]),Math.abs(range[1]))>1e12)fail('range-budget','output range exceeds finite generation bounds; reduce input ranges/weights.',id);return[range[0],range[1]];}
function outputFor(node:GenerationMapNode,children:GenerationOutput[],id:string):Omit<GenerationOutput,'cost'|'spaces'|'scopes'>{
 let u:GenerationUnit='normalized',range:[number,number]=[0,1];
 switch(node.type){
 case'constant':u=node.unit??'scalar';range=[node.value,node.value];break;
 case'add':{u=sameUnits(children,id);range=[0,0];node.inputs.forEach((p,i)=>{const w=p.weight??1,a=children[i].range[0]*w,b=children[i].range[1]*w;range[0]+=Math.min(a,b);range[1]+=Math.max(a,b);});if(u==='scalar'&&children.every(o=>o.unit==='normalized')&&range[0]>=0&&range[1]<=1)u='normalized';break;}
 case'mix':{u=sameUnits(children,id);const total=node.inputs.reduce((s,p)=>s+(p.weight??1),0);if(total===0)range=[node.fallback!,node.fallback!];else{range=[0,0];node.inputs.forEach((p,i)=>{const w=(p.weight??1)/total;range[0]+=children[i].range[0]*w;range[1]+=children[i].range[1]*w;});}if(u==='scalar'&&children.every(o=>o.unit==='normalized')&&range[0]>=0&&range[1]<=1)u='normalized';break;}
 case'multiply':{const physical=children.filter(o=>!dimensionless(o.unit));if(physical.length>1)fail('unit-mismatch','multiplication supports one physical-unit input and dimensionless factors.',id);u=physical[0]?.unit??'scalar';range=[1,1];for(const child of children){const products=[range[0]*child.range[0],range[0]*child.range[1],range[1]*child.range[0],range[1]*child.range[1]];range=[Math.min(...products),Math.max(...products)];}if(u==='scalar'&&children.every(o=>o.unit==='normalized')&&range[0]>=0&&range[1]<=1)u='normalized';break;}
 case'remap':{u=node.unit??children[0].unit;const a=(children[0].range[0]-node.from[0])/(node.from[1]-node.from[0]),b=(children[0].range[1]-node.from[0])/(node.from[1]-node.from[0]),map=(n:number)=>node.to[0]+(node.to[1]-node.to[0])*(node.clamp?clamp01(n):n),lo=map(a),hi=map(b);range=[Math.min(lo,hi),Math.max(lo,hi)];if(u==='normalized'&&(range[0]<0||range[1]>1))fail('invalid-unit','remap outside [0,1] needs explicit scalar, metres or radians output units.',id);break;}
 case'clamp':u=children[0].unit;range=[Math.max(node.range[0],Math.min(node.range[1],children[0].range[0])),Math.max(node.range[0],Math.min(node.range[1],children[0].range[1]))];break;
 }
 checkedRange(range,id);if(u==='normalized'&&(range[0]<0||range[1]>1))fail('invalid-unit','normalized outputs must remain in [0,1]; use an explicit remap unit.',id);return{unit:u,range,dynamic:node.type==='time'||children.some(o=>o.dynamic)};
}
function contextCopy(input:GenerationSampleContext):GenerationSampleContext{
 const p=plain(input,['world','object','surface','objectId','partId','timeSeconds']);const result:GenerationSampleContext={};for(const name of spaces)if(p[name]!==undefined){const v=tuple(p[name],3,'context.'+name);result[name]=v;}
 for(const name of ['objectId','partId'] as const)if(p[name]!==undefined){if(typeof p[name]!=='string'||!(p[name] as string).length||(p[name] as string).length>256)fail('invalid-context',name+' must be a nonempty stable ID up to 256 characters.');result[name]=p[name] as string;}
 if(p.timeSeconds!==undefined)result.timeSeconds=finite(p.timeSeconds,'timeSeconds');return result;
}
/** Compile and freeze once during preparation; every sample is stateless and bounded. */
export function compileGenerationMaps(input:unknown):CompiledGenerationMaps{
 const raw=plain(input,['kind','version','seed','maps']);if(raw.kind!=='generation-maps'||raw.version!==1)fail('invalid-version','use kind:generation-maps, version:1.');
 const seed=integer(raw.seed,'seed'),mapsInput=plain(raw.maps,Object.keys((raw.maps&&typeof raw.maps==='object')?raw.maps:{}));const ids=Object.keys(mapsInput).sort();if(!ids.length||ids.length>GENERATION_MAP_LIMITS.maps)fail('map-budget','use 1–64 maps.');
 const nodes=new Map<string,GenerationMapNode>();for(const id of ids){mapId(id);nodes.set(id,parseNode(mapsInput[id],id));}
 const noiseSeeds=new Map<string,readonly number[]>();for(const [id,node]of nodes)if(node.type==='noise'){const nodeSeed=hash(canonical([seed,id,node.seed??0]));noiseSeeds.set(id,Object.freeze(Array.from({length:node.octaves??1},(_,octave)=>hash(String(octave),nodeSeed))));}
 const outputs=new Map<string,GenerationOutput>(),depths=new Map<string,number>(),reachable=new Map<string,Set<string>>(),visiting=new Set<string>();
 const compile=(id:string):GenerationOutput=>{const cached=outputs.get(id);if(cached)return cached;const node=nodes.get(id);if(!node)fail('missing-map','referenced map does not exist.',id);if(visiting.has(id))fail('cycle','cyclic map references are not allowed.',id);visiting.add(id);const dependencies=refs(node!),children=dependencies.map(compile),depth=1+Math.max(0,...dependencies.map(d=>depths.get(d)!));if(depth>GENERATION_MAP_LIMITS.depth)fail('depth-budget','graph depth exceeds 16.',id);const used=new Set<string>([id]);for(const ref of dependencies)for(const key of reachable.get(ref)!)used.add(key);let cost=0;for(const key of used){const n=nodes.get(key)!;cost+=n.type==='noise'?(n.octaves??1)*8:1;}if(cost>GENERATION_MAP_LIMITS.cost)fail('cost-budget','sampling cost exceeds 4096.',id);const domains=[...new Set([...children.flatMap(c=>c.spaces),...('space'in node!?[node!.space]:[])])].sort(),scopes=[...new Set([...children.flatMap(c=>c.scopes??[]),...(node!.type==='random'?[node!.scope]:[])])].sort();const out=freeze({...outputFor(node!,children,id),cost,spaces:domains,scopes});outputs.set(id,out);depths.set(id,depth);reachable.set(id,used);visiting.delete(id);return out;};for(const id of ids)compile(id);
 const maps=Object.fromEntries(ids.map(id=>[id,nodes.get(id)!])),recipe=freeze({kind:'generation-maps' as const,version:1 as const,seed,maps}),revision='generation-maps-v1:'+Array.from([2166136261,0x9e3779b9,0x85ebca6b,0xc2b2ae35],seed=>hash(canonical(recipe),seed).toString(16).padStart(8,'0')).join('');
 const evaluate=(id:string,inputContext:GenerationSampleContext,inspection:boolean)=>{if(!nodes.has(id))fail('missing-map','requested map does not exist.',id);const context=contextCopy(inputContext),memo=new Map<string,number>(),trace:GenerationInspection['trace'][number][]=[];
  const sample=(key:string):number=>{const previous=memo.get(key);if(previous!==undefined)return previous;const node=nodes.get(key)!;let value:number;
   const point=(s:GenerationSpace)=>{const p=context[s];if(!p)fail('missing-frame','requires '+s+' coordinates in metres.',key);return p!;};
   switch(node.type){
   case'constant':value=node.value;break;
   case'noise':{const p=point(node.space),octaveSeeds=noiseSeeds.get(key)!;let sum=0,weight=1,total=0,frequency=1;for(let octave=0;octave<(node.octaves??1);octave++){let n=valueNoise(p[0]/node.scaleMeters*frequency,p[1]/node.scaleMeters*frequency,p[2]/node.scaleMeters*frequency,octaveSeeds[octave]);if(node.ridged)n=1-Math.abs(n*2-1);sum+=n*weight;total+=weight;weight*=.5;frequency*=2;}value=sum/total;break;}
   case'gradient':value=clamp01((point(node.space)[{x:0,y:1,z:2}[node.axis]]-node.from)/(node.to-node.from));break;
   case'distance':{const p=point(node.space);value=clamp01(1-Math.hypot(p[0]-node.center[0],p[1]-node.center[1],p[2]-node.center[2])/node.radiusMeters);break;}
   case'random':{if(!context.objectId||node.scope==='part'&&!context.partId)fail('missing-identity','requires stable objectId'+(node.scope==='part'?' and partId':'')+'.',key);value=randomKey(seed,key,canonical([node.channel??'value',context.objectId,node.scope==='part'?context.partId:null]));break;}
   case'add':value=node.inputs.reduce((n,p)=>n+sample(p.map)*(p.weight??1),0);break;
   case'mix':{const sum=node.inputs.reduce((n,p)=>n+(p.weight??1),0);value=sum===0?node.fallback!:node.inputs.reduce((n,p)=>n+sample(p.map)*(p.weight??1),0)/sum;break;}
   case'multiply':value=node.inputs.reduce((n,key)=>n*sample(key),1);break;
   case'remap':{let t=(sample(node.input)-node.from[0])/(node.from[1]-node.from[0]);if(node.clamp)t=clamp01(t);value=node.to[0]+(node.to[1]-node.to[0])*t;break;}
   case'clamp':value=Math.max(node.range[0],Math.min(node.range[1],sample(node.input)));break;
   case'time':if(context.timeSeconds===undefined)fail('missing-time','requires explicit timeSeconds; never use a local frame clock for generation.',key);value=.5+.5*Math.sin(context.timeSeconds!/node.periodSeconds*Math.PI*2);break;
   }
   if(!Number.isFinite(value!))fail('nonfinite-output','sample produced a nonfinite value.',key);memo.set(key,value!);if(inspection)trace.push({mapId:key,type:node.type,value:value!,output:outputs.get(key)!});return value!;
  };return{value:sample(id),context,trace};
 };
 return Object.freeze({recipe,revision,sample:(id:string,context:GenerationSampleContext={})=>evaluate(id,context,false).value,output:(id:string)=>{const result=outputs.get(id);if(!result)fail('missing-map','requested map does not exist.',id);return result!;},inspect:(id:string,context:GenerationSampleContext={})=>{const result=evaluate(id,context,true);return{mapId:id,revision,value:result.value,output:outputs.get(id)!,context:result.context,trace:result.trace};}});
}
