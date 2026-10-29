import {setLocalTextureResolver} from './media.ts';
import type {MaterialSourcePixels} from '../shared/materialRecipeRenderer.ts';
import {STARTER_TEXTURE_DATA} from './starterTextureData.ts';
const decoded=new Map<string,MaterialSourcePixels>();
function bytes(text:string){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',out=new Uint8Array(text.length/4*3-(text.endsWith('==')?2:text.endsWith('=')?1:0));let cursor=0;for(let i=0;i<text.length;i+=4){const n=alphabet.indexOf(text[i])<<18|alphabet.indexOf(text[i+1])<<12|Math.max(0,alphabet.indexOf(text[i+2]))<<6|Math.max(0,alphabet.indexOf(text[i+3]));for(const shift of [16,8,0])if(cursor<out.length)out[cursor++]=n>>shift&255;}return out;}
/** Standalone starter assets use local pixels, never an account or network request. */
export function installStarterMedia(){return setLocalTextureResolver(id=>{let source=decoded.get(id);if(source)return source;const record=STARTER_TEXTURE_DATA[id];if(!record)return;
 const channels=Object.fromEntries(Object.entries(record.maps).map(([name,data])=>[name,{width:record.width,height:record.height,data:bytes(data)}]));source=channels as unknown as MaterialSourcePixels;decoded.set(id,source);return source;
});}
