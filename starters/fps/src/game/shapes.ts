import type {GameShapes,InputOf,StateOf} from '../shared/gameApi.ts';
import {firearmRecoilShape} from '../sandbox/firearms.ts';
import {roundStateShape} from '../shared/roundSeries.ts';
import {SHOP_ITEMS} from './catalog.ts';
export const shapes={
world:{elapsedMs:'number',round:roundStateShape,bomb:{state:'uint8',carrier:'int8',x:'number',z:'number',timer:'number',progress:'number',actor:'int8'},winner:'int8',reason:'string',serial:'uint32',effects:[{id:'uint32',kind:'uint8',owner:'uint8',x:'number',z:'number',life:'number',radius:'number'}],kills:[{id:'uint32',owner:'uint8',target:'uint8',head:'boolean',timeMs:'number'}],shots:[{id:'uint32',group:'uint32',owner:'uint8',target:'int8',x:'number',y:'number',z:'number',ex:'number',ey:'number',ez:'number',region:'uint8',weapon:'uint8',damage:'number',timeMs:'number',nx:'number',ny:'number',nz:'number',surface:'boolean'}]},
player:{recoil:firearmRecoilShape,physicsId:'uint8',x:'number',y:'number',z:'number',facing:'number',aimPitch:'number',velocityX:'number',velocityY:'number',velocityZ:'number',grounded:'number',operator:'uint8',credits:'uint16',weapon:'uint8',primary:'uint8',ammo:'uint8',reserve:'uint16',armor:'number',reload:'number',cooldown:'number',skillA:'number',skillB:'number',boost:'number',slow:'number',reveal:'number',cloak:'number',channel:'number',shop:'boolean',selection:'uint8',aim:'boolean',third:'boolean',stash:{pistol:'uint8',pistolAmmo:'uint8',pistolReserve:'uint16',primaryAmmo:'uint8',primaryReserve:'uint16',notice:'string'}},
input:{moveX:{min:-1,max:1},moveZ:{min:-1,max:1},lookX:{min:-1000,max:1000},lookY:{min:-1000,max:1000},jump:'boolean',fire:'boolean',aim:'boolean',reload:'boolean',skillA:'boolean',skillB:'boolean',interact:'boolean',shop:'boolean',previous:'boolean',next:'boolean',buy:'boolean',buySelection:{min:0,max:SHOP_ITEMS},closeUi:'boolean',swap:'boolean',camera:'boolean'}
} as const satisfies GameShapes;
export type WorldState=StateOf<typeof shapes.world>;export type PlayerState=StateOf<typeof shapes.player>;export type BlankInput=InputOf<typeof shapes.input>;
export function createInput(o:Partial<BlankInput>={}):BlankInput{return {moveX:0,moveZ:0,lookX:0,lookY:0,jump:false,fire:false,aim:false,reload:false,skillA:false,skillB:false,interact:false,shop:false,previous:false,next:false,buy:false,buySelection:0,closeUi:false,swap:false,camera:false,...o};}

