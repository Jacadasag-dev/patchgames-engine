import {BufferGeometry,Color,Float32BufferAttribute,Group,Mesh,MeshStandardMaterial,type ColorRepresentation} from 'three';
import type {TerrainVolumesManifest} from './terrainVolumes.ts';

export interface TerrainVolumesViewOptions {sideColor?:ColorRepresentation;undersideColor?:ColorRepresentation;roughness?:number}
/** Draws the same accepted top, underside and hole walls as solid collision.
 * Visibility is presentation-only; it never edits physics or water supports. */
export class TerrainVolumesView {
  readonly root=new Group();
  readonly manifest:TerrainVolumesManifest;
  private readonly slabs=new Map<string,Mesh>();
  constructor(manifest:TerrainVolumesManifest,options:TerrainVolumesViewOptions={}){
    this.manifest=manifest;
    const s=manifest.surface,color=new Color();
    for(const slab of manifest.slabs){
      const positions:number[]=[],normals:number[]=[],colors:number[]=[];
      for(let i=0;i<s.slabIds.length;i++)if(s.slabIds[i]===slab.id){
        positions.push(...s.positions.slice(i*9,i*9+9));normals.push(...s.normals.slice(i*9,i*9+9));
        color.set(s.kinds[i]==='top'?slab.color??'#79956a':s.kinds[i]==='underside'?options.undersideColor??'#756b60':options.sideColor??'#94816a');
        for(let vertex=0;vertex<3;vertex++)colors.push(color.r,color.g,color.b);
      }
      const geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute(positions,3));geometry.setAttribute('normal',new Float32BufferAttribute(normals,3));geometry.setAttribute('color',new Float32BufferAttribute(colors,3));geometry.computeBoundingSphere();
      const mesh=new Mesh(geometry,new MeshStandardMaterial({vertexColors:true,roughness:options.roughness??.9}));mesh.name=slab.id;mesh.castShadow=mesh.receiveShadow=true;
      this.slabs.set(slab.id,mesh);this.root.add(mesh);
    }
  }
  setVisibleSlabs(ids?:readonly string[]):void {const visible=ids&&new Set(ids);for(const [id,mesh] of this.slabs)mesh.visible=!visible||visible.has(id);}
  dispose():void {for(const mesh of this.slabs.values()){mesh.geometry.dispose();(mesh.material as MeshStandardMaterial).dispose();}this.slabs.clear();this.root.clear();this.root.removeFromParent();}
}
