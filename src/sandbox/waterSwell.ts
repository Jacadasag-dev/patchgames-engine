/** Authoring-time, finite incoming wind-swell energy in existing water. */
import type {WaterBodyManifest,WaterBodyState} from './waterBody.ts';
import {waterBodyGeometry} from './waterBodyGrid.ts';
import type {PhysicsScene} from './physics.ts';
import type {WaterSwell} from './waterSystem.ts';
import {waterBodyCells} from './waterBodyCells.ts';
import {cloneBoundaryState} from './waterBoundary.ts';

/** A compact wave packet represents wind energy acquired offshore. Its depth
 * perturbation integrates to zero separately in each connected wet component;
 * matching finite-depth travelling momentum is c*eta. No mass is supplied and
 * no oscillation is imposed after this call. Ordinary physics evolves it. */
export function seedWaterSwell(w:WaterBodyManifest,s:WaterBodyState,scene:PhysicsScene,swell:WaterSwell):WaterBodyState {
  if(!swell||typeof swell!=='object'||Array.isArray(swell)||Object.keys(swell).some(k=>!['center','direction','height','wavelength','width','length'].includes(k)))throw new Error('Invalid water swell');
  for(const key of ['center','direction'] as const){const p=swell[key];if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>k!=='x'&&k!=='z')||!Number.isFinite(p.x)||!Number.isFinite(p.z))throw new Error(`Invalid water swell ${key}`);}
  const magnitude=Math.hypot(swell.direction.x,swell.direction.z),spacing=Math.max(w.cellSizeX,w.cellSizeZ);
  const width=swell.width??Math.hypot(w.columns*w.cellSizeX,w.rows*w.cellSizeZ),length=swell.length??3*swell.wavelength;
  if(!magnitude||magnitude>1e6||Math.abs(swell.center.x)>10000||Math.abs(swell.center.z)>10000||!Number.isFinite(swell.height)||swell.height<0||swell.height>10
    ||!Number.isFinite(swell.wavelength)||swell.wavelength<8*spacing||swell.wavelength>2048||!Number.isFinite(width)||width<2*spacing||width>2048||!Number.isFinite(length)||length<swell.wavelength||length>2048)throw new Error('Invalid water swell extent/resolution');
  if(swell.height===0)return s;
  if(s.boundary)return seedBoundarySwell(w,s,swell,magnitude,width,length);
  const geometry=waterBodyGeometry(w,scene),n=s.depth.length,component=new Int32Array(n);component.fill(-1);
  const dx=swell.direction.x/magnitude,dz=swell.direction.z/magnitude,k=2*Math.PI/swell.wavelength;
  const envelope=new Float64Array(n),shape=new Float64Array(n),parts:{cells:number[];weight:number;sum:number}[]=[];
  for(let i=0;i<n;i++){
    if(s.depth[i]<=w.wetDepth||geometry.blocked[i])continue;
    const px=w.origin.x+(Math.floor(i/w.rows)+.5)*w.cellSizeX-swell.center.x,pz=w.origin.z+(i%w.rows+.5)*w.cellSizeZ-swell.center.z;
    const along=px*dx+pz*dz,across=-px*dz+pz*dx;
    if(Math.abs(along)>=length/2||Math.abs(across)>=width/2)continue;
    envelope[i]=Math.cos(Math.PI*along/length)**2*Math.cos(Math.PI*across/width)**2;shape[i]=Math.cos(k*along);
  }
  const open=(i:number,j:number,axis:'x'|'z')=>{const b=axis==='x'?geometry.x[Math.max(i,j)]:geometry.z[Math.floor(i/w.rows)*(w.rows+1)+Math.max(i%w.rows,j%w.rows)];return !b||b.top<Math.min(s.bed[i]+s.depth[i]+(s.solidDepth?.[i]??0),s.bed[j]+s.depth[j]+(s.solidDepth?.[j]??0))-1e-8;};
  for(let start=0;start<n;start++)if(envelope[start]>0&&component[start]<0){
    const id=parts.length,part={cells:[start],weight:0,sum:0};component[start]=id;
    for(let at=0;at<part.cells.length;at++){
      const i=part.cells[at];part.weight+=envelope[i];part.sum+=envelope[i]*shape[i];
      for(const [j,axis] of [[i-w.rows,'x'],[i+w.rows,'x'],[i%w.rows?i-1:-1,'z'],[i%w.rows+1<w.rows?i+1:n,'z']] as const)
        if(j>=0&&j<n&&envelope[j]>0&&component[j]<0&&open(i,j,axis)){component[j]=id;part.cells.push(j);}
    }
    parts.push(part);
  }
  const next={...s,depth:s.depth.slice(),flowX:s.flowX.slice(),flowZ:s.flowZ.slice(),sleeping:s.sleeping.slice(),quietTime:s.quietTime.slice(),revision:s.revision+1};
  for(const part of parts){
    let scale=1;const mean=part.sum/part.weight;
    for(const i of part.cells){const eta=swell.height*.5*envelope[i]*(shape[i]-mean),headroom=w.liquid.bounds.max.y-s.bed[i]-s.depth[i]-(s.solidDepth?.[i]??0);
      if(eta<0)scale=Math.min(scale,s.depth[i]*.45/-eta);else if(eta>0)scale=Math.min(scale,Math.max(0,headroom)/eta);}
    for(const i of part.cells){
      const eta=scale*swell.height*.5*envelope[i]*(shape[i]-mean),h=s.depth[i]+eta;
      const c=Math.sqrt(-w.liquid.gravity.y/k*Math.tanh(k*s.depth[i]));
      let vx=(s.depth[i]*s.flowX[i]+c*eta*dx)/h,vz=(s.depth[i]*s.flowZ[i]+c*eta*dz)/h;
      const speed=Math.hypot(vx,vz),limit=Math.max(w.maxFlowSpeed,Math.hypot(s.flowX[i],s.flowZ[i]));if(speed>limit){vx*=limit/speed;vz*=limit/speed;}
      next.depth[i]=h;next.flowX[i]=vx;next.flowZ[i]=vz;if(eta){next.sleeping[i]=false;next.quietTime[i]=0;}
    }
  }
  return next;
}

