/** Operator-approved, preinstalled dependencies. Player patches cannot edit this list or the lockfile. */
export const GAME_LIBRARIES = [
  { name: 'cannon-es', logic: true, subpaths: false, purpose: '3D gameplay physics; use world.step(dt), never wall-clock fixedStep()' },
  { name: 'simplex-noise', logic: true, subpaths: false, purpose: 'procedural noise; initialize during match setup with context.random' },
  { name: '@tweenjs/tween.js', logic: true, subpaths: false, purpose: 'animation/interpolation; pass explicit simulation timestamps to start() and update()' },
  { name: 'three', logic: false, subpaths: true, purpose: 'rendering, lighting and worker-compatible addons; no DOM or asset loading' },
  { name: 'three-mesh-bvh', logic: false, subpaths: false, purpose: 'rendering-side mesh queries; no extra worker or asset loading' },
  { name: 'zod', logic: false, subpaths: false, purpose: 'bounded shared material/sound recipe validation in view helpers' },
  { name: '@dimforge/rapier3d-compat', logic: false, subpaths: false, purpose: 'visual physics only; initialized by the view runtime before createView; never gameplay damage or outcomes' },
] as const;

export const RAPIER_PACKAGE = '@dimforge/rapier3d-compat';

export function allowedGameImport(name: string, view: boolean): boolean {
  return GAME_LIBRARIES.some(library => (view || library.logic)
    && (name === library.name || (library.subpaths && name.startsWith(`${library.name}/`)
      && name.split('/').every(part => part && part !== '.' && part !== '..'))));
}

export const GAME_LIBRARY_GUIDE = GAME_LIBRARIES.map(library =>
  `- ${library.name} (${library.logic ? 'logic, tests and view' : 'view only'}): ${library.purpose}.`).join('\n');
