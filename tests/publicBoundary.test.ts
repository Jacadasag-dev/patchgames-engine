import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {expect,it} from 'vitest';
import {checkPublicBoundary} from '../tools/check-public-boundary.mjs';
const base=resolve(import.meta.dirname,'..');
it('keeps the engine independent of the private integration',()=>{expect(checkPublicBoundary(base)).toEqual([]);});
it('rejects private paths, provider dependencies, imports and package entries',()=>{
 const root=mkdtempSync(join(tmpdir(),'engine-boundary-'));
 try{
  mkdirSync(join(root,'src/server'),{recursive:true});writeFileSync(join(root,'src/server/endpoint.ts'),'');
  writeFileSync(join(root,'src/core.ts'),"import x from '@modelcontextprotocol/sdk/server/mcp.js';");
  writeFileSync(join(root,'package.json'),JSON.stringify({dependencies:{openai:'1'},files:['src','private']}));
  const issues=checkPublicBoundary(root,['private/workflow.ts']);
  expect(issues.some(i=>i.message.includes('dependency'))).toBe(true);expect(issues.some(i=>i.message.includes('import'))).toBe(true);
  expect(issues.some(i=>i.message.includes('path'))).toBe(true);expect(issues.some(i=>i.message.includes('package entry'))).toBe(true);
  expect(issues.some(i=>i.message.includes('packaged'))).toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
