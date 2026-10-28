import {compileWaterSystem,createWaterSystemState,stepWaterSystem,seedWaterSystemSwell,type WaterSystemManifest,type WaterSystemState} from '../waterSystem.ts';
import {encodeWaterSystemState,decodeWaterSystemState} from '../waterSystemWire.ts';
import {validatePhysicsScene,validatePhysicsCompoundBodies} from './physics.ts';
import {resolveTerrainChannels,carveTerrainChannels,validateResolvedTerrainChannels} from '../terrainChannels.ts';
import {decodeWaterStateTransfer,encodeWaterStateTransfer,encodeWaterSystemTransfer,encodeWaterWorldTransfer,waterMeshTransferStorage} from '../waterSystemTransfer.ts';
import {compileWaterWorld,WATER_WORLD_LIMITS} from '../waterWorld.ts';

/** Bound parsed JSON before any recursive compiler, schema or serializer runs.
 * Include unknown metadata: otherwise a small deeply nested value can exhaust
 * the host stack despite the outer request size cap. */
function jsonPreflight(value:unknown):void {
  const pending:{value:unknown;depth:number}[]=[{value,depth:0}];let nodes=1;
  while(pending.length){
    const current=pending.pop()!;
    if(current.depth>32)throw new Error('Water request JSON depth budget exceeded');
    if(current.value&&typeof current.value==='object'){
      for(const child of Object.values(current.value)){
        if(++nodes>100000)throw new Error('Water request JSON node budget exceeded');
        pending.push({value:child,depth:current.depth+1});
      }
    }
  }
}

function recipePreflight(recipe: any): void {
  if(!recipe||typeof recipe!=='object'||Array.isArray(recipe))throw new Error('Invalid water recipe');
  for(const name of ['initial','channels','sources','pipes'])if(recipe[name]!==undefined&&(!Array.isArray(recipe[name])||recipe[name].length>32))throw new Error('Water recipe collection budget exceeded');
  if(recipe.channels!==undefined)validateResolvedTerrainChannels(recipe.channels);
  // Validate without replacing authored property order: manifest identities
  // must match the same recipe compiled by the presentation/authoring runtime.
  validatePhysicsScene(recipe.scene);
  let segments=0;
  for(const pipe of recipe.pipes??[]){
    if(!pipe||typeof pipe!=='object')throw new Error('Invalid water pipe');
    if(pipe.path!==undefined){
      if(!Array.isArray(pipe.path)||pipe.path.length<2||pipe.path.length>32)throw new Error('Invalid water pipe route');
      let count=0;
      for(let i=1;i<pipe.path.length;i++){
        const a=pipe.path[i-1],b=pipe.path[i];
        if(!a||!b||['x','y','z'].some(axis=>!Number.isFinite(a[axis])||!Number.isFinite(b[axis])))throw new Error('Invalid water pipe route');
        count+=Math.ceil(Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z)/.3);
        if(count>64)throw new Error('Water pipe segment budget exceeded');
      }
      segments+=count;if(segments>256)throw new Error('Water pipe total segment budget exceeded');
    }
  }
}

/** Exact JSON-value equality: same keys, same strings, Object.is numbers. */
function sameJson(a:unknown,b:unknown):boolean {
  if(typeof a!=='object'||a===null||typeof b!=='object'||b===null)return Object.is(a,b);
  if(Array.isArray(a)){
    if(!Array.isArray(b)||a.length!==b.length)return false;
    for(let i=0;i<a.length;i++)if(!sameJson(a[i],b[i]))return false;
    return true;
  }
  if(Array.isArray(b))return false;
  const keys=Object.keys(a);if(keys.length!==Object.keys(b).length)return false;
  for(const key of keys)if(!Object.prototype.hasOwnProperty.call(b,key)||!sameJson((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key]))return false;
  return true;
}

