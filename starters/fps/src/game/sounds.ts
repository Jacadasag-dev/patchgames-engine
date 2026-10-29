import type {SoundRecipeInput} from '../shared/soundRecipes.ts';
export const SHOT:SoundRecipeInput={kind:'sound',version:1,duration:.6,layers:[{id:'shot',source:{kind:'noise',color:'white',seed:37},gain:.42,lowpass:4200,fadeIn:.001,fadeOut:.12}]};
export const RELOAD:SoundRecipeInput={kind:'sound',version:1,duration:.6,layers:[{id:'magazine',source:{kind:'noise',color:'white',seed:41},gain:.16,lowpass:1800,fadeIn:.01,fadeOut:.55}]};
export const BEEP:SoundRecipeInput={kind:'sound',version:1,duration:.16,layers:[{id:'device',source:{kind:'tone',frequency:960},gain:.15,fadeIn:.01,fadeOut:.04}]};


export const KILL:SoundRecipeInput={kind:'sound',version:1,duration:.65,layers:[{id:'strike',source:{kind:'tone',frequency:660,waveform:'triangle'},gain:.12,duration:.13,fadeOut:.11},{id:'fifth',source:{kind:'tone',frequency:990,waveform:'sine'},offset:.06,gain:.1,duration:.24,fadeOut:.2},{id:'resolve',source:{kind:'tone',frequency:1320},offset:.12,gain:.08,duration:.45,fadeOut:.4}],effects:{reverb:{decay:.4,wet:.15,seed:9}}};
export const HEAD_KILL:SoundRecipeInput={...KILL,layers:[...KILL.layers,{id:'head-chime',source:{kind:'tone',frequency:1980,waveform:'sine'},gain:.08,offset:.03,duration:.3,fadeOut:.27}]};
export function weaponShot(kind:string):SoundRecipeInput{return {...SHOT,layers:[{...SHOT.layers[0],pitchSemitones:kind.includes('sniper')?-7:kind.includes('shotgun')?-5:kind==='smg'?4:kind==='lmg'?-3:kind==='revolver'?-2:0},{id:'weight',source:{kind:'tone',frequency:kind.includes('sniper')?65:kind.includes('shotgun')?80:125,waveform:'triangle'},gain:.12,duration:.12,fadeOut:.1}]};}
export function weaponReload(style:string):SoundRecipeInput{return {...RELOAD,duration:.8,layers:[{...RELOAD.layers[0],pitchSemitones:style==='belt'?-5:style==='revolver'?4:0},{id:'latch',source:{kind:'noise',color:'white',seed:92},offset:.55,gain:.12,duration:.1,fadeOut:.08,lowpass:3500}]};}

