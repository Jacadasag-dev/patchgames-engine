/** Public generated-building adapter for automatic layered water geometry. */
import type {BuildingManifest} from './building.ts';
import type {PhysicsScene,PhysicsVector,PhysicsRotation} from './physics.ts';
import type {WaterWorldSupportPatch} from './waterWorld.ts';
import {liquidObstacles,liquidRotate} from './liquidCollision.ts';

function rotate(p:PhysicsVector,q:PhysicsRotation):PhysicsVector {
  const tx=2*(q.y*p.z-q.z*p.y),ty=2*(q.z*p.x-q.x*p.z),tz=2*(q.x*p.y-q.y*p.x);
  return{x:p.x+q.w*tx+q.y*tz-q.z*ty,y:p.y+q.w*ty+q.z*tx-q.x*tz,z:p.z+q.w*tz+q.x*ty-q.y*tx};
}

/** Surface planes come from the same compiler as native floor/tread/ramp collision.
 * Asset families may declare a real upward support surface tagged water-support
 * (for example a sink bowl bottom). No layer IDs, routes or water transfers are
 * authored here; the world compiler resolves those from these world triangles.
 */
export function compileBuildingToWaterGeometry(building:BuildingManifest):{scene:PhysicsScene;supports:WaterWorldSupportPatch[]} {
  if(!building.diagnostics.valid)throw new Error('Water geometry requires a valid generated building');
  const supports:WaterWorldSupportPatch[]=[],origin=building.recipe.origin??{x:0,y:0,z:0},yaw=building.recipe.yaw??0,c=Math.cos(yaw),s=Math.sin(yaw);
  const scene:PhysicsScene={colliders:building.colliders.map((collider,i)=>({...collider,id:collider.id??`${building.id}:solid:${i}`}))};
  // Keep the Building compiler's larger bounded input contract. The eventual
  // WaterWorld separately enforces its smaller native-scene budget.
  const obstacles=Array.from({length:Math.ceil(scene.colliders.length/256)},(_,i)=>liquidObstacles({colliders:scene.colliders.slice(i*256,(i+1)*256)},[])).flat();
  const supportingCollider=(vertices:PhysicsVector[]):string|undefined=>{
    const tolerance=1e-6;
    for(const o of obstacles){
      if(!o.planes||vertices.some(p=>p.x<o.min.x-tolerance||p.x>o.max.x+tolerance||p.y<o.min.y-tolerance||p.y>o.max.y+tolerance||p.z<o.min.z-tolerance||p.z>o.max.z+tolerance))continue;
      const local=vertices.map(p=>liquidRotate({x:p.x-o.collider.position.x,y:p.y-o.collider.position.y,z:p.z-o.collider.position.z},o.inverseRotation));
      const signed=(p:PhysicsVector,n:PhysicsVector,offset:number)=>p.x*n.x+p.y*n.y+p.z*n.z-offset;
      if(o.planes.some(({normal:n,offset})=>local.some(p=>signed(p,n,offset)>tolerance)))continue;
      if(o.planes.some(({normal:n,offset})=>liquidRotate(n,o.collider.rotation).y>1e-6&&local.every(p=>Math.abs(signed(p,n,offset))<=tolerance)))return o.colliderId;
    }
  };
  const world=(p:PhysicsVector):PhysicsVector=>({x:origin.x+c*p.x+s*p.z,y:origin.y+p.y,z:origin.z-s*p.x+c*p.z});
  const quad=(id:string,a:PhysicsVector,b:PhysicsVector,c:PhysicsVector,d:PhysicsVector)=>{
    const colliderId=supportingCollider([a,b,c,d]),owner=colliderId?{colliderId}:{};
    supports.push({id:`${id}:0`,...owner,vertices:[a,d,c]},{id:`${id}:1`,...owner,vertices:[a,c,b]});
  };
  for(const plane of building.surfaces){
    const at=(x:number,z:number)=>world({x,y:plane.y+plane.slopeX*(x-plane.centerX)+plane.slopeZ*(z-plane.centerZ),z});
    quad(plane.id,at(plane.minX,plane.minZ),at(plane.maxX,plane.minZ),at(plane.maxX,plane.maxZ),at(plane.minX,plane.maxZ));
  }
  for(const part of building.parts)for(const surface of part.model?.surfaces??[]){
    if(!surface.tags.includes('water-support'))continue;
    const angle=surface.yaw??0,co=Math.cos(angle),si=Math.sin(angle);
    const at=(x:number,z:number):PhysicsVector=>{
      const p=rotate({x:surface.position.x+co*x+si*z,y:surface.position.y,z:surface.position.z-si*x+co*z},part.rotation);
      return{x:part.position.x+p.x,y:part.position.y-part.size.y/2+p.y,z:part.position.z+p.z};
    };
    quad(`${part.id}:support:${surface.id}`,at(-surface.width/2,-surface.depth/2),at(surface.width/2,-surface.depth/2),at(surface.width/2,surface.depth/2),at(-surface.width/2,surface.depth/2));
  }
  return{scene,supports};
}
