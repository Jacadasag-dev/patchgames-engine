/** Authored example, not a fixed engine biome preset. Integer hashes keep
 * generation independent of traversal, chunk order and floating libm behavior. */
export const MATERIALS=['Air','Grass','Dirt','Stone','Timber','Leaves','Coal','Iron','Sand','Water','Planks','Torch'];
export const hash=(x:number,z:number,seed:number)=>{let h=Math.imul(x,374761393)^Math.imul(z,668265263)^Math.imul(seed,144269);h=Math.imul(h^(h>>>13),1274126177);return((h^(h>>>16))>>>0)/4294967296;};
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
export function noise(x:number,z:number,scale:number,seed:number){const ix=Math.floor(x/scale),iz=Math.floor(z/scale),fx=x/scale-ix,fz=z/scale-iz,u=fx*fx*(3-2*fx),v=fz*fz*(3-2*fz);return mix(mix(hash(ix,iz,seed),hash(ix+1,iz,seed),u),mix(hash(ix,iz+1,seed),hash(ix+1,iz+1,seed),u),v);}
export function height(x:number,z:number,seed:number){return Math.floor(1+noise(x,z,43,seed)*7+noise(x,z,14,seed+3)*3);}
const cache=new Map<string,readonly number[]>();
export function sample(x:number,y:number,z:number,seed:number):number{
 const key=seed+':'+x+':'+z;let column=cache.get(key);
 if(!column){
  const out=Array<number>(32).fill(0),h=height(x,z,seed),dry=noise(x,z,64,seed+81)>.64;
  for(let v=-8;v<=h;v++){
   if(v>=-4&&v<=-2&&v<h-3&&Math.abs(noise(x,z,23,seed+411)-.5)<.09)continue;
   const ore=hash(x+v*53,z-v*31,seed+107);
   out[v+8]=v===h?(dry||h<=3?8:1):v>h-3?(dry?8:2):ore>.985?7:ore>.95?6:3;
  }
  if(h<3)for(let v=h+1;v<=3;v++)out[v+8]=9;
  if(!dry&&x*x+z*z>64){const cx=Math.floor(x/8),cz=Math.floor(z/8);
   for(let a=cx-1;a<=cx+1;a++)for(let b=cz-1;b<=cz+1;b++){
    if(hash(a,b,seed+909)>.68)continue;
    const tx=a*8+1+Math.floor(hash(a,b,seed+2)*5),tz=b*8+1+Math.floor(hash(a,b,seed+4)*5),dx=Math.abs(x-tx),dz=Math.abs(z-tz);
    if(dx>2||dz>2)continue;
    const th=height(tx,tz,seed);if(th<4||noise(tx,tz,64,seed+81)>.64||tx*tx+tz*tz<=64)continue;
    const tall=4+Math.floor(hash(a,b,seed+44)*3);
    for(let v=th+1;v<=th+tall+1&&v<24;v++){
     if(dx===0&&dz===0&&v<=th+tall)out[v+8]=4;
     else if(v>=th+tall-2&&dx+dz+(v===th+tall+1?1:0)<5)out[v+8]=5;
    }
   }
  }
  if(cache.size>=8192)cache.delete(cache.keys().next().value!);column=Object.freeze(out);cache.set(key,column);
 }return column[y+8]??0;
}

