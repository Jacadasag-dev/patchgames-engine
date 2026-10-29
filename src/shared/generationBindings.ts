import {compileGenerationMaps,type GenerationMapRecipe,type GenerationSampleContext,type GenerationSpace,type GenerationUnit} from './generationMaps.ts';

/** Generator-owned capability metadata. Bindings never write arbitrary recipe paths. */
export interface GenerationTarget {
  id:string;unit:GenerationUnit;range:readonly[number,number];integer?:boolean;
  effect:'geometry'|'material'|'presentation';stage:'prepare'|'runtime';
  spaces:readonly GenerationSpace[];scopes:readonly('object'|'part')[];
}
export interface GenerationBinding {id:string;target:string;map:string;range:readonly[number,number];operation?:'replace'|'multiply';mask?:string}
export function compileGenerationBindings(graph:GenerationMapRecipe,input:readonly GenerationBinding[],targets:readonly GenerationTarget[]){
  const plain=(v:unknown)=>!!v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
  const data=(v:object)=>Reflect.ownKeys(v).every(k=>typeof k==='string'&&'value'in Object.getOwnPropertyDescriptor(v,k)!);
  const dense=(v:unknown):v is unknown[]=>Array.isArray(v)&&data(v)&&Object.keys(v).length===v.length;
  const range=(v:unknown):v is [number,number]=>dense(v)&&v.length===2&&v.every(Number.isFinite)&&Number(v[0])<=Number(v[1]);
  function validTarget(t:GenerationTarget){
    return plain(t)&&data(t)&&typeof t.id==='string'&&t.id.length>0&&t.id.length<=100
      &&['normalized','metres','radians','scalar'].includes(t.unit)&&range(t.range)
      &&['geometry','material','presentation'].includes(t.effect)&&['prepare','runtime'].includes(t.stage)
      &&(t.stage!=='runtime'||t.effect==='presentation')&&(t.integer===undefined||typeof t.integer==='boolean')
      &&dense(t.spaces)&&t.spaces.every((s:unknown)=>['world','object','surface'].includes(s as string))
      &&dense(t.scopes)&&t.scopes.every((s:unknown)=>['object','part'].includes(s as string));
  }
  if(!dense(targets)||targets.length>128||!targets.every(validTarget))throw Error('Invalid generation target contract: check units, range, domains and stage/effect.');
  const maps=compileGenerationMaps(graph),registry=new Map(targets.map(t=>[t.id,Object.freeze({...t,range:Object.freeze([...t.range]) as readonly[number,number],spaces:Object.freeze([...t.spaces]),scopes:Object.freeze([...t.scopes])})]));
  if(registry.size!==targets.length)throw Error('Generation target IDs must be unique.');
  if(!dense(input)||input.length>16)throw Error('Generation bindings require at most 16 bindings.');
  const ids=new Set<string>(),writes=new Set<string>();
  const bindings=input.map(value=>{
    if(!plain(value)||!data(value)||Object.keys(value).some(k=>!['id','target','map','range','operation','mask'].includes(k)))throw Error('Use supported plain generation binding fields, not accessors.');
    if(!range(value.range))throw Error('Binding '+value.id+': provide two ordered finite range endpoints.');
    if(value.mask!==undefined&&(typeof value.mask!=='string'||!value.mask.length))throw Error('Binding '+value.id+': mask requires a map ID.');
    const b={...value,range:Object.freeze([...value.range]) as readonly[number,number],operation:value.operation??'replace'},t=registry.get(b.target);
    const fail=(message:string):never=>{throw Error('Binding '+b.id+' ('+b.target+'): '+message);};
    if(typeof b.id!=='string'||!b.id.length||b.id.length>80||ids.has(b.id))fail('use a unique stable binding ID.');ids.add(b.id);
    if(!t)fail('unknown target; choose a registered generator parameter.');
    if(writes.has(b.target))fail('multiple writes; combine maps before binding.');writes.add(b.target);
    if(!['replace','multiply'].includes(b.operation)||b.range.length!==2||!b.range.every(Number.isFinite)||b.range[0]>b.range[1])fail('use an ordered finite range and replace/multiply operation.');
    if(b.operation==='replace'&&(b.range[0]<t!.range[0]||b.range[1]>t!.range[1]))fail('range exceeds target bounds '+t!.range.join('..')+'.');
    if(b.operation==='multiply'&&(b.range[0]<0||b.range[1]>4))fail('multipliers must fit 0..4; resolved values still obey target bounds.');
    for(const id of [b.map,...(b.mask?[b.mask]:[])]){const o=maps.output(id);
      if(o.unit!=='normalized'||o.range[0]<0||o.range[1]>1)fail('map '+id+' must output normalized 0..1 values; use a remap.');
      if(o.dynamic&&t!.stage!=='runtime')fail('time-dependent maps cannot rebuild prepared geometry/materials.');
      if(o.spaces.some(s=>!t!.spaces.includes(s))||o.scopes.some(s=>!t!.scopes.includes(s)))fail('map '+id+' requires an unsupported coordinate space or sampling scope.');
    }
    return Object.freeze(b);
  });
  const revision=maps.revision+':'+JSON.stringify([...bindings].sort((a,b)=>a.id.localeCompare(b.id)))+':'+JSON.stringify([...writes].sort().map(id=>registry.get(id)));
  const totalCost=bindings.reduce((n,b)=>n+maps.output(b.map).cost+(b.mask?maps.output(b.mask).cost:0),0);if(totalCost>4096)throw Error('Generation binding sampling cost exceeds 4096; simplify maps or bindings.');
  const sample=(context:GenerationSampleContext={},baseValues:Readonly<Record<string,number>>={})=>{
    const result:Record<string,number>={};
    for(const b of bindings){const t=registry.get(b.target)!,base=baseValues[b.target];
      if(!Number.isFinite(base)||base<t.range[0]||base>t.range[1])throw Error('Binding '+b.id+': provide a valid base value for '+b.target+'.');
      const v=maps.sample(b.map,context),mapped=b.range[0]+(b.range[1]-b.range[0])*v,mask=b.mask?maps.sample(b.mask,context):1;
      let out=b.operation==='multiply'?base*(1+(mapped-1)*mask):base+(mapped-base)*mask;
      if(t.integer)out=Math.round(out);
      if(!Number.isFinite(out)||out<t.range[0]||out>t.range[1])throw Error('Binding '+b.id+': resolved '+out+' exceeds '+b.target+' bounds '+t.range.join('..')+'. Reduce its range.');
      result[b.target]=out;
    }return result;
  };
  return{graph:maps.recipe,bindings:Object.freeze(bindings),revision,sample,
    inspect(context:GenerationSampleContext={},baseValues:Readonly<Record<string,number>>={}){const values=sample(context,baseValues);return{revision,values,bindings:bindings.map(b=>({binding:b,target:registry.get(b.target),source:maps.inspect(b.map,context),...(b.mask?{mask:maps.inspect(b.mask,context)}:{})}))};}};
}
