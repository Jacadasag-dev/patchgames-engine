import {Group, Object3D, Scene} from 'three';
import type {CreateView, TuningValues} from '../shared/gameApi.ts';
import {registerSoundViewCamera} from './audioListener.ts';

/**
 * Frozen PatchGames seasons predate the explicit feature host. Their DuelView
 * exposes the same match-only actors group at runtime (TypeScript private
 * fields are ordinary properties). Adapt that established scene graph without
 * rewriting immutable season source or changing its renderer, camera or frame.
 * Other view implementations must supply their own explicit featureHost.
 */
export function withFeatureViewHost<W, P, T extends TuningValues>(createView: CreateView<W, P, T>): CreateView<W, P, T> {
  return canvas => {
    const view = createView(canvas);
    registerSoundViewCamera(view);
    if (view.featureHost) return view;
    const legacy = view as typeof view & {actors?: unknown; scene?: unknown};
    const {actors, scene} = legacy;
    if (!(actors instanceof Group) || !(scene instanceof Scene) || actors.parent !== scene) return view;
    Object.defineProperty(view, 'featureHost', {value: {
      add(object: unknown) {
        if (!(object instanceof Object3D)) throw new Error('Feature visuals must be Three.js objects.');
        actors.add(object);
      },
      remove(object: unknown) {if (object instanceof Object3D) actors.remove(object);},
    }, configurable: true});
    return view;
  };
}
