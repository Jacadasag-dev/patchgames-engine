import { NodeBuilder, type NodeUniform, type UniformNode } from 'three/webgpu';

type ShaderStage = 'vertex' | 'fragment' | 'compute';
type UniformAllocator = (node: UniformNode<unknown, unknown>, type: string, shaderStage: ShaderStage, name?: string | null) => NodeUniform<unknown, unknown>;
type UniformBuilder = NodeBuilder & { getUniformFromNode: UniformAllocator };
export interface ShaderBuilderBackend {
  createNodeBuilder(...args: unknown[]): UniformBuilder;
}

/** Keep r186's generated buffer symbols local to the shader being built.
 * WGSL normally replaces the registered nodeUniformN name with the node's
 * process-wide ID. Recreating an identical instance buffer then compiles an
 * identical program again under a different name. Allocate through the native
 * declaration registry first, and supply its collision-checked name to the
 * unchanged WGSL binding generator. Author names still pass through the same
 * registry, including its normal collision handling. All resource/layout
 * decisions remain native; no shader source or pipeline keys are rewritten. */
export function stabilizeRendererBufferNames(backend: ShaderBuilderBackend): void {
  const createNodeBuilder = backend.createNodeBuilder;
  const allocate = (NodeBuilder.prototype as UniformBuilder).getUniformFromNode;
  backend.createNodeBuilder = function(...args) {
    const builder = createNodeBuilder.apply(this, args);
    const getUniformFromNode = builder.getUniformFromNode;
    builder.getUniformFromNode = function(node, type, shaderStage, name) {
      if (type === 'buffer' || type === 'storageBuffer' || type === 'indirectStorageBuffer') {
        name = allocate.call(this, node, type, shaderStage, name).name;
      }
      return getUniformFromNode.call(this, node, type, shaderStage, name);
    };
    return builder;
  };
}
