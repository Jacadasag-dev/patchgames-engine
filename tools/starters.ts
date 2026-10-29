import {readFileSync,readdirSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
export type EngineStarterId='duel'|'arena'|'rpg'|'social'|'fps'|'voxel-survival'|'blank';
export interface EngineStarter {id:EngineStarterId;title:string;description:string;mode:'duel'|'battle-royale'|'rpg'|'just-chatting';tags:string[];hostDirectory:string;keywords:string[];blank?:boolean}
const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function listEngineStarters(options:{includeBlank?:boolean}={}):EngineStarter[]{
 const data=JSON.parse(readFileSync(resolve(packageRoot,'starters/catalog.json'),'utf8')) as {starters:EngineStarter[]};
 return data.starters.filter(s=>options.includeBlank||!s.blank).map(s=>({...s,tags:[...s.tags],keywords:[...s.keywords]}));
}
export function readEngineStarter(id:EngineStarterId):{starter:EngineStarter;files:Record<string,string>}{
 const starter=listEngineStarters({includeBlank:true}).find(s=>s.id===id);if(!starter)throw Error(`Unknown engine starter: ${id}`);
 const root=resolve(packageRoot,'starters',id),files:Record<string,string>={};
 function visit(dir:string){for(const e of readdirSync(dir,{withFileTypes:true})){const full=resolve(dir,e.name);if(e.isSymbolicLink())throw Error('Starter symlinks are not allowed');if(e.isDirectory())visit(full);else{const path=relative(root,full).replaceAll('\\','/');if(!/^(src\/game|tests\/game)\/[\w./-]+\.(ts|json)$/.test(path))continue;files[path]=readFileSync(full,'utf8');}}}
 visit(root);files['src/game/starter.json']=JSON.stringify({version:1,id:starter.id,title:starter.title},null,2)+'\n';if(!files['src/game/logic.ts']||!files['src/game/view.ts']||!files['src/game/tuning.json'])throw Error(`Incomplete starter: ${id}`);return{starter,files};
}
export function installEngineStarter(id:EngineStarterId,root:string,options:{overwrite?:boolean}={}){
 const result=readEngineStarter(id);root=resolve(root);
 for(const path of Object.keys(result.files))if(existsSync(resolve(root,path))&&!options.overwrite)throw Error(`Refusing to overwrite starter file: ${path}`);
 for(const [path,source]of Object.entries(result.files)){const target=resolve(root,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,source);}
 return result.starter;
}
