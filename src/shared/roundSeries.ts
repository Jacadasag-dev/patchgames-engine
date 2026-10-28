/** Engine-owned two-team rounds. Declare roundStateShape in shapes.world at stateField. */
export const roundStateShape = {number:'uint32',phase:'uint8',scoreA:'uint8',scoreB:'uint8',winner:'int8',attackingTeam:'uint8',elapsedMs:'number',remainingMs:'number'} as const;
export interface RoundState { number:number; phase:number; scoreA:number; scoreB:number; winner:number; attackingTeam:number; elapsedMs:number; remainingMs:number }
export interface RoundRules {
  stateField:string;
  winsToMatch:number;
  intermissionMs:number;
  /** Zero keeps roles fixed. Otherwise swap attack/defence after this many rounds. */
  sideSwitchEvery?:number;
  /** Top-level state fields carried into setupMatch before the next round. Health never carries. */
  carryPlayerFields?:readonly string[];
  carryWorldFields?:readonly string[];
}
export function parseRoundRules(raw:unknown):RoundRules|undefined {
  if(raw===undefined)return;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('rounds: expected round rules');
  const r=raw as RoundRules;
  const keys=['stateField','winsToMatch','intermissionMs','sideSwitchEvery','carryPlayerFields','carryWorldFields'];
  if(Object.keys(r).some(k=>!keys.includes(k))||!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(r.stateField)
    ||!Number.isInteger(r.winsToMatch)||r.winsToMatch<1||r.winsToMatch>50
    ||!Number.isFinite(r.intermissionMs)||r.intermissionMs<0||r.intermissionMs>30000
    ||r.sideSwitchEvery!==undefined&&(!Number.isInteger(r.sideSwitchEvery)||r.sideSwitchEvery<0||r.sideSwitchEvery>100))throw Error('rounds: invalid state field, win target or timing');
  for(const list of [r.carryPlayerFields,r.carryWorldFields])if(list!==undefined&&(!Array.isArray(list)||list.length>32||list.some(k=>typeof k!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k))))throw Error('rounds: carry fields must be top-level state names');
  if(r.carryWorldFields?.includes(r.stateField))throw Error('rounds: engine round state cannot be carried as authored state');
  return {...r,carryPlayerFields:r.carryPlayerFields?[...r.carryPlayerFields]:[],carryWorldFields:r.carryWorldFields?[...r.carryWorldFields]:[]};
}
export function initialRound():RoundState{return{number:1,phase:0,scoreA:0,scoreB:0,winner:-1,attackingTeam:0,elapsedMs:0,remainingMs:0};}
/** Mutates only trusted round state; true means the engine must reset the round. */
export function advanceRound(state:RoundState,rules:RoundRules,dtMs:number,health:readonly {hp:number}[],teams:readonly number[],objective?:number,pendingTeam?:number):boolean {
  if(state.phase===2)return false;
  if(state.phase===1){state.remainingMs=Math.max(0,state.remainingMs-dtMs);if(state.remainingMs>0)return false;
    state.number++;state.phase=0;state.elapsedMs=0;state.attackingTeam=rules.sideSwitchEvery?Math.floor((state.number-1)/rules.sideSwitchEvery)%2:0;return true;}
  state.elapsedMs+=dtMs;
  let winner=objective;
  if(winner===undefined){const alive=[0,0];health.forEach((p,i)=>{if(p.hp>0&&teams[i]>=0&&teams[i]<2)alive[teams[i]]++;});
    if(!alive[0]&&!alive[1]){if(pendingTeam===undefined)winner=-1;}
    else if(!alive[0]&&pendingTeam!==0)winner=1;
    else if(!alive[1]&&pendingTeam!==1)winner=0;
  }
  if(winner===undefined)return false;
  state.winner=winner;if(winner===0)state.scoreA++;if(winner===1)state.scoreB++;
  state.phase=Math.max(state.scoreA,state.scoreB)>=rules.winsToMatch?2:1;
  state.remainingMs=state.phase===1?rules.intermissionMs:0;return false;
}
