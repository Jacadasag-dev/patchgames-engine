import {FOLIAGE_PRESETS} from '../src/shared/foliagePresets.ts';
import type {FoliageRecipe} from '../src/shared/foliageGenerator.ts';
export const LEAF_LOD_LAB_SPECIES=[{id:'stress-oak',name:'Existing LOD woodland oak'},...FOLIAGE_PRESETS.filter(p=>['oak','evergreen','palm','willow','maple'].includes(p.id)).map(p=>({id:p.id,name:p.name}))];
export function leafLodLabRecipe(id:string):FoliageRecipe{return id==='stress-oak'?{kind:'foliage',version:1,name:'LOD woodland oak',seed:187,quality:'high',heightMeters:5.8,crownRadiusMeters:1.7,trunkRadiusMeters:.18,branchLevels:2,branches:4,branchSegments:10,branchAngle:1.1,density:35,leafSizeMeters:.45,tipDensity:.85}:structuredClone(FOLIAGE_PRESETS.find(p=>p.id===id)?.recipe??FOLIAGE_PRESETS[0].recipe);}
