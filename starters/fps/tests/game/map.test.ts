import {describe,it,expect} from '../../src/sandbox/testkit.ts';
import {applyCharacterMovement,moveCharacters,type CharacterState} from '../../src/sandbox/characters.ts';
import {preparePhysics,raycastPhysics} from '../../src/sandbox/physics.ts';
import {MAP_ASSEMBLY,groundPhysics,MAP_INSPECTION_VIEWS,spawnPoint,SITES,DEFENDER_NESTS} from '../../src/game/ground.ts';
import tuning from '../../src/game/tuning.json';

describe('Juniper II exact engine-authored architecture',()=>{
 it('uses the accepted engine geometry for movement and gunfire',()=>{
  expect(MAP_ASSEMBLY.diagnostics.valid).toBe(true);
  expect(groundPhysics).toBe(MAP_ASSEMBLY.scene);
  for(const check of ['geometry','connections','support','surfaces','readability'])
   expect(MAP_ASSEMBLY.diagnostics.coverage.find(row=>row.check===check)?.status).toBe('passed');
  expect(MAP_ASSEMBLY.diagnostics.omittedIssues).toBe(0);
  expect(MAP_ASSEMBLY.signs).toHaveLength(8);
  expect(MAP_INSPECTION_VIEWS).toHaveLength(12);
 });
 it('does not claim screenshots or traversal from compiler metadata',()=>{
  expect(MAP_ASSEMBLY.diagnostics.coverage.find(row=>row.check==='rendering')?.status).toBe('incomplete');
  expect(MAP_ASSEMBLY.diagnostics.coverage.find(row=>row.check==='traversal')?.status).toBe('incomplete');
 });
 it('keeps both shrine roofs seated directly on their compiled supports',()=>{
  for(const id of ['a-long-shrine','courtyard-shrine']){
   const cover=MAP_ASSEMBLY.parts.find(p=>p.id===id)!,cap=MAP_ASSEMBLY.parts.find(p=>p.id===id+'-stone-cap')!,roof=MAP_ASSEMBLY.parts.find(p=>p.id===id+'-roof')!;
   expect(cap.bounds.min.y).toBeCloseTo(cover.bounds.max.y,5);
   expect(roof.bounds.min.y).toBeCloseTo(cap.bounds.max.y,5);
  }
 });
 it('preserves real floor support and uphill nest collision',()=>{
  preparePhysics(groundPhysics);
  for(const point of [spawnPoint(0),spawnPoint(1),...SITES]){
   const hit=raycastPhysics({scene:groundPhysics,origin:{x:point.x,y:.4,z:point.z},direction:{x:0,y:-1,z:0},distance:1});
   expect(hit?.distance).toBeCloseTo(.4,3);
  }
  for(const nest of DEFENDER_NESTS){
   const hit=raycastPhysics({scene:groundPhysics,origin:{x:nest.x,y:nest.y+.4,z:nest.z},direction:{x:0,y:-1,z:0},distance:1});
   expect(hit?.distance).toBeCloseTo(.4,3);
  }
 });
});

/** These are actual shared-controller walks from legal spawn points. Named
 * inspection cameras elsewhere in the map do not substitute for these routes. */
function follow(index:number,points:readonly (readonly [number,number])[],jumpWindow=false){
 const start=spawnPoint(index),state:CharacterState={physicsId:31,x:start.x,y:0,z:start.z,velocityX:0,velocityY:0,velocityZ:0,grounded:1};
 preparePhysics(groundPhysics);
 for(const [x,z]of points){
  let count=0;
  while(Math.hypot(x-state.x,z-state.z)>.22&&count++<500){
   const dx=x-state.x,dz=z-state.z,length=Math.hypot(dx,dz);
   applyCharacterMovement(state,{moveX:dx/length,moveZ:dz/length},tuning.moveSpeed);
   if(jumpWindow&&state.z>-13&&state.z<-11.7&&state.grounded)state.velocityY=tuning.jumpSpeed;
   moveCharacters([state],.05,tuning,groundPhysics);
  }
  if(count>=500)throw new Error('Route blocked before '+x+','+z+' at '+state.x.toFixed(2)+','+state.y.toFixed(2)+','+state.z.toFixed(2));
 }
 return state;
}
it('walks from attacker spawn through garden and A long to A site',()=>{
 const s=follow(0,[[-9,-39],[-12,-31],[-20,-29],[-21,-22],[-23,-14],[-34,-10],[-36,16],[-35,22]]);
 expect(Math.hypot(s.x+35,s.z-22)).toBeLessThan(.23);
});
it('walks from attacker spawn through window and courtyard to B site',()=>{
 const s=follow(0,[[-9,-39],[-12,-31],[-18,-29],[-18,-24],[-8,-24],[-8,-16],[-8,-9],[-2,-7],[0,6],[0,18]],true);
 expect(Math.hypot(s.x,s.z-18)).toBeLessThan(.23);
});
it('walks from attacker spawn through C lobby and C long to C site',()=>{
 const s=follow(0,[[9,-39],[11,-31],[20,-29],[32,-27],[36,-23],[36,16],[35.5,21],[32,22]]);
 expect(Math.hypot(s.x-32,s.z-22)).toBeLessThan(.23);
});
for(const side of [-1,1])it('walks up the '+(side<0?'A':'C')+' defender nest stairs',()=>{
 const s=follow(1,[[side*12,39.5],[side*19,37],[side*23,35.2],[side*30.8,35.2],[side*35,34]]);
 expect(s.y).toBeCloseTo(2.4,2);
});

