import type {TexturePixels} from './materialRecipeRenderer.ts';

export interface MaterialMipOptions {kind?:'color'|'normal'|'data';alphaCutoff?:number}
const clamp=(v:number)=>Math.max(0,Math.min(1,v));
const linear=(v:number)=>v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4);
const srgb=(v:number)=>v<=.0031308?v*12.92:1.055*Math.pow(v,1/2.4)-.055;
/** Prepare explicit mip levels once, alongside generated pixels. Color filtering
 * is linear-light and alpha weighted; cutout coverage survives minification.
 * Normals are re-normalized after filtering instead of shrinking toward zero. */
export function generateMaterialMipmaps(source:TexturePixels,options:MaterialMipOptions={}):TexturePixels[]{
  const {width,height,data}=source,kind=options.kind??'data',cutoff=options.alphaCutoff;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>2048||height>2048
    ||!(data instanceof Uint8Array)||data.length!==width*height*4)throw Error('Material mipmaps require bounded RGBA8 pixels, up to 2048×2048.');
  if(!['color','normal','data'].includes(kind)||cutoff!==undefined&&(!Number.isFinite(cutoff)||cutoff<=0||cutoff>=1))throw Error('Invalid material mipmap kind or alpha cutoff.');
  const levels:TexturePixels[]=[source];
  let covered=0;if(cutoff!==undefined)for(let i=3;i<data.length;i+=4)if(data[i]/255>=cutoff)covered++;
  const coverage=covered/(width*height);
  while(levels.at(-1)!.width>1||levels.at(-1)!.height>1){
    const previous=levels.at(-1)!,w=Math.max(1,Math.floor(previous.width/2)),h=Math.max(1,Math.floor(previous.height/2)),next=new Uint8Array(w*h*4);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      // Area filtering includes the final row/column of odd-sized images.
      const x0=Math.floor(x*previous.width/w),x1=Math.floor((x+1)*previous.width/w),y0=Math.floor(y*previous.height/h),y1=Math.floor((y+1)*previous.height/h);
      const total=(x1-x0)*(y1-y0),sum=[0,0,0];let alpha=0,weight=0;
      for(let sy=y0;sy<y1;sy++)for(let sx=x0;sx<x1;sx++){const k=(sy*previous.width+sx)*4,a=previous.data[k+3]/255;alpha+=a;
        for(let c=0;c<3;c++){const v=previous.data[k+c]/255;sum[c]+=(kind==='normal'?v*2-1:kind==='color'?linear(v):v)*(kind==='color'?a:1);}weight+=kind==='color'?a:1;
      }
      const k=(y*w+x)*4;
      if(kind==='normal'){const length=Math.hypot(...sum);for(let c=0;c<3;c++)next[k+c]=Math.round(((length?sum[c]/length:c===2?1:0)*.5+.5)*255);}
      else for(let c=0;c<3;c++)next[k+c]=Math.round(clamp(kind==='color'?srgb(weight?sum[c]/weight:0):sum[c]/total)*255);
      next[k+3]=Math.round(alpha/total*255);
    }
    if(cutoff!==undefined&&coverage>0){
      const threshold=Math.ceil(cutoff*255),desired=Math.max(1,Math.round(coverage*w*h));
      // Break equal-alpha ties with tiny, fixed spatial variation. A uniform
      // averaged checker mask must not jump from full coverage to no coverage.
      const weights=new Float32Array(w*h);for(let p=0;p<weights.length;p++){let hash=Math.imul(p+1,0x7feb352d);hash=Math.imul(hash^(hash>>>16),0x846ca68b);weights[p]=next[p*4+3]*(.99+(hash>>>0)/4294967295*.02);}
      // A bounded scale search keeps the material's alpha-test threshold fixed.
      let lo=0,hi=256,best=1,error=Infinity;
      for(let pass=0;pass<18;pass++){const scale=(lo+hi)/2;let count=0;for(const value of weights)if(Math.min(255,Math.round(value*scale))>=threshold)count++;
        const difference=count===0?Infinity:Math.abs(count-desired);if(difference<error||difference===error&&Math.abs(scale-1)<Math.abs(best-1)){error=difference;best=scale;}
        if(count<desired)lo=scale;else hi=scale;
      }
      for(let p=0;p<weights.length;p++)next[p*4+3]=Math.min(255,Math.round(weights[p]*best));
    }
    levels.push({width:w,height:h,data:next});
  }
  return levels;
}
