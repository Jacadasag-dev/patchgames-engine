import type {ObjectShape,StateOf} from '../shared/gameApi.ts';
import {waterBodyStateShape,encodeWaterBodyState,decodeWaterBodyState} from './waterBodyWire.ts';
import {createWaterSystemState,stepWaterSystem,seedWaterSystemSwell,validateWaterSystemState,type WaterSystemManifest,type WaterSystemState,type WaterSystemStep,type WaterSystemResult,type WaterSwell} from './waterSystem.ts';
import {callWaterSystemHost} from './waterSystemBridge.ts';

/** Water, pipe inventory and simulation tick share one validated checkpoint.
 * Coupled worlds must also persist destruction and floating controller state. */
// Keep the waterBody fields at this level so world.water stays within the engine's
// four-level schema budget (including the packed arrays).
export const waterSystemStateShape={systemRevision:'string',steps:'float64',...waterBodyStateShape,pipes:['string']} as const satisfies ObjectShape;
export type WaterSystemWireState=StateOf<typeof waterSystemStateShape>;
export function encodeWaterSystemState(system:WaterSystemManifest,state:WaterSystemState):WaterSystemWireState {
  const hosted=callWaterSystemHost<WaterSystemWireState>('encode',{revision:system.revision,state});if(hosted)return hosted;
  validateWaterSystemState(system,state);const text=JSON.stringify(state.pipes);
  if(text.length>32768)throw new Error('Water pipe checkpoint exceeds wire budget');
  return{systemRevision:state.systemRevision,steps:state.steps,...encodeWaterBodyState(system.water,state.water),pipes:Array.from({length:Math.ceil(text.length/128)},(_,i)=>text.slice(i*128,(i+1)*128))};
}
/** Checkpoints from when 3D falls existed may carry an empty falls field;
 * one still holding fall water cannot be restored without losing it. */
function rejectFallRegions(wire:WaterSystemWireState):void {
  const falls=(wire as {falls?:unknown}).falls;if(falls===undefined)return;
  const lists=falls&&typeof falls==='object'?Object.values(falls):[1];
  if(lists.some(list=>!Array.isArray(list)||list.length>0))throw new Error('Water checkpoint holds 3D fall regions, which were removed; it cannot be restored without losing water');
}
export function decodeWaterSystemState(system:WaterSystemManifest,wire:WaterSystemWireState):WaterSystemState {
  const hosted=callWaterSystemHost<WaterSystemState>('decode',{revision:system.revision,state:wire});if(hosted)return hosted;
  if(!wire||!Array.isArray(wire.pipes)||wire.pipes.length>256||wire.pipes.some(v=>typeof v!=='string'||v.length>128))throw new Error('Invalid water pipe checkpoint');
  rejectFallRegions(wire);
  const state:WaterSystemState={systemRevision:wire.systemRevision,steps:wire.steps,water:decodeWaterBodyState(system.water,wire),pipes:JSON.parse(wire.pipes.join(''))};
  validateWaterSystemState(system,state);return state;
}

/** Fast authoritative setup: checkpoints stay packed inside the game guest. */
export function createWaterSystemWireState(system:WaterSystemManifest):WaterSystemWireState {
  return callWaterSystemHost<WaterSystemWireState>('create-wire',{revision:system.revision})??encodeWaterSystemState(system,createWaterSystemState(system));
}
/** Authoring-time finite swell without unpacking cells inside the game guest. */
export function seedWaterSystemWireSwell({system,state,swell}:{system:WaterSystemManifest;state:WaterSystemWireState;swell:WaterSwell}):WaterSystemWireState {
  return callWaterSystemHost<WaterSystemWireState>('swell-wire',{revision:system.revision,state,swell})??encodeWaterSystemState(system,seedWaterSystemSwell({system,state:decodeWaterSystemState(system,state),swell}));
}
export type WaterSystemWireStep=Omit<WaterSystemStep,'state'>&{state:WaterSystemWireState};
export type WaterSystemWireResult=Omit<WaterSystemResult,'state'>&{state:WaterSystemWireState};
/** One engine call decodes, solves and encodes. No guest-side per-cell copying;
 * replay still carries the complete state and never relies on hidden history. */
export function stepWaterSystemWire({system,state,dt,scene,bodies,disabledSources,wind,detail}:WaterSystemWireStep):WaterSystemWireResult {
  const hosted=callWaterSystemHost<WaterSystemWireResult>('step-wire',{revision:system.revision,state,dt,scene,bodies,disabledSources,wind,...(detail!==undefined?{detail}:{})});if(hosted)return hosted;
  const result=stepWaterSystem({system,state:decodeWaterSystemState(system,state),dt,scene,bodies,disabledSources,wind,detail});
  return{...result,state:encodeWaterSystemState(system,result.state)};
}
