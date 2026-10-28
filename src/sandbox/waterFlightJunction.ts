import type {PhysicsVector} from './physics.ts';

export interface WaterFlightJunctionVertex {p:PhysicsVector;n:PhysicsVector;u:number;tone:number}
type Vertex=WaterFlightJunctionVertex;
type Triangle=[Vertex,Vertex,Vertex];
const subtract=(a:PhysicsVector,b:PhysicsVector):PhysicsVector=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const dot=(a:PhysicsVector,b:PhysicsVector)=>a.x*b.x+a.y*b.y+a.z*b.z;
const cross=(a:PhysicsVector,b:PhysicsVector):PhysicsVector=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
const magnitude=(p:PhysicsVector)=>Math.hypot(p.x,p.y,p.z);
const finite=(p:PhysicsVector)=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&Number.isFinite(p.z);
function interpolate(a:Vertex,b:Vertex,t:number):Vertex {
  if(t<=0)return a;if(t>=1)return b;
  const lerp=(a:number,b:number)=>a+(b-a)*t,n={x:lerp(a.n.x,b.n.x),y:lerp(a.n.y,b.n.y),z:lerp(a.n.z,b.n.z)},length=magnitude(n);
  return{p:{x:lerp(a.p.x,b.p.x),y:lerp(a.p.y,b.p.y),z:lerp(a.p.z,b.p.z)},n:length>0?{x:n.x/length,y:n.y/length,z:n.z/length}:n,u:lerp(a.u,b.u),tone:lerp(a.tone,b.tone)};
}
function area(vertices:readonly Vertex[]):PhysicsVector {
  const origin=vertices[0].p,result={x:0,y:0,z:0};
  for(let i=1;i+1<vertices.length;i++){const n=cross(subtract(vertices[i].p,origin),subtract(vertices[i+1].p,origin));result.x+=n.x;result.y+=n.y;result.z+=n.z;}return result;
}
function prepare(input:readonly Vertex[],across:PhysicsVector):Vertex[]|undefined {
  if(input.length<3||input.length>64)return;
  if(input.some(v=>!finite(v.p)||!finite(v.n)||!Number.isFinite(v.u)||!Number.isFinite(v.tone)))return;
  const vertices=input.filter((v,i)=>magnitude(subtract(v.p,input[(i+input.length-1)%input.length].p))>0);if(vertices.length<3)return;
  const normal=area(vertices),size=magnitude(normal);if(!(size>0&&Number.isFinite(size)))return;
  for(let i=0;i<vertices.length;i++){
    const a=subtract(vertices[(i+1)%vertices.length].p,vertices[i].p),b=subtract(vertices[(i+2)%vertices.length].p,vertices[(i+1)%vertices.length].p),turn=dot(cross(a,b),normal);
    if(turn< -64*Number.EPSILON*size*magnitude(a)*magnitude(b))return;
  }
  const projections=vertices.map(v=>dot(v.p,across)),maximum=Math.max(...projections),tolerance=64*Number.EPSILON*Math.max(1,Math.abs(maximum)),extreme=vertices.map((_,i)=>i).filter(i=>maximum-projections[i]<=tolerance);
  let first=extreme[0],second=first,longest=0;
  for(const i of extreme)for(const j of extreme){const length=magnitude(subtract(vertices[i].p,vertices[j].p));if(length>longest){first=i;second=j;longest=length;}}
  if(longest===0)return vertices.slice(first).concat(vertices.slice(0,first));
  const a=vertices[first].p,b=vertices[second].p,target={x:(a.x+b.x)*.5,y:(a.y+b.y)*.5,z:(a.z+b.z)*.5};
  let nearest=Infinity,edge=0,fraction=0;
  for(let i=0;i<vertices.length;i++){
    const a=vertices[i].p,d=subtract(vertices[(i+1)%vertices.length].p,a),squared=dot(d,d),t=squared>0?Math.max(0,Math.min(1,dot(subtract(target,a),d)/squared)):0,point={x:a.x+d.x*t,y:a.y+d.y*t,z:a.z+d.z*t},distance=magnitude(subtract(target,point));
    if(distance<nearest){nearest=distance;edge=i;fraction=t;}
  }
  if(fraction===0)return vertices.slice(edge).concat(vertices.slice(0,edge));
  const next=(edge+1)%vertices.length;if(fraction===1)return vertices.slice(next).concat(vertices.slice(0,next));
  return[interpolate(vertices[edge],vertices[next],fraction),...vertices.slice(next),...vertices.slice(0,next)];
}
function perimeter(vertices:readonly Vertex[]):number[]{
  const lengths=[0];for(let i=0;i<vertices.length;i++)lengths.push(lengths[i]+magnitude(subtract(vertices[(i+1)%vertices.length].p,vertices[i].p)));
  const total=lengths[lengths.length-1];return lengths.map(v=>v/total);
}

/** Loft two convex cross sections without dropping any contour vertex or edge.
 * The contours advance through their merged perimeter events; each original
 * boundary edge belongs to one triangle instead of being replaced by a chord.
 * Inputs are read-only. Invalid contours produce no invented geometry. */
export function waterFlightJunction(newer:readonly Vertex[],older:readonly Vertex[],across:PhysicsVector):Triangle[]{
  const axisLength=magnitude(across);if(!finite(across)||!(axisLength>0))return[];
  const axis={x:across.x/axisLength,y:across.y/axisLength,z:across.z/axisLength},a=prepare(newer,axis),rawB=prepare(older,axis);if(!a||!rawB)return[];
  const b=dot(area(a),area(rawB))<0?[rawB[0],...rawB.slice(1).reverse()]:rawB,pa=perimeter(a),pb=perimeter(b),result:Triangle[]=[];let i=0,j=0;
  const emit=(a:Vertex,b:Vertex,c:Vertex)=>{const ab=subtract(b.p,a.p),ac=subtract(c.p,a.p);if(magnitude(cross(ab,ac))>64*Number.EPSILON*magnitude(ab)*magnitude(ac))result.push([a,b,c]);};
  while(i<a.length||j<b.length){
    const hereA=a[i%a.length],hereB=b[j%b.length],nextA=i<a.length?pa[i+1]:Infinity,nextB=j<b.length?pb[j+1]:Infinity;
    if(nextA<=nextB){emit(hereA,hereB,a[(i+1)%a.length]);i++;}
    else{emit(hereA,b[(j+1)%b.length],hereB);j++;}
  }
  return result;
}