/** Per-sandbox immutable geometry plus a memo of the last stepped checkpoint.
 * Authoritative water always comes from the caller's checkpoint: the memo is
 * used only when the incoming wire is exactly the one this bridge encoded, and
 * decoding that wire yields the same state. Replay/rollback with any other
 * checkpoint decodes it normally, so results never depend on host history. */
export class WaterBridge {
  private readonly manifests=new Map<string,{system:WaterSystemManifest;source:string;bytes:number}>();
  private bytes=0;
  private stepped:{revision:string;wire:unknown;state:WaterSystemState}|undefined;
  dispatch(json:string):string {
    try {
      if(typeof json!=='string'||json.length>1024*1024)throw new Error('Water request exceeds 1 MiB');
      const input=JSON.parse(json);
      jsonPreflight(input);
      if(!input||typeof input!=='object'||Array.isArray(input)||input.version!=='water-system-host-v1'
        ||Object.keys(input).some(key=>!['version','operation','request'].includes(key)))throw new Error('Invalid water bridge request');
      const request=input.request;
      if(!request||typeof request!=='object'||Array.isArray(request))throw new Error('Water request requires an object');
      let value:unknown,transferSystem:WaterSystemManifest|undefined;
      if(input.operation==='compile-world'){
        if(Object.keys(request).some(key=>key!=='recipe'))throw new Error('Invalid water world compile request');
        recipePreflight(request.recipe);
        if(request.recipe.supports!==undefined&&(!Array.isArray(request.recipe.supports)||request.recipe.supports.length>WATER_WORLD_LIMITS.supports))throw new Error('Water world support budget exceeded');
        const world=compileWaterWorld(request.recipe),output=JSON.stringify(encodeWaterWorldTransfer(world));
        if(output.length>1024*1024)throw new Error('Water response exceeds 1 MiB');
        // Stage all registrations before committing: a rejected world must not
        // leave a partially occupied manifest cache behind.
        const pending=new Map<string,{system:WaterSystemManifest;source:string;bytes:number}>();let bytes=0;
        for(const {system} of world.layers){
          let source=JSON.stringify({value:system});if(source.length>1024*1024)source=JSON.stringify(encodeWaterSystemTransfer(system));
          const previous=this.manifests.get(system.revision)??pending.get(system.revision);
          if(previous&&previous.source!==source)throw new Error('Water manifest identity collision');
          if(!previous){const size=source.length+waterMeshTransferStorage(system.water.boundaryMesh);pending.set(system.revision,{system,source,bytes:size});bytes+=size;}
        }
        if(this.manifests.size+pending.size>16||this.bytes+bytes>4*1024*1024)throw new Error('Water manifest cache budget exceeded');
        for(const [revision,entry] of pending)this.manifests.set(revision,entry);this.bytes+=bytes;return output;
      }else if(input.operation==='compile'){
        if(Object.keys(request).some(key=>key!=='recipe'))throw new Error('Invalid water compile request');
        recipePreflight(request.recipe);
        const system=compileWaterSystem(request.recipe),previous=this.manifests.get(system.revision);
        let output=JSON.stringify({value:system});if(output.length>1024*1024)output=JSON.stringify(encodeWaterSystemTransfer(system));
        if(output.length>1024*1024)throw new Error('Water response exceeds 1 MiB');
        if(previous&&previous.source!==output)throw new Error('Water manifest identity collision');
        if(!previous){
          const bytes=output.length+waterMeshTransferStorage(system.water.boundaryMesh);
          if(this.manifests.size>=16||this.bytes+bytes>4*1024*1024)throw new Error('Water manifest cache budget exceeded');
          this.manifests.set(system.revision,{system,source:output,bytes});this.bytes+=bytes;
        }
        return output;
      }else{
        if(typeof request.revision!=='string'||request.revision.length>128)throw new Error('Water manifest revision required');
        const system=this.manifests.get(request.revision)?.system;
        if(!system)throw new Error('Compile this water system in the current engine before using it');
        transferSystem=system;if(request.state!==undefined)request.state=decodeWaterStateTransfer(system,request.state);
        const allowed=input.operation==='step'||input.operation==='step-wire'
          ?['revision','state','dt','scene','bodies','disabledSources','wind','detail','flightDestination']
          :input.operation==='create'||input.operation==='create-wire'?['revision']:input.operation==='swell'||input.operation==='swell-wire'?['revision','state','swell']:['revision','state'];
        if(Object.keys(request).some(key=>!allowed.includes(key)))throw new Error('Unknown water request field');
        switch(input.operation){
          case 'create':value=createWaterSystemState(system);break;
          case 'create-wire':value=encodeWaterSystemState(system,createWaterSystemState(system));break;
          case 'encode':value=encodeWaterSystemState(system,request.state);break;
          case 'decode':value=decodeWaterSystemState(system,request.state);break;
          case 'swell':case 'swell-wire':{
            const state=input.operation==='swell-wire'?decodeWaterSystemState(system,request.state):request.state;
            const result=seedWaterSystemSwell({system,state,swell:request.swell});
            value=input.operation==='swell-wire'?encodeWaterSystemState(system,result):result;break;
          }
          case 'step':case 'step-wire':{
            if(!Number.isFinite(request.dt)||request.dt<1e-5||request.dt>.05)throw new Error('Invalid water step time');
            if(request.scene!==undefined)request.scene=validatePhysicsScene(request.scene);
            if(request.bodies!==undefined)request.bodies=validatePhysicsCompoundBodies(request.bodies);
            if(request.detail!==undefined&&typeof request.detail!=='boolean')throw new Error('Invalid water detail option');
            if(request.disabledSources!==undefined&&(!Array.isArray(request.disabledSources)||request.disabledSources.length>32||request.disabledSources.some((id:unknown)=>typeof id!=='string'||!id.length||id.length>128)))throw new Error('Invalid disabled water sources');
            // Consume the memo first: a step may advance region solver state in place.
            const memo=this.stepped;this.stepped=undefined;
            if(input.operation==='step'){value=stepWaterSystem({system,state:request.state,dt:request.dt,scene:request.scene,bodies:request.bodies,disabledSources:request.disabledSources,wind:request.wind,detail:request.detail,flightDestination:request.flightDestination});break;}
            const state=memo&&memo.revision===request.revision&&sameJson(request.state,memo.wire)?memo.state:decodeWaterSystemState(system,request.state);
            const result=stepWaterSystem({system,state,dt:request.dt,scene:request.scene,bodies:request.bodies,disabledSources:request.disabledSources,wind:request.wind,detail:request.detail,flightDestination:request.flightDestination});
            const wire=encodeWaterSystemState(system,result.state);
            this.stepped={revision:system.revision,wire,state:result.state};
            value={...result,state:wire};break;
          }
          default:throw new Error('Unknown water operation');
        }
      }
      const output=JSON.stringify({value:transferSystem?encodeWaterStateTransfer(transferSystem,value):value});
      if(output.length>1024*1024)throw new Error('Water response exceeds 1 MiB');return output;
    }catch(error){return JSON.stringify({error:error instanceof Error?error.message.slice(0,1500):'Invalid water request'});}
  }
  dispose():void {this.manifests.clear();this.bytes=0;this.stepped=undefined;}
}

