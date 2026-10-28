import { expect, it } from 'vitest';
import { compileMapAssembly, defineMapAssembly, mapFloorRegions, mapPartFace, type MapAssemblyRecipe, type MapPartRecipe } from '../../src/sandbox/mapAssembly.ts';

const box=(id:string,role:MapPartRecipe['role'],x:number,y:number,z:number):MapPartRecipe=>({id,role,shape:{kind:'box',size:{x,y,z}}});
function house():MapAssemblyRecipe{return {version:1,id:'hand-authored',parts:[
  {...box('ground','floor',20,.4,20),position:{x:0,y:-.2,z:0},support:'foundation'},
  {...box('wall','wall',6,3,4),mount:{part:'ground',face:'top',ownFace:'bottom'}},
  {id:'roof',role:'roof',shape:{kind:'gable',width:6.8,depth:4.8,rise:1.5},mount:{part:'wall',face:'top',ownFace:'bottom'}},
  {...box('sign','sign',2,.7,.08),mount:{part:'wall',face:'front',ownFace:'back',v:.5},color:'#ffffff'},
],signs:[{part:'sign',text:'A COURT',approaches:[{id:'entry',position:{x:0,y:1.8,z:9}}]}]};}

it('compiles exact mounted architecture with closed outward solids, support paths and readable signs',()=>{
  const recipe=house(),before=JSON.stringify(recipe),map=compileMapAssembly(recipe);
  expect(map.diagnostics.issues).toEqual([]);expect(map.diagnostics.valid).toBe(true);
  expect(map.diagnostics.coverage.filter(c=>!['rendering','traversal'].includes(c.check)).every(c=>['passed','notApplicable'].includes(c.status))).toBe(true);
  expect(mapPartFace(map,'roof','bottom')!.center.y).toBe(3);
  expect(mapPartFace(map,'wall','top')!.center.y).toBe(3);
  expect(map.scene.staticMap?.revision).toBe(map.revision);
  expect(map.scene.colliders.find(c=>c.id==='roof')!.shape).toEqual({kind:'convex',vertices:map.parts.find(p=>p.id==='roof')!.vertices});
  expect(Object.isFrozen(map.parts)).toBe(true);expect(JSON.stringify(recipe)).toBe(before);
  // Independent convex-solid oracle: every vertex must lie on/inside every outward face.
  for(const part of map.parts)for(const face of part.faces)for(const p of part.vertices){const q=face.vertices[0];expect((p.x-q.x)*face.normal.x+(p.y-q.y)*face.normal.y+(p.z-q.z)*face.normal.z).toBeLessThanOrEqual(1e-6);}
});

it('retains contact after rotating and moving the foundation, including signs',()=>{
  const recipe=house();recipe.parts[0].position={x:18,y:2,z:-12};recipe.parts[0].yaw=Math.PI/2;recipe.signs=[];
  const map=compileMapAssembly(recipe);expect(map.diagnostics.issues).toEqual([]);
  const wall=mapPartFace(map,'wall','top')!,roof=mapPartFace(map,'roof','bottom')!;
  expect(roof.center).toEqual(wall.center);expect(map.parts.find(p=>p.id==='sign')!.position.x).toBeGreaterThan(20);
});

it('detects floating roofs even when object names claim support, and invalidates after a parent edit',()=>{
  const recipe=house();const original=compileMapAssembly(recipe);const roof=recipe.parts[2];delete roof.mount;roof.position={x:0,y:3.4,z:0};
  recipe.connections=[{id:'bearing',kind:'bearing',a:{part:'roof',face:'bottom'},b:{part:'wall',face:'top'},minCoverage:.5}];
  const changed=compileMapAssembly(recipe);expect(changed.revision).not.toBe(original.revision);
  expect(changed.diagnostics.issues.some(i=>i.code==='contact-gap'&&i.measured!>.39)).toBe(true);
  expect(changed.diagnostics.issues.some(i=>i.code==='unsupported-part'&&i.ids.includes('roof'))).toBe(true);
  expect(()=>defineMapAssembly(recipe.id,()=>recipe)).toThrow('failed');
});

it('validates a real suspension chain and rejects an unsupported ceiling fixture',()=>{
  const recipe=house();recipe.parts.push({...box('chain','fixture',.05,.7,.05),mount:{part:'roof',face:'bottom',ownFace:'top',u:3.2}},
    {...box('lantern','fixture',.3,.4,.3),mount:{part:'chain',face:'bottom',ownFace:'top'}});
  expect(compileMapAssembly(recipe).diagnostics.issues).toEqual([]);
  delete recipe.parts.at(-1)!.mount;recipe.parts.at(-1)!.position={x:3.2,y:1.7,z:0};
  expect(compileMapAssembly(recipe).diagnostics.issues.some(i=>i.code==='unsupported-part'&&i.ids[0]==='lantern')).toBe(true);
});

it('rejects placement cycles and guessed coordinates alongside semantic mounts',()=>{
  const recipe=house();recipe.parts[1].position={x:0,y:1.5,z:0};expect(compileMapAssembly(recipe).diagnostics.issues.some(i=>i.message.includes('guessed'))).toBe(true);
  delete recipe.parts[1].position;recipe.parts[1].mount!.part='roof';
  expect(compileMapAssembly(recipe).diagnostics.issues.some(i=>i.message.includes('cycle'))).toBe(true);
});

