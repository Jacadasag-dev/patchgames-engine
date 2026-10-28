/** Geometry-conforming control volumes for the ordinary water grid stage.
 * Sources, solids, hulls, currents and pipes still use the same water step.
 * Tiny cut volumes are agglomerated only through a wetted opening; the exact
 * polygons remain authoritative for storage, collisions and presentation. */
import type {WaterBodyManifest,WaterBodyState} from './waterBody.ts';
import type {WaterBodyGeometry,GridWork} from './waterBodyGrid.ts';
import type {LiquidContact} from './waterDomain.ts';
import {waterBodyCells,type WaterBodyCells,type WaterCellFace} from './waterBodyCells.ts';
import {waterBodyDispersiveHead} from './waterBodyDispersion.ts';
import {waterBodyCapillaryHead,waterBodyCapillaryRate} from './waterBodyCapillary.ts';
import {mixWaterBodyCurrents} from './waterBodyCurrents.ts';
import {WATER_BODY_PUDDLE_DEPTH} from './waterBodyPuddles.ts';
import {waterBodyTerrainPartitions} from './waterBodyTerrainPartitions.ts';
import {createWaterRegionStorage} from './waterBodyRegionStorage.ts';
import {waterBodyGridFlight,waterBodyFlightCoalescing} from './waterBodyGrid.ts';
import {createWaterBodyFlightQueue} from './waterBodyFlights.ts';
import {waterBodyFlightReservation} from './waterBodyWire.ts';

interface Groups {members:number[][];owner:Int32Array;area:Float64Array;volume:Float64Array;head:Float64Array;x:Float64Array;z:Float64Array;cx:Float64Array;cz:Float64Array}
const linksCache=new WeakMap<object,number[][]>();
interface GroupStorage {low:number;high:number;area:number;full:number;solidDepth:number[];evaluate?:ReturnType<typeof createWaterRegionStorage>['evaluate'];volume?:number;previous?:number;head?:number;fixed?:boolean}
const groupStorageCache=new WeakMap<WaterBodyCells,WeakMap<number[],GroupStorage>>();
/** Storage inversion includes displaced solids, and never assigns liquid to
 * a dry part of a group. All operations below conserve liquid, not occupancy. */