let warmed=false;
/** Fixed trusted fixture removes cold validator/solver JIT from live deadlines.
 * It never runs authored code or retains simulation state between sandboxes. */
export function warmWaterBridge():void {
  if(warmed)return;
  const bridge=new WaterBridge();
  const call=(operation:string,request:unknown)=>{
    const answer=JSON.parse(bridge.dispatch(JSON.stringify({version:'water-system-host-v1',operation,request})));
    if(answer.error)throw new Error(`Water initialization failed: ${answer.error}`);return answer.value;
  };
  try{
    const channels=resolveTerrainChannels([{id:'river',kind:'river',width:4,depth:2,bankWidth:2,points:[{x:0,z:-12,bedY:2},{x:0,z:12,bedY:1}]}],()=>4);
    const heights=Array.from({length:25*25},(_,i)=>carveTerrainChannels(4,Math.floor(i/25)-12,i%25-12,channels));
    const recipes=[
      {id:'trusted-water-pool-warmup',quality:'balanced',scene:{colliders:[],terrain:{columns:1,rows:1,width:8,depth:4,heights:[0,0,0,0]}},bounds:{min:{x:-4,y:-1,z:-2},max:{x:4,y:3,z:2}},initial:[{min:{x:-4,z:-2},max:{x:4,z:2},level:.5,velocity:{x:.3,z:0}}]},
      {id:'trusted-water-river-warmup',quality:'balanced',scene:{colliders:[],terrain:{columns:24,rows:24,width:24,depth:24,heights}},channels,bounds:{min:{x:-12,y:-2,z:-12},max:{x:12,y:8,z:12}},river:{depth:.5,speed:.8,inflow:.15},boundary:'open'},
    ];
    for(const recipe of recipes){
      const system=call('compile',{recipe});let state=call('create-wire',{revision:system.revision});
      for(let i=0;i<24;i++)state=call('step-wire',{revision:system.revision,state,dt:1/30}).state;
    }
    // Small game pools are often economy quality, seeded with a swell and
    // stepped in wind. Those paths otherwise compile during a game's first
    // ticks, which on a slow release host used up a whole 20 ms tick budget.
    const breeze=call('compile',{recipe:{id:'trusted-water-breeze-warmup',quality:'economy',scene:{colliders:[],terrain:{columns:1,rows:1,width:4,depth:2,heights:[0,0,0,0]}},
      bounds:{min:{x:-2,y:-1,z:-1},max:{x:2,y:3,z:1}},initial:[{min:{x:-2,z:-1},max:{x:2,z:1},level:.5,velocity:{x:.3,z:0}}]}});
    let breezeState=call('swell-wire',{revision:breeze.revision,state:call('create-wire',{revision:breeze.revision}),
      swell:{center:{x:0,z:0},direction:{x:1,z:0},height:.1,wavelength:2}});
    for(let i=0;i<24;i++)breezeState=call('step-wire',{revision:breeze.revision,state:breezeState,dt:1/30,wind:{velocity:{x:8,z:1}}}).state;
    // A notched pond over a 2 m step. It drives every phase a live cliff tick
    // meets: flow over the lip, depth currents switching on (~1 s), cells
    // starting to sleep and the dispersive solve. Each changes the body
    // state's shape; compiling before and after those transitions keeps a
    // first live match from deoptimizing the grid solver mid-deadline.
    // A short pass from a fresh checkpoint restores the early-phase shapes.
    const cliff:number[]=[];for(let c=0;c<=24;c++)for(let r=0;r<=12;r++){const x=-4+c/3,z=-2+r/3;cliff.push(x<=-.5?(Math.abs(z)<.8||x<-1.5?2:2.6):0);}
    const falls=call('compile',{recipe:{id:'trusted-water-cliff-warmup',quality:'economy',boundary:'closed',scene:{colliders:[],terrain:{columns:24,rows:12,width:8,depth:4,heights:cliff}},
      bounds:{min:{x:-4,y:-1,z:-2},max:{x:4,y:3.5,z:2}},initial:[{min:{x:-4,z:-2},max:{x:-1.5,z:2},level:2.25}]}});
    for(const steps of [60,12]){
      let fallState=call('create-wire',{revision:falls.revision});
      for(let i=0;i<steps;i++)fallState=call('step-wire',{revision:falls.revision,state:fallState,dt:1/30}).state;
    }
    warmed=true;
  }finally{bridge.dispose();}
}
