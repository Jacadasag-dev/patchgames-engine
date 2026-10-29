import {createVoxelWorld} from './world/voxelWorld.ts';
import {sample} from './generation.ts';
import type {World,Tuning} from './shapes.ts';
export const world=createVoxelWorld<Tuning,World>({seed:t=>t.worldSeed,edits:w=>w?.edits??[],field:t=>({
 bounds:{minX:-128,maxX:128,minY:-8,maxY:24,minZ:-128,maxZ:128},chunkSize:32,
 sample:(x,y,z)=>sample(x,y,z,t.worldSeed),solid:m=>m!==0&&m!==9,
})});
export const terrainWorld=world.terrainWorld;