export function waterBodyRegionGroupHead(c:WaterBodyCells,members:number[],volume:number,previous?:number):number {
  if(members.length===1)return c.levelAtVolume(members[0],volume);
  const directStorage=(head:number)=>{let sum=0;for(const i of members)sum+=c.capacityAtHead(i,head);return sum;};
  // The shared solver keeps membership and occupancy fixed for each macro
  // interval. Exported calls can reuse a member list after displacement, so
  // also key by the actual cells accessor and verify its occupancy snapshot.
  let shapes=groupStorageCache.get(c);if(!shapes){shapes=new WeakMap();groupStorageCache.set(c,shapes);}
  let shape=shapes.get(members);
  if(!shape||shape.solidDepth.some((v,k)=>v!==c.solidDepth[members[k]])){
    if(members.length>=4)shape={...createWaterRegionStorage(c,members),solidDepth:members.map(i=>c.solidDepth[i])};
    else{let low=Infinity,high=-Infinity,area=0;for(const i of members){low=Math.min(low,c.levelAtVolume(i,0));for(const p of c.polygon(i))high=Math.max(high,p.bed+c.solidDepth[i]);area+=c.area(i);}
      shape={low,high,area,full:directStorage(high),solidDepth:members.map(i=>c.solidDepth[i])};}
    shapes.set(members,shape);
  }
  const storage=(head:number)=>shape!.evaluate?shape!.evaluate(head).volume:directStorage(head);
  // Reuse only an identical call or a verified fixed point of this inversion.
  // A bracket-termination result may refine further on another warm call and
  // therefore is deliberately not treated as a fixed point.
  if(shape.volume===volume&&(shape.previous===previous||shape.fixed&&shape.head===previous))return shape.head!;
  const finish=(head:number,fixed:boolean)=>{shape!.volume=volume;shape!.previous=previous;shape!.head=head;shape!.fixed=fixed;return head;};
  let {low,high}=shape;if(volume<=0)return finish(low,true);
  if(volume>=shape.full)return finish(high+(volume-shape.full)/shape.area,true);
  // Putting all water into any one member supplies an exact upper bound for
  // the union, including arbitrarily small partially wet volumes. Reusing the
  // previous head makes ordinary RK updates converge in a few Newton steps.
  if(previous===undefined||!(previous>low&&previous<high))for(const i of members)high=Math.min(high,c.levelAtVolume(i,volume));
  let head=previous!==undefined&&previous>low&&previous<high?previous:high;
  for(let k=0;k<48;k++){
    const sample=shape.evaluate?.(head),value=sample?sample.volume:directStorage(head),error=value-volume;if(Math.abs(error)<=Math.max(volume*2e-14,Number.MIN_VALUE*2))return finish(head,true);
    // A stale head on either side of the target can make Newton traverse
    // hundreds of orders of magnitude. Tighten the exact inverse bound before
    // iterating; normal small RK updates retain their inexpensive warm start.
    if(k===0&&(value>volume*16||value<volume/16)){for(const i of members)high=Math.min(high,c.levelAtVolume(i,volume));head=high;continue;}
    if(error<0)low=head;else high=head;
    let derivative=sample?.area??0;if(!sample)for(const i of members)derivative+=c.wetAreaAtHead(i,head);
    let next=derivative>0?head-error/derivative:NaN;if(!(next>low&&next<high))next=low+(high-low)*.5;
    if(next===head||next===low||next===high)return finish(Math.abs(storage(low)-volume)<=Math.abs(storage(high)-volume)?low:high,false);head=next;
  }
  return finish(head,false);
}
function makeGroups(w:WaterBodyManifest,c:WaterBodyCells,faces:WaterCellFace[]):Groups {
  const n=c.count,parent=Int32Array.from({length:n},(_,i)=>i),baseCell=Int32Array.from({length:n},(_,i)=>c.parent(i)),members=Array.from({length:n},(_,i)=>[i]),area=Float64Array.from({length:n},(_,i)=>c.area(i)),volume=Float64Array.from({length:n},(_,i)=>c.volume(i));
  let adjacent=linksCache.get(faces);if(!adjacent){adjacent=Array.from({length:n},()=>[] as number[]);
    for(let k=0;k<faces.length;k++){const f=faces[k];adjacent[f.a].push(k);if(f.b>=0)adjacent[f.b].push(k);}linksCache.set(faces,adjacent);}
  const root=(i:number):number=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  const terrainCell=new Uint8Array(w.columns*w.rows).fill(1);
  for(let i=0;i<n;i++)if(c.solidDepth[i]>0)terrainCell[c.parent(i)]=0;
  for(const f of faces)if(f.barrier){terrainCell[c.parent(f.a)]=0;if(f.b>=0)terrainCell[c.parent(f.b)]=0;}
  // Continuous terrain inside an original cell uses that cell's hydraulic
  // resolution. Dry uphill triangles are storage quadrature for their basin,
  // not tiny independent timesteps. Distinct bowls remain separate until the
  // ordinary wetted-sill rule below permits exchange. Placement and step cells
  // retain their existing finer resolution, including a gap around a wall tip.
  const partitions=waterBodyTerrainPartitions(c,faces);
  for(let k=0;k<partitions.groups.length;k++)if(terrainCell[partitions.cell[k]]){
    const group=partitions.groups[k],a=group[0];
    for(let j=1;j<group.length;j++){const b=group[j];parent[b]=a;members[a].push(b);members[b]=[];area[a]+=area[b];volume[a]+=volume[b];}
  }
  const tinyTarget=w.cellArea*.25;
  // Connected wet fragments inside one original cell can use that cell's
  // ordinary control-volume resolution. Only genuinely tiny groups may borrow
  // storage across a base-cell edge. Exact polygons and dry separating crests
  // remain authoritative. Cells touched by a wall or displaced solid retain
  // the smaller rule, including a narrow opening around a wall's tip.
  const visited=new Int32Array(n).fill(-1);let mergeGeneration=0;
  for(let i=0;i<n;i++){
    let a=root(i);
    if(volume[a]<=0)continue;
    // Static basins have many quadrature pieces. A failed candidate scan is
    // unchanged until some merge changes membership, capacity or adjacency.
    // A global generation also invalidates neighbouring roots conservatively.
    if(visited[a]===mergeGeneration)continue;
    for(let pass=0;area[a]<(baseCell[a]>=0&&terrainCell[baseCell[a]]?w.cellArea:tinyTarget)&&pass<64;pass++){
      let choice=-1,best=-Infinity;
      for(const member of members[a])for(const edge of adjacent[member]){
        const f=faces[edge],other=f.a===member?f.b:f.a;if(other<0)continue;const b=root(other);
        // Tiny cuts may borrow adjacent capacity, including a bulk rectangle.
        // Its center-bed storage law remains intact in the summed capacity;
        // never substitute its exact display terrain for hydraulic storage.
        if(a===b||members[a].length+members[b].length>64||area[a]+area[b]>w.cellArea*2)continue;
        const same=baseCell[a]>=0&&baseCell[a]===baseCell[b];
        if(!same&&area[a]>=tinyTarget)continue;
        const crest=Math.min(f.start.bed,f.end.bed)+Math.max(c.solidDepth[f.a],c.solidDepth[f.b]);
        // Compare combined capacity at the sill, avoiding a costly inversion.
        let capacityA=0,capacityB=0;for(const j of members[a])capacityA+=c.capacityAtHead(j,crest+w.dryDepth);for(const j of members[b])capacityB+=c.capacityAtHead(j,crest+w.dryDepth);
        if(volume[a]+volume[b]<=capacityA+capacityB)continue;
        // Broader grouping is only a resolution reduction in an already wet
        // connected interior, never an instantaneous advance into a dry rim.
        if(area[a]>=tinyTarget&&(volume[a]<=capacityA||volume[b]<=capacityB))continue;
        const score=f.length*(c.parent(member)===c.parent(other)?2:1);
        if(score>best){best=score;choice=b;}
      }
      if(choice<0)break;
      parent[a]=choice;if(baseCell[choice]!==baseCell[a])baseCell[choice]=-1;members[choice].push(...members[a]);members[a]=[];area[choice]+=area[a];volume[choice]+=volume[a];a=choice;mergeGeneration++;
    }
    visited[a]=mergeGeneration;
  }
  const list=members.filter(m=>m.length),owner=new Int32Array(n),array=()=>new Float64Array(list.length),q:Groups={members:list,owner,area:array(),volume:array(),head:array(),x:array(),z:array(),cx:array(),cz:array()};
  for(let j=0;j<list.length;j++){
    for(const i of list[j]){owner[i]=j;const a=c.area(i),v=c.volume(i),p=c.center(i);q.area[j]+=a;q.volume[j]+=v;q.x[j]+=v*c.flowX[i];q.z[j]+=v*c.flowZ[i];q.cx[j]+=a*p.x;q.cz[j]+=a*p.z;}
    q.cx[j]/=q.area[j];q.cz[j]/=q.area[j];if(q.volume[j]){q.x[j]/=q.volume[j];q.z[j]/=q.volume[j];}q.head[j]=waterBodyRegionGroupHead(c,list[j],q.volume[j]);
  }
  return q;
}
/** Exact face integrals, including openings whose midpoint is still dry. */
function aperture(head:number,b0:number,b1:number){
  const low=Math.min(b0,b1),high=Math.max(b0,b1),h=Math.max(0,head-low),d=high-low;
  if(!h)return{depth:0,square:0,max:0};
  if(d<1e-12)return{depth:h,square:h*h,max:h};
  if(head>=high){const end=head-high;return{depth:(h+end)*.5,square:(h*h+h*end+end*end)/3,max:h};}
  return{depth:h*h/(2*d),square:h*h*h/(3*d),max:h};
}
/** Integrate hydrostatic pressure over the genuinely wet part of a sloping
 * face. Splitting at the bed/wall intersections leaves quadratic force and
 * cubic moments, so Simpson integration is exact on each interval. */
