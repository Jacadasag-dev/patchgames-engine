import type {GameSceneSnapshot} from '../../shared/gameScenes.ts';

/** Identity, not elapsed progress: all scene-owned browser state resets once per transition. */
export function sceneEpoch(scene:Pick<GameSceneSnapshot,'id'|'sequence'>|undefined):string{
  return scene?`${scene.id}:${scene.sequence}`:'';
}

/** Advance at most one short patch gap for smooth camera tracks. Only the server
 * changes scene identity, readiness, choices or gameplay time. Hidden tabs seek
 * the newest synchronized progress instead of replaying missed transitions. */
export function presentGameScene(scene:GameSceneSnapshot,patchAgeMs:number):GameSceneSnapshot{
  const age=Number.isFinite(patchAgeMs)?Math.max(0,Math.min(250,patchAgeMs)):0;
  const duration=scene.definition.durationMs;
  return {...scene,elapsedMs:Math.min(scene.elapsedMs+age,duration??Infinity)};
}