/** The same packet on physical regions: area-weighted perturbations have zero
 * volume in each connected wet component, including two sides of one cell. */
function seedBoundarySwell(w:WaterBodyManifest,s:WaterBodyState,swell:WaterSwell,magnitude:number,width:number,length:number):WaterBodyState{
  const cells=waterBodyCells(w,s),n=cells.count,dx=swell.direction.x/magnitude,dz=swell.direction.z/magnitude,k=2*Math.PI/swell.wavelength;
  const envelope=new Float64Array(n),shape=new Float64Array(n),seen=new Uint8Array(n),neighbors=Array.from({length:n},()=>[] as number[]);
  for(let i=0;i<n;i++){
    if(cells.depth(i)<=w.wetDepth)continue;
    const p=cells.center(i),px=p.x-swell.center.x,pz=p.z-swell.center.z,along=px*dx+pz*dz,across=-px*dz+pz*dx;
    if(Math.abs(along)>=length/2||Math.abs(across)>=width/2)continue;
    envelope[i]=Math.cos(Math.PI*along/length)**2*Math.cos(Math.PI*across/width)**2;shape[i]=Math.cos(k*along);
  }
  for(const face of cells.faces()){
    if(face.b<0||!envelope[face.a]||!envelope[face.b])continue;
    const crest=Math.max(Math.min(face.start.bed,face.end.bed),face.barrier?.top??-Infinity);
    if(Math.min(cells.level(face.a),cells.level(face.b))<=crest+1e-8)continue;
    neighbors[face.a].push(face.b);neighbors[face.b].push(face.a);
  }
  const next:WaterBodyState={...s,boundary:cloneBoundaryState(s.boundary!),depth:s.depth.slice(),flowX:s.flowX.slice(),flowZ:s.flowZ.slice(),sleeping:s.sleeping.slice(),quietTime:s.quietTime.slice(),...(s.solidDepth?{solidDepth:s.solidDepth.slice()}:{}),revision:s.revision+1};
  const out=waterBodyCells(w,next);
  for(let start=0;start<n;start++)if(envelope[start]>0&&!seen[start]){
    const part=[start];seen[start]=1;let weight=0,sum=0;
    for(let at=0;at<part.length;at++){
      const i=part[at],area=cells.area(i);weight+=envelope[i]*area;sum+=envelope[i]*shape[i]*area;
      for(const j of neighbors[i])if(!seen[j]){seen[j]=1;part.push(j);}
    }
    const mean=sum/weight;let scale=1;
    const delta=(i:number)=>swell.height*.5*envelope[i]*(shape[i]-mean)*cells.area(i);
    for(const i of part){
      const amount=delta(i),volume=cells.volume(i);
      if(amount<0)scale=Math.min(scale,volume*.45/-amount);
      else if(amount>0)scale=Math.min(scale,Math.max(0,cells.capacityAtHead(i,w.liquid.bounds.max.y)-volume)/amount);
    }
    for(const i of part){
      const amount=scale*delta(i),volume=cells.volume(i),total=volume+amount,depth=cells.depth(i);
      const c=Math.sqrt(-w.liquid.gravity.y/k*Math.tanh(k*depth));
      let vx=(volume*cells.flowX[i]+c*amount*dx)/total,vz=(volume*cells.flowZ[i]+c*amount*dz)/total;
      const speed=Math.hypot(vx,vz),limit=Math.max(w.maxFlowSpeed,Math.hypot(cells.flowX[i],cells.flowZ[i]));
      if(speed>limit){vx*=limit/speed;vz*=limit/speed;}
      out.setVolume(i,total);out.flowX[i]=vx;out.flowZ[i]=vz;if(amount)out.wake(i);
    }
  }
  out.commit();return next;
}