function wallPressure(head:number,b0:number,b1:number,bottom:number,top:number){
  const high=Math.min(head,top),cuts=[0,1],slope=b1-b0;
  if(slope)for(const height of [bottom,high]){const t=(height-b0)/slope;if(t>0&&t<1)cuts.push(t);}cuts.sort((a,b)=>a-b);
  let force=0,along=0,vertical=0;
  const sample=(t:number)=>{const low=Math.max(bottom,b0+slope*t),h=Math.max(0,high-low),p=h*(head-low-h*.5);return{p,t:p*t,y:low*p+h*h*((head-low)*.5-h/3)};};
  for(let i=1;i<cuts.length;i++){const lo=cuts[i-1],hi=cuts[i],a=sample(lo),m=sample((lo+hi)*.5),b=sample(hi),scale=(hi-lo)/6;force+=(a.p+4*m.p+b.p)*scale;along+=(a.t+4*m.t+b.t)*scale;vertical+=(a.y+4*m.y+b.y)*scale;}
  return{force,t:force?along/force:.5,y:force?vertical/force:high};
}
function writeGroups(c:WaterBodyCells,q:Groups):void {
  for(let j=0;j<q.members.length;j++){
    if(q.members[j].length===1){const i=q.members[j][0];c.setVolume(i,q.volume[j]);c.flowX[i]=q.x[j];c.flowZ[i]=q.z[j];q.head[j]=c.level(i);continue;}
    const head=waterBodyRegionGroupHead(c,q.members[j],q.volume[j],q.head[j]);q.head[j]=head;let sum=0;
    for(const i of q.members[j]){const v=c.capacityAtHead(i,head);c.setVolume(i,v);sum+=v;c.flowX[i]=q.x[j];c.flowZ[i]=q.z[j];}
    if(sum)for(const i of q.members[j])c.setVolume(i,c.volume(i)*(q.volume[j]/sum));
    else if(q.volume[j]>0){const i=q.members[j].reduce((a,b)=>c.bed(a)<=c.bed(b)?a:b);c.setVolume(i,q.volume[j]);}
  }
  c.commit();
}
export function stepWaterBodyRegions(w:WaterBodyManifest,s:WaterBodyState,geometry:WaterBodyGeometry,dt:number,contacts:Map<string,LiquidContact>):GridWork & {localSubsteps:number} {
  const c=waterBodyCells(w,s),faces=c.faces(geometry),g=-w.liquid.gravity.y,rho=w.liquid.restDensity,oldHead=Float64Array.from({length:c.count},(_,i)=>c.level(i));
  let remaining=dt,substeps=0,localSubsteps=0,faceWork=0,faceEvaluations=0,outflow=0,dispersionSolves=0;
  let flightQueue:ReturnType<typeof createWaterBodyFlightQueue>|undefined;
  // The old global RK solver could visit every face twice per allowed step.
  // Local stages consume that same finite work allowance, never a larger one.
  const faceBudget=w.maxGridSubsteps*2*faces.length;
  while(remaining>1e-10){
    const q=makeGroups(w,c,faces),n=q.members.length,rates=new Float64Array(n),all=Array.from({length:n},(_,i)=>i);
    const bulk=Uint8Array.from(q.members,m=>m.length===1&&c.region(m[0])?.bulk?1:0),bulkAt=new Int32Array(w.columns*w.rows).fill(-1);
    for(let i=0;i<n;i++)if(bulk[i])bulkAt[c.parent(q.members[i][0])]=i;
    const active=(list:WaterCellFace[])=>list.filter(f=>q.owner[f.a]!==q.owner[f.b]&&(q.volume[q.owner[f.a]]>0||f.b>=0&&q.volume[q.owner[f.b]]>0));
    const small=Uint8Array.from(q.area,area=>area<w.cellArea*.25?1:0),patchOwner=Int32Array.from(q.members,members=>Math.min(...members.map(i=>c.parent(i)))),links=Array.from({length:n},()=>[] as WaterCellFace[]);
    for(const f of faces){const a=q.owner[f.a],b=f.b<0?-1:q.owner[f.b];if(a===b)continue;links[a].push(f);if(b>=0)links[b].push(f);
    }
    const parts=new Map<number,WaterCellFace[]>(),localSet=new Set<WaterCellFace>();
    // Patch ownership partitions face operators, never physical storage. All
    // geometric small cells participate, including dry cells that a first RK
    // stage may wet. A coarse-cell patch bounds locality without joining the
    // hydraulic heads of disconnected pieces or chaining through dry terrain.
    const owned=new Map<number,number[]>();for(let i=0;i<n;i++)if(small[i]){const key=patchOwner[i],list=owned.get(key)??[];list.push(i);owned.set(key,list);parts.set(key,[]);}
    for(const f of faces){const a=q.owner[f.a],b=f.b<0?-1:q.owner[f.b];if(a===b)continue;const key=Math.min(small[a]?patchOwner[a]:Infinity,b>=0&&small[b]?patchOwner[b]:Infinity);if(!Number.isFinite(key))continue;parts.get(key)!.push(f);localSet.add(f);}
    type Patch={faces:WaterCellFace[];ids:number[];stencil:WaterCellFace[];owned:Set<number>};
    const patches:Patch[]=[...parts].map(([key,list])=>{const ids=[...new Set([...owned.get(key)!,...list.flatMap(f=>f.b<0?[q.owner[f.a]]:[q.owner[f.a],q.owner[f.b]])])];return{faces:list,ids,owned:new Set(owned.get(key)),stencil:[...new Set(ids.flatMap(i=>links[i]))]};}),normalFaces=faces.filter(f=>!localSet.has(f));
    const hydroRate=(list:WaterCellFace[],indices:number[],includeIncomingDry=false)=>{
    for(const i of indices)rates[i]=0;
    for(const f of active(list)){const a=q.owner[f.a],b=f.b<0?-1:q.owner[f.b];if(a===b||b<0&&w.liquid.boundary==='closed')continue;
      const shift=Math.max(c.solidDepth[f.a],f.b<0?0:c.solidDepth[f.b]),ha=aperture(q.head[a],f.start.bed+shift,f.end.bed+shift),hb=b<0?{max:0}:aperture(q.head[b],f.start.bed+shift,f.end.bed+shift);
      if(!ha.max&&!hb.max)continue;
      const speed=Math.max(Math.abs(q.x[a]*f.nx+q.z[a]*f.nz)+Math.sqrt(g*ha.max),b<0?0:Math.abs(q.x[b]*f.nx+q.z[b]*f.nz)+Math.sqrt(g*hb.max));
      rates[a]+=speed*f.length*.5;if(b>=0)rates[b]+=speed*f.length*.5;
    }
    let rate=0;for(const i of indices)if(q.volume[i]>w.dryDepth*q.area[i]||includeIncomingDry&&rates[i]>0){
      // Match the original summed .45 CFL for ordinary cells, including
      // reflecting sides. Cut controls retain their geometric .4 bound.
      const wave=Math.sqrt(g*q.volume[i]/q.area[i]);
      rate=Math.max(rate,bulk[i]?(.4/.45)*((Math.abs(q.x[i])+wave)/w.cellSizeX+(Math.abs(q.z[i])+wave)/w.cellSizeZ):rates[i]/q.area[i]);
    }return rate;
    };
    let rate=hydroRate(normalFaces,all);
    const capillaryRate=waterBodyCapillaryRate(w,s,q);rate+=capillaryRate;
    const step=Math.min(remaining,rate>0?.4/rate:remaining);
    if(++substeps>w.maxGridSubsteps)throw new Error(`Water body partial-cell CFL budget exceeded; rate=${rate}, capillary=${capillaryRate}, remaining=${remaining}`);
    const initialV=new Float64Array(n),initialX=new Float64Array(n),initialZ=new Float64Array(n),dv=new Float64Array(n),mx=new Float64Array(n),mz=new Float64Array(n),out=new Float64Array(n);
    const axx=new Float64Array(n),axz=new Float64Array(n),azz=new Float64Array(n),rhs=Array.from({length:3},()=>[new Float64Array(n),new Float64Array(n)]),grad=Array.from({length:3},()=>[new Float64Array(n),new Float64Array(n)]),smooth=new Uint8Array(n),limiter=Array.from({length:3},()=>new Float64Array(n));
    const advance=(duration:number,slow:boolean,patch:Patch|undefined,time:number)=>{
    const ids=slow?all:patch!.ids,selected=slow?faces:patch!.faces;
    for(const i of ids){initialV[i]=q.volume[i];initialX[i]=q.volume[i]*q.x[i];initialZ[i]=q.volume[i]*q.z[i];}
    for(let stage=0;stage<2;stage++){
      const activeFaces=active(selected),slopeFaces=slow?activeFaces:active(patch!.stencil);
      faceEvaluations+=activeFaces.length;if(faceEvaluations>faceBudget)throw new Error('Water body partial-cell face-work budget exceeded');
      // Strang splitting keeps all capillary, dispersive and friction forces
      // in the slow operator. They run for the full physical interval, using
      // both current RK states; fast stages only exchange shared hydro fluxes.
      if(slow)writeGroups(c,q);
      const dispersion=slow?waterBodyDispersiveHead(w,s,geometry,dispersionSolves++>0,q):undefined,capillary=slow?waterBodyCapillaryHead(w,s,geometry,q):undefined,offset=new Float64Array(slow?n:0);
      if(dispersion?.groupCorrection)offset.set(dispersion.groupCorrection);else if(dispersion)for(let j=0;j<n;j++)for(const i of q.members[j])offset[j]+=(dispersion.head[i]-c.level(i))*c.area(i)/q.area[j];
      for(const i of ids){dv[i]=mx[i]=mz[i]=out[i]=axx[i]=axz[i]=azz[i]=0;smooth[i]=1;for(let k=0;k<3;k++){rhs[k][0][i]=rhs[k][1][i]=grad[k][0][i]=grad[k][1][i]=0;limiter[k][i]=1;}}
      // Least-squares gradients with a local extrema limiter. Steep impact and
      // wet-front faces retain the original first-order hydrostatic flux.
      // Classify the complete stencil before accumulating least-squares work.
      // A rejected face disables both endpoint slopes exactly as before.
      for(const f of slopeFaces){const a=q.owner[f.a],b=f.b<0?-1:q.owner[f.b];if(b<0||a===b)continue;
        const crest=Math.max(f.start.bed,f.end.bed)+Math.max(c.solidDepth[f.a],c.solidDepth[f.b]),depth=Math.min(q.volume[a]/q.area[a],q.volume[b]/q.area[b]);
        if(depth<=w.wetDepth||Math.min(q.head[a],q.head[b])<=crest||Math.abs(q.head[a]-q.head[b])>depth*.25)smooth[a]=smooth[b]=0;
      }
      if(ids.some(i=>smooth[i]))for(const f of slopeFaces){const a=q.owner[f.a],b=f.b<0?-1:q.owner[f.b];if(b<0||a===b||!smooth[a]&&!smooth[b])continue;
        const dx=q.cx[b]-q.cx[a],dz=q.cz[b]-q.cz[a],weight=f.length/Math.max(1e-12,dx*dx+dz*dz);
        if(smooth[a]){axx[a]+=dx*dx*weight;axz[a]+=dx*dz*weight;azz[a]+=dz*dz*weight;}if(smooth[b]){axx[b]+=dx*dx*weight;axz[b]+=dx*dz*weight;azz[b]+=dz*dz*weight;}
        for(let k=0;k<3;k++){const values=k===0?q.head:k===1?q.x:q.z,d=(values[b]-values[a])*weight;if(smooth[a]){rhs[k][0][a]+=d*dx;rhs[k][1][a]+=d*dz;}if(smooth[b]){rhs[k][0][b]+=d*dx;rhs[k][1][b]+=d*dz;}}
      }
      let hasGradient=false;
      for(const i of ids){const det=axx[i]*azz[i]-axz[i]*axz[i];if(!smooth[i]||det<1e-18)continue;for(let k=0;k<3;k++){grad[k][0][i]=(rhs[k][0][i]*azz[i]-rhs[k][1][i]*axz[i])/det;grad[k][1][i]=(rhs[k][1][i]*axx[i]-rhs[k][0][i]*axz[i])/det;if(grad[k][0][i]!==0||grad[k][1][i]!==0)hasGradient=true;}}
      if(hasGradient)for(const f of slopeFaces){const a=q.owner[f.a],b=f.b<0?-1:q.owner[f.b];if(b<0||a===b)continue;const x=(f.start.x+f.end.x)*.5,z=(f.start.z+f.end.z)*.5;
        for(let k=0;k<3;k++){const values=k===0?q.head:k===1?q.x:q.z;for(let side=0;side<2;side++){const i=side?b:a,j=side?a:b,change=grad[k][0][i]*(x-q.cx[i])+grad[k][1][i]*(z-q.cz[i]),delta=values[j]-values[i];if(Math.abs(change)>1e-14)limiter[k][i]=Math.min(limiter[k][i],Math.max(0,delta/change));}}
      }
      // Ordinary neighborhoods use the same independent cardinal limiter as
      // the rectangular solver. Least-squares reconstruction over a diagonal
      // terrain triangulation must not change their transport or wave phase.
      const limited=(a:number,b:number)=>a*b<=0?0:Math.sign(a)*Math.min(Math.abs(a)*2,Math.abs(b)*2,Math.abs(a+b)*.5);
      const pressureGradient=[new Float64Array(n),new Float64Array(n)];
      for(const i of ids)if(bulk[i]){
        const cell=c.parent(q.members[i][0]),x=Math.floor(cell/w.rows),z=cell%w.rows;
        for(let axis=0;axis<2;axis++){
          for(let k=0;k<3;k++){grad[k][axis][i]=0;limiter[k][i]=1;}
          const before=axis===0?(x?cell-w.rows:-1):(z?cell-1:-1),after=axis===0?(x+1<w.columns?cell+w.rows:-1):(z+1<w.rows?cell+1:-1);
          const a=before<0?-1:bulkAt[before],b=after<0?-1:bulkAt[after];if(a<0||b<0)continue;
          const depth=Math.min(q.volume[a]/q.area[a],q.volume[i]/q.area[i],q.volume[b]/q.area[b]);if(depth<=w.wetDepth)continue;
          const relevant=links[i].filter(f=>(axis===0?Math.abs(f.nx):Math.abs(f.nz))>1-1e-9);
          if(relevant.some(f=>f.barrier&&f.barrier.top>=Math.min(q.head[q.owner[f.a]],f.b<0?Infinity:q.head[q.owner[f.b]])-1e-8))continue;
          const dl=q.head[i]-q.head[a],dr=q.head[b]-q.head[i];if(Math.max(Math.abs(dl),Math.abs(dr))>depth*.25)continue;
          const spacing=axis===0?w.cellSizeX:w.cellSizeZ;
          grad[0][axis][i]=limited(dl,dr)/spacing;
          grad[1][axis][i]=limited(q.x[i]-q.x[a],q.x[b]-q.x[i])/spacing;
          grad[2][axis][i]=limited(q.z[i]-q.z[a],q.z[b]-q.z[i])/spacing;
          if(dispersion?.active[q.members[a][0]]&&dispersion.active[q.members[i][0]]&&dispersion.active[q.members[b][0]])pressureGradient[axis][i]=limited(offset[i]-offset[a],offset[b]-offset[i])/spacing;
        }
      }
      const reconstruct=(i:number,k:number,x:number,z:number)=>{const values=k===0?q.head:k===1?q.x:q.z;return values[i]+limiter[k][i]*(grad[k][0][i]*(x-q.cx[i])+grad[k][1][i]*(z-q.cz[i]));};
      type Transfer={a:number;b:number;v:number;normalA:number;normalB:number;normal:number;tangent:number;nx:number;nz:number;face:WaterCellFace};
      const transfers:Transfer[]=[];
      const reflections:{group:number;exchange:number;u:number;nx:number;nz:number;x:number;y:number;z:number;id?:string;bodyId?:string}[]=[],reflectionMass=new Map<number,number>();
      const addContact=(id:string,bodyId:string|undefined,x:number,y:number,z:number,ix:number,iz:number,speed:number,energy=0)=>{
        const key=`${bodyId??''}/${id}`,old=contacts.get(key);
        if(old){old.impulse.x+=ix;old.impulse.z+=iz;old.speed=Math.max(old.speed,speed);old.kineticEnergy+=energy;}
        else contacts.set(key,{colliderId:id,bodyId,point:{x,y,z},impulse:{x:ix,y:0,z:iz},force:{x:0,y:0,z:0},kineticEnergy:energy,speed});
      };
      for(const f of activeFaces){const a=q.owner[f.a],b=f.b<0?-1:q.owner[f.b];if(a===b)continue;
        const hydro=slow?!localSet.has(f):true;
        const x=(f.start.x+f.end.x)*.5,z=(f.start.z+f.end.z)*.5,shift=Math.max(c.solidDepth[f.a],f.b<0?0:c.solidDepth[f.b]),bed0=f.start.bed+shift,bed1=f.end.bed+shift;
        const left=aperture(reconstruct(a,0,x,z),bed0,bed1),right=b<0?{depth:0,square:0,max:0}:aperture(reconstruct(b,0,x,z),bed0,bed1);
        const baseA=aperture(q.head[a],bed0,bed1),baseB=b<0?{square:0}:aperture(q.head[b],bed0,bed1);
        // Exact terrain cuts and solid walls use each side's real bed/head.
        // An ordinary bulk cell's dry aperture already blocks hydrostatic
        // flux; reflecting it adds drag absent from the original solver.
        for(let side=0;side<2;side++){const group=side?b:a,region=side?f.b:f.a,sign=side?-1:1,opposite=side?f.a:f.b;if(group<0||q.volume[group]<=0)continue;
          const wall=(opposite>=0?s.boundary!.mesh.regions[opposite].solid:undefined)??f.barrier;
          const closed=b<0&&w.liquid.boundary==='closed'||(!bulk[group]||!!wall)&&q.head[group]<=Math.min(bed0,bed1)+1e-10;
          const wallLoad=hydro&&wall&&s.boundary!.mesh.regions[region].solid?.id!==wall.id;
          if(!closed&&!wallLoad)continue;
          const own0=(side?f.bedB0:f.bedA0)+c.solidDepth[region],own1=(side?f.bedB1:f.bedA1)+c.solidDepth[region];
          if(wallLoad){
            const axis=Math.abs(f.nx)>.5?'z':'x',start=f.start[axis],span=f.end[axis]-start;
            const loads=f.loads??[{...wall,start:Math.min(f.start[axis],f.end[axis]),end:Math.max(f.start[axis],f.end[axis])}];
            for(const item of loads){const t0=span?(item.start-start)/span:0,t1=span?(item.end-start)/span:1,lo=Math.max(0,Math.min(t0,t1)),hi=Math.min(1,Math.max(t0,t1));if(hi<=lo)continue;
              const load=wallPressure(q.head[group],own0+(own1-own0)*lo,own0+(own1-own0)*hi,item.bottom,item.top),force=rho*g*load.force*f.length*(hi-lo),t=lo+(hi-lo)*load.t;
              if(force)addContact(item.id,'bodyId' in item?item.bodyId as string|undefined:undefined,f.start.x+(f.end.x-f.start.x)*t,load.y,f.start.z+(f.end.z-f.start.z)*t,sign*force*f.nx*duration*.5,sign*force*f.nz*duration*.5,0);
            }
          }
          if(!closed)continue;
          const own=aperture(q.head[group],own0,own1);if(!own.depth)continue;
          const u=(q.x[group]*f.nx+q.z[group]*f.nz)*sign;
          if(hydro&&u>0){const exchange=(u+Math.sqrt(g*own.max))*own.depth*f.length*duration;reflectionMass.set(group,(reflectionMass.get(group)??0)+exchange);
            reflections.push({group,exchange,u,nx:sign*f.nx,nz:sign*f.nz,x,y:q.head[group]-own.depth/3,z,...((b<0||wall)&&!(wall&&'domain' in wall&&wall.domain)?{id:wall?.id??'water-body-boundary',bodyId:wall&&'bodyId' in wall?wall.bodyId as string|undefined:undefined}:{})});}
          if(capillary?.active[region]){const fx=(capillary.xx[region]*f.nx+capillary.xz[region]*f.nz)*duration*f.length, fz=(capillary.xz[region]*f.nx+capillary.zz[region]*f.nz)*duration*f.length;mx[group]-=sign*fx;mz[group]-=sign*fz;}
        }
        if(b<0&&w.liquid.boundary==='closed'||!left.depth&&!right.depth)continue;
        const ua=reconstruct(a,1,x,z)*f.nx+reconstruct(a,2,x,z)*f.nz,ub=b<0?0:reconstruct(b,1,x,z)*f.nx+reconstruct(b,2,x,z)*f.nz;
        const ta=bulk[a]?-reconstruct(a,1,x,z)*f.nz+reconstruct(a,2,x,z)*f.nx:-q.x[a]*f.nz+q.z[a]*f.nx,tb=b<0?0:bulk[b]?-reconstruct(b,1,x,z)*f.nz+reconstruct(b,2,x,z)*f.nx:-q.x[b]*f.nz+q.z[b]*f.nx,speed=Math.max(Math.abs(ua)+Math.sqrt(g*left.max),Math.abs(ub)+Math.sqrt(g*right.max));
        let flux=.5*(left.depth*ua+right.depth*ub)-.5*speed*(right.depth-left.depth);if(b<0)flux=Math.max(0,flux);
        // Same quarter-donor bound as an original cell. A subdivided interface
        // receives only its share of that face, never another full-cell cap.
        const donor=flux>=0?a:b;if(donor>=0&&bulk[donor]){const width=Math.abs(f.nx)>.5?w.cellSizeZ:w.cellSizeX,cap=q.volume[donor]/(4*duration*width);flux=Math.max(-cap,Math.min(cap,flux));}
        const scale=duration*f.length,v=flux*scale,normal=(.5*(left.depth*ua*ua+right.depth*ub*ub+.5*g*(left.square+right.square))-.5*speed*(right.depth*ub-left.depth*ua));
        const pressure=(i:number,cutSquare:number,baseSquare:number)=>{
          if(!bulk[i])return normal-.5*g*baseSquare;
          const depth=q.volume[i]/q.area[i],bed=q.head[i]-depth,raw=Math.max(0,reconstruct(i,0,x,z)-bed);
          return normal+.5*g*(raw*raw-cutSquare-depth*depth);
        };
        if(hydro){faceWork++;transfers.push({a,b,v,normalA:pressure(a,left.square,baseA.square)*scale,normalB:(b<0?0:pressure(b,right.square,baseB.square))*scale,normal:normal*scale,tangent:v*(v>=0?ta:tb),nx:f.nx,nz:f.nz,face:f});
          if(v>0)out[a]+=v;else if(b>=0)out[b]-=v;}
        if(b>=0){
          if(dispersion?.active[f.a]&&dispersion.active[f.b]&&Math.min(q.head[a],q.head[b])>Math.max(bed0,bed1)){
            const difference=(offset[b]-offset[a])*.5*g*scale;
            if(bulk[a]&&bulk[b]){const axis=Math.abs(f.nx)>.5?0:1,spacing=axis===0?w.cellSizeX:w.cellSizeZ,sign=axis===0?f.nx:f.nz,slope=(pressureGradient[axis][a]-pressureGradient[axis][b])*spacing*sign*.25*g*scale,ha=q.volume[a]/q.area[a],hb=q.volume[b]/q.area[b];mx[a]-=ha*(difference+slope)*f.nx;mz[a]-=ha*(difference+slope)*f.nz;mx[b]-=hb*(difference-slope)*f.nx;mz[b]-=hb*(difference-slope)*f.nz;}
            else{mx[a]-=left.depth*difference*f.nx;mz[a]-=left.depth*difference*f.nz;mx[b]-=right.depth*difference*f.nx;mz[b]-=right.depth*difference*f.nz;}}
          if(capillary&&(capillary.active[f.a]||capillary.active[f.b])&&Math.min(q.head[a],q.head[b])>=Math.max(bed0,bed1)-1e-9&&c.depth(f.a)>w.dryDepth&&c.depth(f.b)>w.dryDepth){
            const fx=((capillary.xx[f.a]+capillary.xx[f.b])*f.nx+(capillary.xz[f.a]+capillary.xz[f.b])*f.nz)*scale*.5,fz=((capillary.xz[f.a]+capillary.xz[f.b])*f.nx+(capillary.zz[f.a]+capillary.zz[f.b])*f.nz)*scale*.5;mx[a]-=fx;mz[a]-=fz;mx[b]+=fx;mz[b]+=fz;}
        }
      }
      // Accumulate against the frozen stage velocities. The shared denominator
      // is a convex average of normal projections, preventing corner overshoot
      // and face-order-dependent reflection or artificially created energy.
      const reflectionDelta=new Map<number,{x:number;z:number;weight:number}>();
      for(const r of reflections){const removed=r.u*(r.exchange/(q.volume[r.group]+reflectionMass.get(r.group)!)),d=reflectionDelta.get(r.group)??{x:0,z:0,weight:0};d.x+=removed*r.nx;d.z+=removed*r.nz;d.weight+=r.exchange*r.u*r.u;reflectionDelta.set(r.group,d);mx[r.group]-=q.volume[r.group]*removed*r.nx;mz[r.group]-=q.volume[r.group]*removed*r.nz;}
      for(const r of reflections)if(r.id){const d=reflectionDelta.get(r.group)!,removed=r.u*(r.exchange/(q.volume[r.group]+reflectionMass.get(r.group)!)),energy=Math.max(0,rho*q.volume[r.group]*(q.x[r.group]*d.x+q.z[r.group]*d.z-.5*(d.x*d.x+d.z*d.z)))*.5;
        addContact(r.id,r.bodyId,r.x,r.y,r.z,rho*q.volume[r.group]*removed*r.nx*.5,rho*q.volume[r.group]*removed*r.nz*.5,r.u,d.weight>0?energy*(r.exchange*r.u*r.u/d.weight):0);}
      for(const t of transfers){const donor=t.v>=0?t.a:t.b,factor=donor<0?0:Math.min(1,q.volume[donor]/Math.max(out[donor],1e-300)),v=t.v*factor,tx=t.tangent*factor;
        const f=t.face,receiver=v>=0?t.b:t.a,own=v>=0?f.a:f.b;
        const ownBed=v>=0?(f.bedA0+f.bedA1)*.5:(f.bedB0+f.bedB1)*.5,otherBed=v>=0?(f.bedB0+f.bedB1)*.5:(f.bedA0+f.bedA1)*.5;
        const flight=receiver>=0&&v&&q.head[receiver]<ownBed+c.solidDepth[own]-w.dryDepth?waterBodyGridFlight(w,geometry,{id:`region-${f.a}-${f.b}-${f.start.x}-${f.start.z}`,edge:[{x:f.start.x,y:0,z:f.start.z},{x:f.end.x,y:0,z:f.end.z}],nx:f.nx,nz:f.nz,spacing:Math.abs(f.nx)*w.cellSizeX+Math.abs(f.nz)*w.cellSizeZ,
          donorHead:q.head[donor],receiverHead:q.head[receiver],donorDepth:Math.max(0,q.head[donor]-ownBed-c.solidDepth[own]),...(!c.region(own)?.bulk?{bedDrop:ownBed-otherBed}:{}),flux:v,normal:t.normal*factor,tangent:tx/v,volume:Math.abs(v)*.5,time,duration}):undefined;
        if(flight){flightQueue??=createWaterBodyFlightQueue(s.flights??[],4096,waterBodyFlightReservation(w,s),waterBodyFlightCoalescing(w,geometry,dt));if(!flightQueue.canAppend(flight))continue;flightQueue.append(flight);s.flights=flightQueue.flights;}
        if(!(flight&&v<0)){dv[t.a]-=v;mx[t.a]-=t.normalA*factor*t.nx-tx*t.nz;mz[t.a]-=t.normalA*factor*t.nz+tx*t.nx;}
        if(t.b>=0){if(!(flight&&v>0)){dv[t.b]+=v;mx[t.b]+=t.normalB*factor*t.nx-tx*t.nz;mz[t.b]+=t.normalB*factor*t.nz+tx*t.nx;}}else outflow+=v*.5;
      }
      for(const i of ids){
        const old=q.volume[i],raw=old+dv[i];if(raw< -1e-9)throw new Error('Water body partial-cell flux became negative');
        let volume=Math.max(0,raw),px=0,pz=0;const depth=volume/q.area[i];
        if(depth>w.dryDepth){const ux=(old*q.x[i]+mx[i])/volume,uz=(old*q.z[i]+mz[i])/volume,speed=Math.hypot(ux,uz),roughness=w.friction/.25,inverse=1/depth,reference=1/WATER_BODY_PUDDLE_DEPTH;
          const viscous=roughness*3e-6*Math.max(0,inverse*inverse-reference*reference),shear=roughness*.01*speed*Math.max(0,inverse-reference),damping=(slow?!small[i]:patch!.owned.has(i))?Math.exp(-(w.friction+viscous)*duration)/(1+shear*duration):1,limit=Math.min(1,w.maxFlowSpeed/Math.max(speed,1e-10));px=volume*ux*damping*limit;pz=volume*uz*damping*limit;}
        if(stage){volume=(initialV[i]+volume)*.5;px=(initialX[i]+px)*.5;pz=(initialZ[i]+pz)*.5;}
        q.volume[i]=volume;q.x[i]=volume>w.dryDepth*q.area[i]?px/volume:0;q.z[i]=volume>w.dryDepth*q.area[i]?pz/volume:0;
      }
      for(const i of ids)q.head[i]=waterBodyRegionGroupHead(c,q.members[i],q.volume[i],q.head[i]);
    }
    };
    const advancePatch=(patch:Patch,duration:number,start:number)=>{if(!patch.ids.some(i=>q.volume[i]>0))return;let localRemaining=duration;
      while(localRemaining>1e-10){const rate=hydroRate(patch.faces,patch.ids,true),localStep=Math.min(localRemaining,rate>0?.4/rate:localRemaining);
        if(!(localStep>0)||!Number.isFinite(localStep))throw new Error('Water body partial-cell local step is invalid');
        advance(localStep,false,patch,start+duration-localRemaining+localStep*.5);localSubsteps++;localRemaining-=localStep;
      }
    };
    if(patches.length){
      // Fine operators surround one coarse-grid interval. This symmetric
      // composition keeps second-order time accuracy without evaluating all
      // bulk pressure/current stages twice for a handful of cut cells.
      for(let i=0;i<patches.length;i++)advancePatch(patches[i],step*.5,s.time-remaining);
      let normalRemaining=step,firstNormal=true;
      while(normalRemaining>1e-10){
        // The leading fine stages can raise a neighboring bulk cell's wave
        // speed. Recheck the bound rather than assuming the old CFL rate.
        const normalRate=hydroRate(normalFaces,all)+waterBodyCapillaryRate(w,s,q);
        const normalStep=Math.min(normalRemaining,normalRate>0?.4/normalRate:normalRemaining);
        if(!(normalStep>0)||!Number.isFinite(normalStep))throw new Error('Water body partial-cell coarse step is invalid');
        if(!firstNormal&&++substeps>w.maxGridSubsteps)throw new Error('Water body partial-cell CFL budget exceeded after local flow');
        advance(normalStep,true,undefined,s.time-remaining+step-normalRemaining+normalStep*.5);normalRemaining-=normalStep;firstNormal=false;
      }
      for(let i=patches.length-1;i>=0;i--)advancePatch(patches[i],step*.5,s.time-remaining+step*.5);
    }else advance(step,true,undefined,s.time-remaining+step*.5);
    writeGroups(c,q);mixWaterBodyCurrents(w,s,geometry,step,new Float64Array(q.members.length),new Float64Array(q.members.length),q);c.commit();remaining-=step;
  }
  let sleepingCells=0;
  const quiet=new Uint8Array(s.depth.length).fill(1);
  for(let i=0;i<c.count;i++)if(Math.hypot(c.flowX[i],c.flowZ[i])>w.sleepSpeed||Math.abs(c.level(i)-oldHead[i])>w.sleepSurfaceTolerance)quiet[c.parent(i)]=0;
  for(let i=0;i<s.depth.length;i++){if(quiet[i])s.quietTime[i]+=dt;else s.quietTime[i]=0;s.sleeping[i]=s.quietTime[i]>=w.sleepAfter;if(s.sleeping[i])sleepingCells++;}
  return{substeps,localSubsteps,faces:faceWork,sleepingCells,outflow};
}
