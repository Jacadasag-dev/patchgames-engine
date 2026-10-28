/**
 * three.js nodes for a rig (src/sandbox/rig.ts), view only. Every joint and
 * socket is a node in the scene graph, so anything attached to a socket follows
 * every pose, knockdown and animation by construction: attach items, never
 * position them by hand. Nodes are set from the same math as solveRig, so what
 * players see matches what game logic computes.
 */
import { Group, type Object3D } from 'three';
import { jointLocalTransform, validatePose, type Rig, type RigPose, type RigTransform } from './rig.ts';

function setMatrix(node: Object3D, t: RigTransform): void {
  node.matrixAutoUpdate = false;
  node.matrix.set(
    t.xAxis.x, t.yAxis.x, t.zAxis.x, t.position.x,
    t.xAxis.y, t.yAxis.y, t.zAxis.y, t.position.y,
    t.xAxis.z, t.yAxis.z, t.zAxis.z, t.position.z,
    0, 0, 0, 1,
  );
  node.matrixWorldNeedsUpdate = true;
}

export class RigView {
  readonly rig: Rig;
  /** Add this to the character's model; it is the rig's origin (the feet). */
  readonly root = new Group();
  private readonly joints = new Map<string, Group>();
  private readonly sockets = new Map<string, Group>();

  constructor(rig: Rig) {
    this.rig = rig;
    this.root.name = 'rig';
    for (const joint of rig.joints) {
      const node = new Group();
      node.name = `joint:${joint.name}`;
      (joint.parent === null ? this.root : this.joints.get(joint.parent)!).add(node);
      this.joints.set(joint.name, node);
    }
    for (const socket of rig.sockets) {
      const node = new Group();
      node.name = `socket:${socket.name}`;
      setMatrix(node, socket.transform);
      this.joints.get(socket.joint)!.add(node);
      this.sockets.set(socket.name, node);
    }
    this.apply({});
  }

  /** A joint's node: attach body parts here (they turn with the joint). */
  joint(name: string): Group {
    return this.joints.get(name) ?? (() => { throw new Error(`Rig: unknown joint "${name}"`); })();
  }

  /** A socket's node: attach held and worn items here. */
  socket(name: string): Group {
    return this.sockets.get(name) ?? (() => { throw new Error(`Rig: unknown socket "${name}"`); })();
  }

  /**
   * Attaches an item to a socket and returns it; position it relative to that point.
   * A name that is only a joint attaches to the joint. For body parts on a joint that
   * shares a socket's name (head, hips), use `joint(name).add(mesh)`.
   */
  attach<T extends Object3D>(name: string, object: T): T {
    (this.sockets.get(name) ?? this.joints.get(name) ?? (() => { throw new Error(`Rig: unknown socket or joint "${name}"`); })()).add(object);
    return object;
  }

  /** Sets every joint for a pose (joints the pose doesn't list go back to rest). */
  apply(pose: RigPose): void {
    validatePose(this.rig, pose);
    for (const joint of this.rig.joints) setMatrix(this.joints.get(joint.name)!, jointLocalTransform(this.rig, joint.name, pose));
    // three.js only refreshes a node's world matrix when its own flag is set, so a socket under a
    // joint that just turned must be flagged too, or reading its position (updateWorldMatrix) is stale.
    for (const socket of this.sockets.values()) socket.matrixWorldNeedsUpdate = true;
  }
}
