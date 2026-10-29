/** The layout, renderer, projectiles and movement all use one compiled map. */
export * from './mapLayout.ts';
export {MAP_ASSEMBLY,MAP_INSPECTION_VIEWS} from './mapArchitecture.ts';
import {MAP_ASSEMBLY} from './mapArchitecture.ts';
export const groundPhysics=MAP_ASSEMBLY.scene;

