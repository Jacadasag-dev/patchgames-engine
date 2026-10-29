import * as THREE from 'three';
import {BOX_SURFACES,generateObjectSurface,objectSurfaceMaterialIds,type ObjectSurfaceBake,type ObjectSurfaceDocument} from '../shared/objectSurface.ts';
import {onMaterialRecipesChanged} from '../shared/materialRegistry.ts';
import {createGeneratedMaterialFromPixels} from './materialGenerator.ts';
export {BOX_SURFACES,objectSurfaceSchema,objectSurfaceDocumentSchema,generateObjectSurface,OBJECT_SURFACE_EXAMPLES} from '../shared/objectSurface.ts';
export type {ObjectSurfaceRecipe,ObjectSurfaceDocument,ObjectSurfaceBake,BoxSurface} from '../shared/objectSurface.ts';

/** Box renderer for model-local surface recipes. Swaps atomically; owns all generated GPU resources. */
export class ObjectSurfaceView {
  readonly root=new THREE.Mesh<THREE.BoxGeometry,THREE.MeshStandardMaterial[]>();
  private handles:ReturnType<typeof createGeneratedMaterialFromPixels>[]=[];
  private size='';private disposed=false;private generation=0;private unsubscribe:(()=>void)|undefined;
  ready:Promise<void>=Promise.resolve();
  constructor(baked:ObjectSurfaceBake){this.update(baked);}
  update(baked:ObjectSurfaceBake):void{
    if(this.disposed)throw Error('Object surface view is disposed.');
    this.generation++;
    const next=baked.recipe.sizeMeters.join(','),handles=BOX_SURFACES.map(name=>createGeneratedMaterialFromPixels(baked.faces[name]));
    for(const handle of handles)for(const map of Object.values(handle.maps))map.wrapS=map.wrapT=THREE.ClampToEdgeWrapping;
    if(next!==this.size){const old=this.root.geometry;this.root.geometry=new THREE.BoxGeometry(...baked.recipe.sizeMeters);old.dispose();this.size=next;}
    const previous=this.handles;this.handles=handles;this.root.material=handles.map(h=>h.material);this.root.name=baked.recipe.name;
    this.root.userData.objectSurface={recipe:baked.recipe,diagnostics:baked.diagnostics};previous.forEach(h=>h.dispose());
  }
  /** Follow shared material IDs; an invalid/deleted dependency retains the last valid object with a diagnostic. */
  follow(input:ObjectSurfaceDocument,options:Parameters<typeof generateObjectSurface>[1]={}):void{
    if(this.disposed)throw Error('Object surface view is disposed.');this.generation++;this.unsubscribe?.();this.ready=Promise.resolve();const document=structuredClone(input),ids=new Set(objectSurfaceMaterialIds(document));
    this.unsubscribe=onMaterialRecipesChanged(changed=>{if(![...changed].some(id=>ids.has(id)))return;const generation=++this.generation;
      this.ready=generateObjectSurface(document,options).then(baked=>{if(!this.disposed&&generation===this.generation){this.update(baked);delete this.root.userData.objectSurfaceError;}},error=>{if(!this.disposed&&generation===this.generation)this.root.userData.objectSurfaceError=String(error);throw error;});void this.ready.catch(()=>{});
    });
  }
  dispose():void{if(this.disposed)return;this.disposed=true;this.generation++;this.unsubscribe?.();this.root.geometry.dispose();this.handles.forEach(h=>h.dispose());this.handles=[];}
}
/** Loading-time convenience. Interactive authoring should bake in a worker, then call view.update. */
export async function createObjectSurfaceView(recipe:ObjectSurfaceDocument,options:Parameters<typeof generateObjectSurface>[1]={}){const config={yieldControl:()=>new Promise<void>(resolve=>setTimeout(resolve,0)),...options},view=new ObjectSurfaceView(await generateObjectSurface(recipe,config));view.follow(recipe,config);return view;}
