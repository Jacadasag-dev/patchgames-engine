import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const contentRoots=['src','docs','examples','tools','third-party','starters'];
const forbiddenPath=/(?:^|\/)(?:ops|server|mcp|agents?|connectors?|integrations?)(?:\/|$)|(?:^|\/)(?:agentMcp|agentOAuth|agentConnection|builderTools|sourceContext|authoringGuides|changeReview|inspectionCases)\.[cm]?[jt]sx?$/i;
const provider=/^(?:@modelcontextprotocol\/|@anthropic-ai\/|@aws-sdk\/client-bedrock|openai(?:\/|$)|@google\/genai(?:\/|$))/;
const privateImport=/(?:from\s*|import\s*\(|require\s*\()\s*['"](?:[^'"]*\/(?:ops|server|mcp|agents|connectors)\/|@modelcontextprotocol\/|@anthropic-ai\/|@aws-sdk\/client-bedrock|openai(?:\/|['"])|@google\/genai)/;
export function checkPublicBoundary(root,packagePaths){
 const issues=[];const add=(path,message)=>issues.push({path,message});
 const repositoryRoots=new Set([...contentRoots,'tests','.github','.git','node_modules','.npm-cache','coverage']);
 for(const entry of readdirSync(root,{withFileTypes:true})){if(entry.isDirectory()&&!repositoryRoots.has(entry.name))add(entry.name,'Unexpected repository source directory');if(entry.isFile()&&/\.[cm]?[jt]sx?$/.test(entry.name)&&entry.name!=='vitest.config.ts')add(entry.name,'Unexpected root source file');}
 const pkg=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));
 for(const section of ['dependencies','devDependencies','peerDependencies','optionalDependencies'])for(const name of Object.keys(pkg[section]??{}))if(provider.test(name))add('package.json',`Private integration dependency: ${name}`);
 const allowedFiles=new Set(['LICENSE','THIRD_PARTY_NOTICES.md','README.md','package.json']);
 for(const entry of pkg.files??[])if(!contentRoots.includes(entry)&&!allowedFiles.has(entry)&&entry!=='third-party')add('package.json',`Unexpected package entry: ${entry}`);
 function visit(dir){for(const item of readdirSync(resolve(root,dir),{withFileTypes:true})){const path=dir+'/'+item.name;if(item.isSymbolicLink()){add(path,'Source tree symlink is not allowed');continue;}if(forbiddenPath.test(path))add(path,'Private integration path in public source');if(item.isDirectory())visit(path);else if(/\.[cm]?[jt]sx?$/.test(path)&&['src','tools','examples','starters'].some(prefix=>dir===prefix||dir.startsWith(prefix+'/'))&&privateImport.test(readFileSync(resolve(root,path),'utf8')))add(path,'Private platform or model-provider import');}}
 for(const dir of contentRoots)if(existsSync(resolve(root,dir)))visit(dir);
 for(const path of packagePaths??[])if(forbiddenPath.test(path)||!(allowedFiles.has(path)||contentRoots.some(dir=>path.startsWith(dir+'/'))||path.startsWith('third-party/')))add(path,'Unexpected packaged file');
 return issues;
}
export function assertPublicBoundary(root,packagePaths){const issues=checkPublicBoundary(root,packagePaths);if(issues.length)throw new Error(issues.map(i=>`${i.path}: ${i.message}`).join('\n'));}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=resolve(fileURLToPath(new URL('../',import.meta.url)));let paths;
 if(process.argv.includes('--pack')){const npm=process.env.npm_execpath;if(!npm)throw new Error('Run package checks through npm run check:package');const result=JSON.parse(execFileSync(process.execPath,[npm,'pack','--dry-run','--json','--ignore-scripts'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}));paths=result[0].files.map(file=>file.path);}
 assertPublicBoundary(root,paths);console.log(`Public boundary verified${paths?` (${paths.length} package files)`:''}.`);
}
