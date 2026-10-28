/** Fixed schema-object paths only; maps, arrays and arbitrary property traversal are excluded. */
export function statePathTarget(state: unknown, path: string): {object:Record<string,unknown>;key:string} | undefined {
  const parts=path.split('.'),key=parts.pop()!;
  if(![...parts,key].every(part=>/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(part)&&!['__proto__','constructor','prototype'].includes(part)))return;
  let object=state;
  for(const part of parts){if(!object||typeof object!=='object'||Array.isArray(object))return;object=(object as Record<string,unknown>)[part];}
  if(!object||typeof object!=='object'||Array.isArray(object))return;
  return {object:object as Record<string,unknown>,key};
}
export function statePathValue(state:unknown,path:string):unknown {const target=statePathTarget(state,path);return target?.object[target.key];}
/** Copy the ancestors before updating a render/prediction snapshot; never mutate decoded authority. */
export function setStatePath(state:Record<string,unknown>,path:string,value:unknown):void {
  if(!statePathTarget(state,path))return;
  const parts=path.split('.'),key=parts.pop()!;
  let target=state;
  for(const part of parts){target[part]={...target[part] as Record<string,unknown>};target=target[part] as Record<string,unknown>;}
  target[key]=value;
}
