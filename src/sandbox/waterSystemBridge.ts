/** Optional trusted engine acceleration. No state or simulation is hidden in
 * this adapter; plain host/workshop callers use the same pure implementation. */
import {decodeWaterStateTransfer,decodeWaterSystemTransfer,decodeWaterWorldTransfer,encodeWaterStateTransfer} from './waterSystemTransfer.ts';
import type {WaterSystemManifest} from './waterSystem.ts';
import type {WaterWorldManifest,WaterWorldRecipe} from './waterWorld.ts';
const manifests=new WeakMap<(json:string)=>string,Map<string,WaterSystemManifest>>();
export function callWaterWorldHost(recipe:WaterWorldRecipe):WaterWorldManifest|undefined {
  const bridge=(globalThis as unknown as {__patchduelWater?:(json:string)=>string}).__patchduelWater;
  if(!bridge)return undefined;
  const answer=JSON.parse(bridge(JSON.stringify({version:'water-system-host-v1',operation:'compile-world',request:{recipe}})));
  if(answer.error)throw new Error(answer.error);
  const world=decodeWaterWorldTransfer(answer),cache=manifests.get(bridge)??new Map<string,WaterSystemManifest>();
  const revisions=new Set([...cache.keys(),...world.layers.map(layer=>layer.system.revision)]);
  if(revisions.size>16)throw new Error('Water manifest cache budget exceeded');
  for(const layer of world.layers)cache.set(layer.system.revision,layer.system);
  manifests.set(bridge,cache);return world;
}
export function callWaterSystemHost<T>(operation:string,request:unknown):T|undefined {
  const bridge=(globalThis as unknown as {__patchduelWater?:(json:string)=>string}).__patchduelWater;
  if(!bridge)return undefined;
  const known=manifests.get(bridge),system=known?.get((request as {revision?:string})?.revision??'');
  // Preserve the compiled geometry identity even for small raw-state calls.
  // Serializing it again both wastes bytes and loses its safe validation cache.
  const transfer=system?encodeWaterStateTransfer(system,request):request;
  const json=JSON.stringify({version:'water-system-host-v1',operation,request:transfer});
  const answer=JSON.parse(bridge(json));
  if(answer.error)throw new Error(answer.error);
  if(operation==='compile'){
    const value=decodeWaterSystemTransfer(answer),cache=known??new Map<string,WaterSystemManifest>();
    // The host already bounds this cache to sixteen compiled systems.
    if(!cache.has(value.revision)&&cache.size>=16)throw new Error('Water manifest cache budget exceeded');
    cache.set(value.revision,value);if(!known)manifests.set(bridge,cache);return value as T;
  }
  return (system?decodeWaterStateTransfer(system,answer.value):answer.value) as T;
}
