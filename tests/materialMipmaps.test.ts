import {expect,it} from 'vitest';
import {generateMaterialMipmaps} from '../src/shared/materialMipmaps.ts';
import {generateMaterial} from '../src/shared/materialGenerator.ts';
import {createGeneratedMaterialFromPixels} from '../src/sandbox/materialGenerator.ts';
import type {TexturePixels} from '../src/shared/materialRecipeRenderer.ts';

it('filters color in linear light and retains thin cutout coverage without black fringes',()=>{
 const data=new Uint8Array([255,0,0,255,0,0,0,0,0,0,0,0,0,0,0,0]),before=data.slice(),levels=generateMaterialMipmaps({width:2,height:2,data},{kind:'color',alphaCutoff:.2});
 expect(levels.map(l=>[l.width,l.height])).toEqual([[2,2],[1,1]]);expect(Array.from(levels[1].data.slice(0,3))).toEqual([255,0,0]);expect(levels[1].data[3]).toBeGreaterThanOrEqual(51);expect(data).toEqual(before);
 const gray=generateMaterialMipmaps({width:2,height:1,data:new Uint8Array([0,0,0,255,255,255,255,255])},{kind:'color'});expect(gray[1].data[0]).toBeGreaterThan(180);
});
it('handles rectangular odd dimensions and renormalizes every normal level',()=>{
 const data=new Uint8Array(7*3*4);for(let k=0;k<data.length;k+=4)data.set(k%8?[128,128,255,255]:[255,128,128,255],k);
 const levels=generateMaterialMipmaps({width:7,height:3,data},{kind:'normal'});expect(levels.map(l=>[l.width,l.height])).toEqual([[7,3],[3,1],[1,1]]);
 for(const level of levels.slice(1))for(let k=0;k<level.data.length;k+=4)expect(Math.hypot(...Array.from(level.data.slice(k,k+3),v=>v/255*2-1))).toBeCloseTo(1,2);
});
it('preserves equal-alpha patterned coverage instead of dropping the entire mip',()=>{
 const data=new Uint8Array(16*16*4);for(let y=0;y<16;y++)for(let x=0;x<16;x++){const k=(y*16+x)*4;data.set([50,180,40,x%2===0&&y%2===0?255:0],k);}
 const levels=generateMaterialMipmaps({width:16,height:16,data},{kind:'color',alphaCutoff:.2});
 for(const level of levels.slice(1)){let count=0;for(let k=3;k<level.data.length;k+=4)if(level.data[k]>=51)count++;expect(count).toBeGreaterThan(0);expect(Math.abs(count-Math.max(1,Math.round(level.width*level.height*.25)))).toBeLessThanOrEqual(1);}
});
it('bounds invalid mip requests before allocation',()=>{
 for(const input of [{width:0,height:2,data:new Uint8Array()},{width:2049,height:1,data:new Uint8Array()},{width:2,height:2,data:new Uint8Array(3)}])expect(()=>generateMaterialMipmaps(input)).toThrow();
 expect(()=>generateMaterialMipmaps({width:1,height:1,data:new Uint8Array(4)},{alphaCutoff:0})).toThrow();
});
it('reuses prepared mip pixels across owned texture handles without sharing disposal',async()=>{
 const bake=await generateMaterial({pattern:{family:'leaf'}},{resolution:32,alphaCutoff:.2}),a=createGeneratedMaterialFromPixels(bake),b=createGeneratedMaterialFromPixels(bake);
 try{expect(a.maps.color.mipmaps).toBe(bake.preparedMipmaps!.color);expect(a.maps.normal.mipmaps).toBe(bake.preparedMipmaps!.normal);expect(a.maps.color.mipmaps).toBe(b.maps.color.mipmaps);expect(a.maps.normal.mipmaps).toBe(b.maps.normal.mipmaps);expect(bake.diagnostics.bytes).toBe(bake.diagnostics.baseBytes!+bake.diagnostics.mipBytes!);expect(a.maps.color.generateMipmaps).toBe(false);expect(a.maps.color.anisotropy).toBe(4);expect(a.material.alphaTest).toBe(.2);let disposed=0;b.maps.color.addEventListener('dispose',()=>disposed++);a.dispose();expect(disposed).toBe(0);}finally{a.dispose();b.dispose();}
});
it('keeps nearest-filter pixel textures compatible with anisotropy constraints',async()=>{
 const bake=await generateMaterial({pattern:{family:'rock'},output:{resolution:32,style:'pixel'}}),handle=createGeneratedMaterialFromPixels(bake,{anisotropy:16});
 try{for(const map of Object.values(handle.maps))expect(map.anisotropy).toBe(1);}finally{handle.dispose();}
});
it('preserves fractional leaf opacity through the final hashed-alpha mip instead of collapsing to the cutoff',async()=>{
 const recipe={pattern:{family:'leaf' as const,lengthMeters:.18,widthMeters:.075,outline:'lobed' as const},tileMeters:[.12,.22] as [number,number]},bake=await generateMaterial(recipe,{resolution:128,alphaCutoff:.2,alphaMode:'hash'}),chain=bake.preparedMipmaps!.color!;
 const mean=(data:Uint8Array)=>{let sum=0;for(let i=3;i<data.length;i+=4)sum+=data[i];return sum/(data.length/4);},expected=mean(bake.color.data);
 expect(expected).toBeGreaterThan(50);expect(expected).toBeLessThan(100);expect(bake.preparedMipmaps!.alphaMode).toBe('hash');
 for(const level of chain)expect(Math.abs(mean(level.data)-expected)).toBeLessThanOrEqual(1.5);
 expect(chain.at(-1)!.data[3]).toBeGreaterThan(51);expect(chain.at(-1)!.data[3]).toBeLessThan(128);
 const handle=createGeneratedMaterialFromPixels(bake);try{expect(handle.maps.color.mipmaps).toBe(chain);expect(handle.material.alphaHash).toBe(true);expect(handle.material.alphaTest).toBe(0);expect(handle.material.alphaToCoverage).toBe(false);expect(handle.material.transparent).toBe(false);}finally{handle.dispose();}
});
it('separates hashed and alpha-test mip caches for the same source pixels',async()=>{
 const bake=await generateMaterial({pattern:{family:'leaf'}},{resolution:32,alphaCutoff:.2}),binary=bake.preparedMipmaps!.color!,a=createGeneratedMaterialFromPixels(bake,{alphaMode:'hash'}),b=createGeneratedMaterialFromPixels(bake,{alphaMode:'hash'}),c=createGeneratedMaterialFromPixels(bake);
 try{expect(a.maps.color.mipmaps).not.toBe(binary);expect(a.maps.color.mipmaps).toBe(b.maps.color.mipmaps);expect(c.maps.color.mipmaps).toBe(binary);expect(c.material.alphaHash).toBe(false);expect(c.material.alphaTest).toBe(.2);expect((a.maps.color.mipmaps.at(-1)! as TexturePixels).data[3]).not.toBe(binary.at(-1)!.data[3]);}finally{a.dispose();b.dispose();c.dispose();}
});
it('keeps hashed coverage opt-in and does not hash opaque or optical materials',async()=>{
 const opaque=await generateMaterial({pattern:{family:'rock'}},{resolution:32,alphaMode:'hash'}),glass=await generateMaterial({pattern:{family:'plaster'},optics:{transmission:1}},{resolution:32,alphaMode:'hash'});
 const a=createGeneratedMaterialFromPixels(opaque,{alphaMode:'hash'}),b=createGeneratedMaterialFromPixels(glass,{alphaMode:'hash'});
 try{expect(a.material.alphaHash).toBe(false);expect(b.material.alphaHash).toBe(false);expect(glass.preparedMipmaps!.alphaMode).toBe('cutout');}finally{a.dispose();b.dispose();}
});
