/** Textured sheet rendering from authoritative deformation nodes. Original
 * UV seams and material groups survive clipping against the collision grid. */
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, Mesh, Quaternion, Vector3, type Material } from 'three';
import { deformationPoints, type DeformationPanel } from './deformation.ts';
import { structuralDeformationPanel, type DestructionState, type StructuralMember } from './destruction.ts';
import type { PhysicsVector } from './physics.ts';

type Vertex = { point: PhysicsVector; uv: [number,number] };
type Sample = Vertex & { nodes:[number,number,number]; weights:[number,number,number] };
function mix(a:Vertex,b:Vertex,t:number):Vertex {return {point:{x:a.point.x+(b.point.x-a.point.x)*t,y:a.point.y+(b.point.y-a.point.y)*t,z:a.point.z+(b.point.z-a.point.z)*t},uv:[a.uv[0]+(b.uv[0]-a.uv[0])*t,a.uv[1]+(b.uv[1]-a.uv[1])*t]};}
function clip(polygon:Vertex[],a:PhysicsVector,b:PhysicsVector,panel:DeformationPanel):Vertex[]{
  const u=panel.uAxis,v=panel.vAxis,side=(p:PhysicsVector)=>(b[u]-a[u])*(p[v]-a[v])-(b[v]-a[v])*(p[u]-a[u]);
  const out:Vertex[]=[];for(let i=0;i<polygon.length;i++){const p=polygon[i],q=polygon[(i+1)%polygon.length],s=side(p.point),t=side(q.point);
    if(s>=-1e-10)out.push(p);if((s>=0)!==(t>=0))out.push(mix(p,q,s/(s-t)));}return out;
}
function samples(source:BufferGeometry,panel:DeformationPanel):{vertices:Sample[];groups:{start:number;count:number;materialIndex:number}[]}{
  const positions=source.getAttribute('position'),uv=source.getAttribute('uv'),index=source.index,count=index?.count??positions?.count??0;
  if(!positions||positions.itemSize!==3||!uv||uv.itemSize!==2||count%3||count>24576)throw new Error('Deformation appearance requires bounded triangle positions and UVs');
  const vertices:Sample[]=[],groups:{start:number;count:number;materialIndex:number}[]=[];
  for(let i=0;i<count;i+=3){
    const ids=[0,1,2].map(n=>index?index.getX(i+n):i+n),triangle=ids.map(j=>({point:{x:positions.getX(j),y:positions.getY(j),z:positions.getZ(j)},uv:[uv.getX(j),uv.getY(j)] as [number,number]}));
    const materialIndex=source.groups.find(g=>i>=g.start&&i<g.start+g.count)?.materialIndex??0,start=vertices.length;
    for(const nodes of panel.triangles){const [a,b,c]=nodes.map(j=>panel.points[j]);let polygon=clip(triangle,a,b,panel);polygon=clip(polygon,b,c,panel);polygon=clip(polygon,c,a,panel);
      const u=panel.uAxis,v=panel.vAxis,den=(b[v]-c[v])*(a[u]-c[u])+(c[u]-b[u])*(a[v]-c[v]);
      const sample=(vertex:Vertex):Sample=>{const p=vertex.point,w0=((b[v]-c[v])*(p[u]-c[u])+(c[u]-b[u])*(p[v]-c[v]))/den,
        w1=((c[v]-a[v])*(p[u]-c[u])+(a[u]-c[u])*(p[v]-c[v]))/den;return {...vertex,nodes,weights:[w0,w1,1-w0-w1]};};
      for(let j=1;j+1<polygon.length;j++){const points=[polygon[0],polygon[j],polygon[j+1]];
        const ab=new Vector3().copy(points[1].point).sub(points[0].point),ac=new Vector3().copy(points[2].point).sub(points[0].point);
        if(ab.cross(ac).lengthSq()>1e-20)vertices.push(...points.map(sample));}
    }
    if(vertices.length>start)groups.push({start,count:vertices.length-start,materialIndex});
  }
  return {vertices,groups};
}
export class DeformationView {
  readonly root=new Group();readonly mesh:Mesh;
  readonly member:StructuralMember;
  private readonly panel:DeformationPanel;private readonly vertices:Sample[];private readonly geometry=new BufferGeometry();private disposed=false;
  /** Material is caller-owned. An optional source appearance is in physical,
   * centred collider-local coordinates, including its original UVs/groups. */
  constructor(member:StructuralMember,material:Material|Material[],options:{geometry?:BufferGeometry}={}){
    this.member=member;
    const panel=structuralDeformationPanel(member);if(!panel)throw new Error('DeformationView requires a ductile member');this.panel=panel;
    const shape=panel.collider.shape;if(shape.kind!=='box')throw new Error('DeformationView requires a box');
    const source=options.geometry??new BoxGeometry(shape.halfExtents.x*2,shape.halfExtents.y*2,shape.halfExtents.z*2);
    const prepared=samples(source,panel);if(!options.geometry)source.dispose();this.vertices=prepared.vertices;
    this.geometry.setAttribute('position',new Float32BufferAttribute(prepared.vertices.flatMap(v=>[v.point.x,v.point.y,v.point.z]),3));
    this.geometry.setAttribute('uv',new Float32BufferAttribute(prepared.vertices.flatMap(v=>v.uv),2));
    if(Array.isArray(material))for(const group of prepared.groups)this.geometry.addGroup(group.start,group.count,Math.min(material.length-1,group.materialIndex));
    this.geometry.computeVertexNormals();this.mesh=new Mesh(this.geometry,material);this.mesh.castShadow=true;this.mesh.receiveShadow=true;this.root.add(this.mesh);
    this.root.name=`deformation:${member.id}`;this.mesh.position.copy(panel.collider.position);if(panel.collider.rotation)this.mesh.quaternion.copy(panel.collider.rotation);
  }
  update(state:DestructionState):void{
    if(this.disposed)throw new Error('DeformationView has been disposed');
    const deformation=state.deformations?.[this.member.id];if(!deformation)throw new Error('Missing authoritative deformation state');
    deformationPoints(this.panel,deformation);const position=this.geometry.getAttribute('position'),axis=this.panel.normalAxis;
    this.vertices.forEach((sample,i)=>{const p={...sample.point};p[axis]+=sample.nodes.reduce((sum,node,j)=>sum+deformation.offsets[node]*sample.weights[j],0);position.setXYZ(i,p.x,p.y,p.z);});
    position.needsUpdate=true;this.geometry.computeVertexNormals();this.geometry.computeBoundingBox();this.geometry.computeBoundingSphere();
    const cluster=state.clusters.find(c=>c.memberIds.includes(this.member.id));
    if(cluster){const q=new Quaternion().copy(cluster.rotation);this.mesh.position.copy(this.panel.collider.position).sub(cluster.origin).applyQuaternion(q).add(cluster.position);
      this.mesh.quaternion.copy(this.panel.collider.rotation??new Quaternion()).premultiply(q);}
    else{this.mesh.position.copy(this.panel.collider.position);this.mesh.quaternion.copy(this.panel.collider.rotation??new Quaternion());}
  }
  dispose():void{if(this.disposed)return;this.disposed=true;this.geometry.dispose();this.root.removeFromParent();this.root.clear();}
}
