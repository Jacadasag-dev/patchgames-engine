/** Connected presentation across submerged geometry-derived layer openings.
 * Hydraulic ranks are storage, not visible seams. No state is modified here. */
import type {WaterWorldManifest,WaterWorldState} from './waterWorld.ts';
import {waterBodyCells} from './waterBodyCells.ts';
import {buildWaterBodySurface,WaterBodySurfaceWorkspace,type WaterBodyStyle,type WaterBodySurfaceBuffers} from './waterBodyView.ts';
import type {WaterSurfaceConnections,WaterSurfaceConnectionValue} from './waterBoundaryView.ts';
import type {WaterBoundaryMesh} from './waterBoundaryGeometry.ts';

interface Endpoint {layer:number;region:number;x:number;z:number}
interface Join {link:number;left:number;right:number;nodes:[number,number,number,number]}
export class WaterWorldSurfaceWorkspace {
  world?:WaterWorldManifest;meshes:(WaterBoundaryMesh|undefined)[]=[];
  layers:WaterBodySurfaceWorkspace[]=[];connections:WaterSurfaceConnections[]=[];
  endpoints:Endpoint[]=[];joins:Join[]=[];keys=new Map<string,number>();revision=0;
}
const pointKey=(x:number,z:number)=>`${Math.round(x*1e9)},${Math.round(z*1e9)}`;
const endpointKey=(layer:number,region:number,x:number,z:number)=>`${layer}:${region}:${pointKey(x,z)}`;
const immutableGraphs=new WeakSet<object>();
function immutable(value:unknown):boolean {
  const seen=new Set<object>(),visit=(v:unknown):boolean=>{
    if(!v||typeof v!=='object'||seen.has(v)||immutableGraphs.has(v))return true;
    const prototype=Object.getPrototypeOf(v);if(!Object.isFrozen(v)||(prototype!==Object.prototype&&prototype!==Array.prototype))return false;
    seen.add(v);return Object.values(Object.getOwnPropertyDescriptors(v)).every(d=>'value' in d&&visit(d.value));
  };
  if(!visit(value))return false;for(const node of seen)immutableGraphs.add(node);return true;
}
function contains(p:{x:number;z:number},a:{x:number;z:number},b:{x:number;z:number}):boolean {
  const dx=b.x-a.x,dz=b.z-a.z,length=Math.hypot(dx,dz);
  return length>0&&Math.abs(dx*(p.z-a.z)-dz*(p.x-a.x))<=1e-8*length
    &&(p.x-a.x)*dx+(p.z-a.z)*dz>=-1e-8*length&&(p.x-b.x)*dx+(p.z-b.z)*dz<=1e-8*length;
}

