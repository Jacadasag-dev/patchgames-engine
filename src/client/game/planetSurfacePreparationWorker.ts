import {bakePlanetSurfaceMaterials} from '../../shared/planetSurface.ts';
const scope=globalThis as unknown as {onmessage:((event:MessageEvent<{seed:number;resolution:64|128|256}>)=>void)|null;postMessage(data:unknown,options?:{transfer:Transferable[]}):void};
let used=false;
scope.onmessage=async event=>{
  try{if(used)throw Error('Planet surface worker accepts one preparation request.');used=true;
    const data=await bakePlanetSurfaceMaterials(event.data.seed,event.data.resolution),buffers=new Set<ArrayBuffer>();
    for(const material of data){for(const pixels of [material.color,material.normal,material.roughness,material.metalness,material.height,material.ao,...material.preparedMipmaps?.normal??[],...material.preparedMipmaps?.color??[]])buffers.add(pixels.data.buffer as ArrayBuffer);}
    scope.postMessage({data},{transfer:[...buffers]});
  }catch(error){scope.postMessage({error:(error instanceof Error?error.message:String(error)).slice(0,1000)});}
};
