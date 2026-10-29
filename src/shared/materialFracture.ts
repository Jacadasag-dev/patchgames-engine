/** Seeded, connected fracture geometry. No renderer, images or physics dependency. */
export interface MaterialFracture {style:'impact'|'network';center:[number,number];spreadMeters:number;widthMeters:number;depthMeters:number;density:number;branching:number;irregularity:number;strength:number;roughness:number;color:string;seed:number}
const defaults:MaterialFracture={style:'network',center:[.5,.5],spreadMeters:1,widthMeters:.006,depthMeters:.002,density:.5,branching:.6,irregularity:.6,strength:1,roughness:.9,color:'#3d4247',seed:1};
export function parseMaterialFracture(input:unknown):MaterialFracture{
  if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Object.keys(input).some(k=>!Object.hasOwn(defaults,k)))throw Error('Fracture needs supported plain-data controls.');
  const r={...defaults,...Object.fromEntries(Object.entries(input).filter(([,v])=>v!==undefined))};
  const number=(n:unknown,a:number,b:number)=>{if(typeof n!=='number'||!Number.isFinite(n)||n<a||n>b)throw Error('Fracture parameter outside finite bounds.');};
  if(!['impact','network'].includes(r.style)||!/^#[0-9a-f]{6}$/i.test(r.color))throw Error('Invalid fracture style or color.');
  if(!Array.isArray(r.center)||r.center.length!==2)throw Error('Fracture center needs normalized U/V.');r.center=r.center.map(n=>{number(n,0,1);return n;}) as [number,number];
  number(r.spreadMeters,.002,100);number(r.widthMeters,.0002,.1);number(r.depthMeters,0,.05);number(r.seed,-2147483648,2147483647);if(!Number.isInteger(r.seed))throw Error('Fracture seed must be integer.');
  for(const k of ['density','branching','irregularity','strength','roughness'] as const)number(r[k],0,1);return r;
}
type Point=[number,number];
export interface FractureSegment {a:Point;b:Point;widthScale:number;parent:number}
function hash(a:number,b:number,s:number){let n=Math.imul(a^s,374761393)^Math.imul(b,668265263);n=Math.imul(n^(n>>>13),1274126177);return((n^(n>>>16))>>>0)/4294967295;}
/** Branches start exactly on parent vertices. Impact spokes share a common origin. */
export function compileMaterialFracture(r:MaterialFracture,tile:readonly[number,number],seed:number){
  const segments:FractureSegment[]=[],origin:Point=[r.center[0]*tile[0],r.center[1]*tile[1]],s=seed^r.seed;
  if(!r.strength||!r.density)return segments;
  function path(start:Point,angle:number,length:number,steps:number,width:number,id:number,parent=-1,branch=true){
    let a=start,last=parent;for(let j=0;j<steps;j++){
      const heading=angle+(hash(id,j,s)-.5)*r.irregularity*.9,step=length/steps*(.65+hash(id,j,s+3)*.7);
      const b:Point=[a[0]+Math.cos(heading)*step,a[1]+Math.sin(heading)*step],index=segments.length;
      segments.push({a,b,widthScale:width*(1-j/steps*.65),parent:last});
      if(branch&&j>0&&j<steps-1&&hash(id,j,s+11)<r.branching*.45)path(a,heading+(hash(id,j,s+13)>.5?1:-1)*(.35+hash(id,j,s+17)*.65),length*(.18+hash(id,j,s+19)*.2),3,width*.55,id*31+j,last,false);
      last=index;a=b;if(segments.length>=480)return;
    }
  }
  if(r.style==='impact'){
    const count=5+Math.round(r.density*13);
    for(let i=0;i<count;i++)path(origin,(i+(hash(i,0,s)-.5)*.65)/count*Math.PI*2,r.spreadMeters*(.6+hash(i,1,s)*.4),7,1,i);
    // Broken, angular ring fragments link spokes without perfect concentric circles.
    const rings=Math.round(r.density*3);for(let ring=1;ring<=rings;ring++){
      let previous:Point|undefined;const radius=r.spreadMeters*ring/(rings+2);
      for(let i=0;i<=count;i++){const angle=i/count*Math.PI*2,rad=radius*(.8+hash(i%count,ring,s+71)*.4*r.irregularity),p:Point=[origin[0]+Math.cos(angle)*rad,origin[1]+Math.sin(angle)*rad];if(previous&&hash(i,ring,s+73)<.55+r.branching*.3)segments.push({a:previous,b:p,widthScale:.4,parent:-1});previous=p;}
    }
  }else{
    const count=2+Math.round(r.density*8);
    for(let i=0;i<count;i++){const horizontal=hash(i,0,s)>.5,start:Point=horizontal?[0,hash(i,1,s)*tile[1]]:[hash(i,1,s)*tile[0],0];path(start,horizontal?(hash(i,2,s)-.5)*1.1:Math.PI/2+(hash(i,2,s)-.5)*1.1,r.spreadMeters*(.7+hash(i,3,s)*.6),9,1,i);}
  }
  return segments.slice(0,512);
}
export function createMaterialFractureSampler(r:MaterialFracture,tile:readonly[number,number],seed:number){
  const segments=compileMaterialFracture(r,tile,seed);
  return{segments,sample(u:number,v:number,footprintMeters=0){
    const x=u*tile[0],y=v*tile[1];let weight=0;
    for(const line of segments){const radius=r.widthMeters*line.widthScale/2,filter=Math.max(r.widthMeters*.15,footprintMeters*.6,.00001);
      if(x<Math.min(line.a[0],line.b[0])-radius-filter||x>Math.max(line.a[0],line.b[0])+radius+filter||y<Math.min(line.a[1],line.b[1])-radius-filter||y>Math.max(line.a[1],line.b[1])+radius+filter)continue;
      const dx=line.b[0]-line.a[0],dy=line.b[1]-line.a[1],t=Math.max(0,Math.min(1,((x-line.a[0])*dx+(y-line.a[1])*dy)/(dx*dx+dy*dy||1))),distance=Math.hypot(x-line.a[0]-dx*t,y-line.a[1]-dy*t);
      const a=Math.max(0,Math.min(1,.5+(radius-distance)/(filter*2)));weight=Math.max(weight,a*a*(3-2*a)*Math.min(1,radius*2/Math.max(footprintMeters,.00001)));
    }return weight*r.strength;
  }};
}
