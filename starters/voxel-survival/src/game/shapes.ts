import type {GameShapes,StateOf,InputOf} from '../shared/gameApi.ts';
export const shapes={world:{elapsedMs:'number',terrainRevision:'string',edits:[{x:'number',y:'number',z:'number',material:'uint8'}]},
player:{physicsId:'uint8',x:'number',y:'number',z:'number',facing:'number',aimPitch:'number',velocityX:'number',velocityY:'number',velocityZ:'number',grounded:'number',
selected:'uint8',dirt:'uint16',stone:'uint16',wood:'uint16',planks:'uint16',coal:'uint16',iron:'uint16',food:'uint16',pickaxe:'uint8',cooldown:'number',mineTime:'number',target:'string',action:'uint32',actionKind:'uint8',actionX:'number',actionY:'number',actionZ:'number',heal:'boolean',message:'string'},
input:{moveX:{min:-1,max:1},moveZ:{min:-1,max:1},lookX:{min:-1000,max:1000},lookY:{min:-1000,max:1000},jump:'boolean',mine:'boolean',place:'boolean',next:'boolean',craft:'boolean',eat:'boolean',sprint:'boolean'}} as const satisfies GameShapes;
export type World=StateOf<typeof shapes.world>;export type Player=StateOf<typeof shapes.player>;export type Input=InputOf<typeof shapes.input>;
export type Tuning={fighterRadius:number;fighterHeight:number;maxHp:number;moveSpeed:number;gravity:number;maxSlopeDegrees:number;jumpSpeed:number;lookSpeed:number;worldSeed:number};

