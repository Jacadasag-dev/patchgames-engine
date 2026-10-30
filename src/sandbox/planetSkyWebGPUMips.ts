export interface PlanetSkyNoiseMip {data:Uint8Array;width:number;height:number;depth:number}

/** Three's native automatic mip builder has no 3D kernel. These bounded box
 * levels retain the prepared field, rather than sampling aliased orbital noise.
 * Their upload uses the renderer's public 3D texture-copy API. */
export function createPlanetSkyNoiseMipmaps(input:Uint8Array):PlanetSkyNoiseMip[]{
  if(!(input instanceof Uint8Array)||input.length!==32**3*4)throw Error('Planet sky noise requires exactly 32 cubed RGBA bytes.');
  const levels:PlanetSkyNoiseMip[]=[{data:new Uint8Array(input),width:32,height:32,depth:32}];
  for(let size=16;size>=1;size/=2){
    const previous=levels[levels.length-1],data=new Uint8Array(size**3*4),sourceSize=size*2;
    for(let z=0;z<size;z++)for(let y=0;y<size;y++)for(let x=0;x<size;x++)for(let channel=0;channel<4;channel++){
      let sum=0;
      for(let dz=0;dz<2;dz++)for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++)sum+=previous.data[(((z*2+dz)*sourceSize+y*2+dy)*sourceSize+x*2+dx)*4+channel];
      data[((z*size+y)*size+x)*4+channel]=Math.round(sum/8);
    }
    levels.push({data,width:size,height:size,depth:size});
  }
  return levels;
}