it('detects both exactly coplanar and subtly offset duplicate floors, but allows storeys',()=>{
  for(const offset of [0,.002]){const recipe=house();recipe.parts.push({...box('duplicate','floor',3,.4,3),position:{x:5,y:-.2+offset,z:4},support:'foundation'});expect(compileMapAssembly(recipe).diagnostics.issues.some(i=>i.code==='surface-overlap')).toBe(true);}
  const recipe=house();recipe.parts.push({...box('upstairs','floor',3,.2,3),position:{x:7,y:4,z:7},support:'foundation'});
  expect(compileMapAssembly(recipe).diagnostics.issues).toEqual([]);
});

it('partitions material ownership exactly without guessed vertical offsets or duplicate collision',()=>{
  const floors=mapFloorRegions({id:'court',regions:[{id:'stone',x0:-5,x1:5,z0:-5,z1:5,priority:0,color:'#aaaaaa'},{id:'wood',x0:-1,x1:6,z0:-2,z1:2,priority:1,color:'#553322'}]});
  const map=compileMapAssembly({version:1,id:'floor-test',parts:floors});expect(map.diagnostics.issues).toEqual([]);
  const area=floors.reduce((sum,p)=>sum+(p.shape.kind==='box'?p.shape.size.x*p.shape.size.z:0),0);expect(area).toBe(104);
  expect(floors.every(p=>Math.abs(p.position!.y+(p.shape.kind==='box'?p.shape.size.y/2:0))<1e-7)).toBe(true);
  expect(()=>mapFloorRegions({id:'ambiguous',regions:[{id:'a',x0:0,x1:2,z0:0,z1:2,priority:0},{id:'b',x0:1,x1:3,z0:0,z1:2,priority:0}]})).toThrow('priorities');
});

it('reports the actual static occluder and changes the evidence revision when cover moves',()=>{
  const recipe=house(),first=compileMapAssembly(recipe);recipe.parts.push({...box('blocking-crate','cover',3,2,1),mount:{part:'ground',face:'top',ownFace:'bottom',v:-4}});
  const blocked=compileMapAssembly(recipe);expect(blocked.revision).not.toBe(first.revision);
  expect(blocked.diagnostics.issues.some(i=>i.code==='sign-occluded'&&i.ids.includes('blocking-crate'))).toBe(true);
  recipe.parts.at(-1)!.mount!.u=5;expect(compileMapAssembly(recipe).diagnostics.issues).toEqual([]);
});

it('never promotes missing custom geometry, absent approaches or budget overflow into passing coverage',()=>{
  const recipe=house();recipe.external=[{id:'custom-arch',reason:'External render mesh has no contact adapter.'}];recipe.signs![0].approaches=[];
  const map=compileMapAssembly(recipe);expect(map.diagnostics.coverage.find(c=>c.check==='geometry')!.status).toBe('incomplete');expect(map.diagnostics.coverage.find(c=>c.check==='readability')!.status).toBe('incomplete');
  expect(()=>defineMapAssembly(recipe.id,()=>recipe)).toThrow('failed');
  const many:MapAssemblyRecipe={version:1,id:'many',parts:Array.from({length:150},(_,i)=>({...box('floating-'+i,'roof',1,1,1),position:{x:i*2,y:5,z:0}}))};
  const result=compileMapAssembly(many);expect(result.diagnostics.issueCount).toBeGreaterThan(result.diagnostics.issues.length);expect(result.diagnostics.omittedIssues).toBeGreaterThan(0);expect(result.diagnostics.valid).toBe(false);
});

it('checks bearing regions against actual geometry instead of accepting forged contact metadata',()=>{
  const recipe=house();recipe.connections=[{id:'forged',kind:'bearing',a:{part:'roof',face:'bottom',region:{minU:-20,maxU:20,minV:-20,maxV:20}},b:{part:'wall',face:'top'}}];
  expect(compileMapAssembly(recipe).diagnostics.issues.some(i=>i.code==='contact-definition'&&i.message.includes('beyond'))).toBe(true);
});

it('rejects disabling roof bearing zones and preserves valid maximum-length authored IDs',()=>{
  const recipe=house();recipe.parts[2].bearingRegions=[];
  expect(compileMapAssembly(recipe).diagnostics.issues.some(i=>i.code==='bearing-regions')).toBe(true);
  const id='a'.repeat(96),floors=mapFloorRegions({id,regions:[{id:'one',x0:-2,x1:2,z0:-2,z1:2,priority:0}]});
  floors.push({...box(id,'wall',1,2,1),mount:{part:floors[0].id,face:'top',ownFace:'bottom'}});
  expect(compileMapAssembly({version:1,id:'long-ids',parts:floors}).diagnostics.issues).toEqual([]);
});

it.each(['flat','gable'])('rejects a %s roof perched on a tiny single post despite valid face contact',kind=>{
  const recipe:MapAssemblyRecipe={version:1,id:'under-supported',parts:[
    {...box('floor','floor',10,.4,10),position:{x:0,y:-.2,z:0},support:'foundation'},
    {...box('post','post',.2,3,.2),mount:{part:'floor',face:'top',ownFace:'bottom'}},
    {...box('roof','roof',6,.2,5),...(kind==='gable'?{shape:{kind:'gable' as const,width:6,depth:5,rise:1}}:{}),mount:{part:'post',face:'top',ownFace:'bottom'}},
  ]};
  const result=compileMapAssembly(recipe);expect(result.connections.every(c=>c.coverage===1)).toBe(true);
  expect(result.diagnostics.issues.filter(i=>i.code==='bearing-coverage')).toHaveLength(2);
});