export function buildWaterWorldSurfaces(world:WaterWorldManifest,state:WaterWorldState,options:WaterBodyStyle&{workspace?:WaterWorldSurfaceWorkspace;layerStyles?:readonly WaterBodyStyle[]}={}):WaterBodySurfaceBuffers[]{
  if(state.worldRevision!==world.revision||state.layers.length!==world.layers.length)throw new Error('Water world surface state mismatch');
  const ws=options.workspace??new WaterWorldSurfaceWorkspace(),cells=world.layers.map((l,i)=>waterBodyCells(l.system.water,state.layers[i].water));
  const meshes=state.layers.map(l=>l.water.boundary?.mesh);
  if(ws.world!==world||!immutable(world)||meshes.some((mesh,i)=>mesh!==ws.meshes[i]||!immutable(mesh))){
    ws.world=world;ws.meshes=meshes;ws.layers=world.layers.map(()=>new WaterBodySurfaceWorkspace());
    ws.connections=world.layers.map(()=>({segments:[],values:[],revision:0}));ws.endpoints=[];ws.joins=[];ws.keys.clear();
    const node=(layer:number,region:number,p:{x:number;z:number})=>{const key=endpointKey(layer,region,p.x,p.z),known=ws.keys.get(key);if(known!==undefined)return known;const id=ws.endpoints.length;ws.endpoints.push({layer,region,...p});ws.keys.set(key,id);return id;};
    for(let k=0;k<world.links.length;k++){
      const link=world.links[k];if(!link.opening||meshes[link.a]?.supportLayer===undefined||meshes[link.b]?.supportLayer===undefined)continue;
      const a=cells[link.a].locate(link.pointA),b=cells[link.b].locate(link.pointB);if(a===undefined||b===undefined)continue;
      const {start,end}=link.opening,left=ws.connections[link.a].segments.length,right=ws.connections[link.b].segments.length;
      (ws.connections[link.a].segments as Array<WaterSurfaceConnections['segments'][number]>).push({region:a,start:{...start},end:{...end}});
      (ws.connections[link.b].segments as Array<WaterSurfaceConnections['segments'][number]>).push({region:b,start:{...start},end:{...end}});
      ws.joins.push({link:k,left,right,nodes:[node(link.a,a,start),node(link.a,a,end),node(link.b,b,start),node(link.b,b,end)]});
    }
    for(const connection of ws.connections)connection.segments=Object.freeze(connection.segments.map(s=>Object.freeze({...s,start:Object.freeze(s.start),end:Object.freeze(s.end)})));
  }
  if(!ws.joins.length)return world.layers.map((layer,i)=>buildWaterBodySurface(layer.system.water,state.layers[i].water,{...options,...options.layerStyles?.[i],workspace:ws.layers[i]}));
  const count=ws.endpoints.length,parent=Int32Array.from({length:count},(_,i)=>i),active=new Uint8Array(count),crest=new Float64Array(count).fill(-Infinity),enabled=new Uint8Array(ws.joins.length);
  const root=(i:number):number=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  const join=(a:number,b:number)=>{a=root(a);b=root(b);if(a!==b)parent[Math.max(a,b)]=Math.min(a,b);};
  for(let k=0;k<ws.joins.length;k++){
    const entry=ws.joins[k],link=world.links[entry.link],a=ws.endpoints[entry.nodes[0]],b=ws.endpoints[entry.nodes[2]],ca=cells[a.layer],cb=cells[b.layer],wet=Math.max(world.layers[a.layer].system.water.wetDepth,world.layers[b.layer].system.water.wetDepth);
    if(ca.volume(a.region)<=0||cb.volume(b.region)<=0||Math.min(ca.level(a.region),cb.level(b.region))<=link.sill+wet)continue;
    enabled[k]=1;for(const node of entry.nodes){active[node]=1;crest[node]=Math.max(crest[node],link.sill+wet);}
    join(entry.nodes[0],entry.nodes[2]);join(entry.nodes[1],entry.nodes[3]);
  }
  // Endpoints meeting a local wet face share the same pin as its remote side.
  // A closed wall, dry crest, or vertically overlapping floor never joins.
  const faces=cells.map(c=>c.faces()),incident=cells.map(c=>Array.from({length:c.count},()=>[] as number[]));
  faces.forEach((list,layer)=>list.forEach((f,i)=>{incident[layer][f.a].push(i);if(f.b>=0)incident[layer][f.b].push(i);}));
  for(let i=0;i<count;i++)if(active[i]){
    const p=ws.endpoints[i],c=cells[p.layer],wet=world.layers[p.layer].system.water.wetDepth;
    for(const index of incident[p.layer][p.region]){const f=faces[p.layer][index],other=f.a===p.region?f.b:f.a;if(other<0||!contains(p,f.start,f.end))continue;
      const next=ws.keys.get(endpointKey(p.layer,other,p.x,p.z));if(next===undefined||!active[next])continue;
      if(Math.min(c.level(p.region),c.level(other))>Math.max(f.start.bed,f.end.bed,f.barrier?.top??-Infinity)+wet)join(i,next);
    }
  }
  const weights=new Float64Array(count),heights=new Float64Array(count),us=new Float64Array(count),vs=new Float64Array(count),minima=new Float64Array(count).fill(-Infinity);
  for(let i=0;i<count;i++)if(active[i]){const p=ws.endpoints[i],c=cells[p.layer],r=root(i),weight=c.area(p.region);weights[r]+=weight;heights[r]+=c.level(p.region)*weight;us[r]+=c.flowX[p.region]*weight;vs[r]+=c.flowZ[p.region]*weight;minima[r]=Math.max(minima[r],crest[i]);}
  const values:(WaterSurfaceConnectionValue|undefined)[]=Array(count);
  for(let i=0;i<count;i++)if(active[i]){const r=root(i);values[i]={height:Math.max(minima[r],heights[r]/weights[r]),nx:0,ny:1,nz:0,u:us[r]/weights[r],v:vs[r]/weights[r]};}
  const nextValues=ws.connections.map(connection=>Array(connection.segments.length) as Array<WaterSurfaceConnections['values'][number]>);
  for(let k=0;k<ws.joins.length;k++)if(enabled[k]){const e=ws.joins[k],link=world.links[e.link],value={start:values[e.nodes[0]]!,end:values[e.nodes[1]]!};
    nextValues[link.a][e.left]=value;nextValues[link.b][e.right]=value;
  }
  const same=(a:WaterSurfaceConnectionValue,b:WaterSurfaceConnectionValue)=>a.height===b.height&&a.nx===b.nx&&a.ny===b.ny&&a.nz===b.nz&&a.u===b.u&&a.v===b.v;
  for(let i=0;i<ws.connections.length;i++){const connection=ws.connections[i],next=nextValues[i];
    let changed=next.length!==connection.values.length;for(let j=0;j<next.length&&!changed;j++){const a=next[j],b=connection.values[j];changed=!!a!==!!b||!!a&&!!b&&(!same(a.start,b.start)||!same(a.end,b.end));}
    if(changed){connection.values=Object.freeze(next.map(v=>v?Object.freeze({start:Object.freeze(v.start),end:Object.freeze(v.end)}):undefined));connection.revision=++ws.revision;}
  }
  return world.layers.map((layer,i)=>buildWaterBodySurface(layer.system.water,state.layers[i].water,{...options,...options.layerStyles?.[i],workspace:ws.layers[i],connections:ws.connections[i].segments.length?ws.connections[i]:undefined}));
}
