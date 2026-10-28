import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {engineSourceFiles,materializeEngine} from '../tools/generated/materialize-engine.mjs';

const roots:string[]=[];
const write=(root:string,path:string,text:string)=>{mkdirSync(resolve(root,path,'..'),{recursive:true});writeFileSync(resolve(root,path),text);};
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'patchgames-engine-dependency-'));roots.push(root);
 const engine=join(root,'dependency');
 write(root,'package.json',JSON.stringify({dependencies:{'@patchgames/engine':'https://example.test/engine/0123456789012345678901234567890123456789'}}));
 write(engine,'package.json',JSON.stringify({name:'@patchgames/engine',version:'0.1.1'}));
 write(engine,'src/sandbox/physics.ts','export const physicsVersion = 1;\n');
 write(engine,'src/sandbox/defaultLocomotionData.ts','export const DEFAULT_LOCOMOTION_DATA = {};\n');
 write(engine,'src/shared/gameApi.ts','export type Example = number;\n');
 return{root,engine};
}
afterEach(()=>{for(const root of roots.splice(0)){if(!root.startsWith(join(tmpdir(),'patchgames-engine-dependency-')))throw Error('Invalid test directory');rmSync(root,{recursive:true,force:true});}});
it('materializes a pinned package and supplies the same verified files to isolated jobs',()=>{
 const{root,engine}=fixture();const result=materializeEngine({root,engineRoot:engine});
 expect(result.engineVersion).toBe('0.1.1');
 expect(engineSourceFiles(root)).toEqual(Object.keys(result.files).sort());
 expect(readFileSync(join(root,'src/sandbox/physics.ts'),'utf8')).toBe(readFileSync(join(engine,'src/sandbox/physics.ts'),'utf8'));
 expect(materializeEngine({root,engineRoot:engine,check:true})).toEqual(result);
});
it('refuses to overwrite a modified generated engine implementation',()=>{
 const{root,engine}=fixture();materializeEngine({root,engineRoot:engine});
 write(root,'src/sandbox/physics.ts','local change');
 expect(()=>engineSourceFiles(root)).toThrow('Generated engine file changed');
 expect(()=>materializeEngine({root,engineRoot:engine})).toThrow('Refusing to overwrite');
 expect(readFileSync(join(root,'src/sandbox/physics.ts'),'utf8')).toBe('local change');
});
it('rejects a stale dependency pin until rematerialized',()=>{
 const{root,engine}=fixture();materializeEngine({root,engineRoot:engine});
 write(root,'package.json',JSON.stringify({dependencies:{'@patchgames/engine':'new-pin'}}));
 expect(()=>engineSourceFiles(root)).toThrow('pin is stale');
 expect(()=>materializeEngine({root,engineRoot:engine,check:true})).toThrow('stale');
 materializeEngine({root,engineRoot:engine});expect(engineSourceFiles(root)).toHaveLength(3);
});
it('keeps licensed host data separate while preserving the legacy animation entry point',()=>{
 const{root,engine}=fixture();const asset='export const UE_LOCOMOTION_DATA = {source:"licensed host asset"};\n';
 write(root,'src/engineAssets/humanoidLocomotion.ts',asset);materializeEngine({root,engineRoot:engine});
 expect(readFileSync(join(root,'src/sandbox/hostAssets.ts'),'utf8')).toBe(asset);
 expect(readFileSync(join(root,'src/sandbox/defaultLocomotionData.ts'),'utf8')).toContain('DEFAULT_LOCOMOTION_DATA');
 expect(readFileSync(join(root,'src/sandbox/ueLocomotionData.ts'),'utf8')).toContain('./hostAssets.ts');
 expect(readFileSync(join(engine,'src/sandbox/defaultLocomotionData.ts'),'utf8')).not.toContain('licensed');
});
it('rejects unexpected package source without creating platform files',()=>{
 const{root,engine}=fixture();write(engine,'src/server/private.ts','private');
 expect(()=>materializeEngine({root,engineRoot:engine})).toThrow('Unexpected engine source');
 expect(existsSync(join(root,'src/sandbox/physics.ts'))).toBe(false);
});
