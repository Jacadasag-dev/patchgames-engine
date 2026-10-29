import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=path=>JSON.parse(readFileSync(resolve(root,path),'utf8'));
const pkg=read('package.json'),lock=read('package-lock.json');
const packages=Object.entries(lock.packages).filter(([path])=>path).map(([path,value])=>({
 name:path.slice(path.lastIndexOf('node_modules/')+13),version:value.version,license:value.license??'UNSPECIFIED',
 direct:Object.hasOwn(pkg.dependencies??{},path.replace(/^node_modules\//,'')),developmentOnly:!!value.dev,optional:!!value.optional,
})).sort((a,b)=>a.name.localeCompare(b.name));
const report={scope:'Package-lock declarations, including optional platform packages and development tools. Bundled subcomponents may have additional notices in their parent package LICENSE files.',packages};
writeFileSync(resolve(root,'docs/dependency-licenses.json'),JSON.stringify(report,null,2)+'\n');
console.log(`Recorded ${packages.length} locked package declarations.`);
