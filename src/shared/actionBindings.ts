import type { Binding } from './gameApi.ts';

export type AssignedBinding = Binding & { keys: string[]; label: string };
export type SavedBindings = Record<string, { keys: string[]; signature: string; custom?: boolean }>;
const POOL = ['j', 'k', 'l', 'u', 'i', 'o', 'p', 'h', 'n', 'm', 'b', 'v', 'c', 'x', 'z', 'q', 'e', 'r', 'f', 'g', 't', 'y', ' ', 'shift', ...'1234567890', 'a', 's', 'd', 'w', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'];
export function allowedKey(key: string): boolean {
  return key.length > 0 && key.length <= 16 && !['escape', 'esc', 'tab', 'meta', 'control', 'alt', 'unidentified', 'dead'].includes(key) && !/^f\d+$/.test(key);
}
const KEY_NAMES: Record<string, string> = { ' ': 'Space', arrowleft: 'Left arrow', arrowright: 'Right arrow', arrowup: 'Up arrow', arrowdown: 'Down arrow', shift: 'Shift' };
/** Player-facing name of a KeyboardEvent.key value, shared by the match menu and the Games browser. */
export function keyLabel(key: string): string { return KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1)); }
export function mouseLabel(button: 0 | 1 | 2): string { return ['Left click', 'Middle click', 'Right click'][button]; }
export function actionLabel(name: string): string { return name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()); }
const signature = (b: Binding) => JSON.stringify([b.kind, b.keys ?? [], b.role ?? '']);

/** Saved assignments survive action reordering and additions. Explicit preferences are
 * considered before automatic choices; an occupied key never silently fires two actions. */
export function assignBindings(bindings: Binding[], saved: SavedBindings = {}, reservedKeys: Iterable<string> = []): AssignedBinding[] {
  const used = new Set([...reservedKeys].map(key => key.toLowerCase()));
  const output = new Map<string, string[]>();
  const take = (b: Binding, keys: string[]) => {
    const slots = keys.map(key => key.toLowerCase()).map(key => {
      if (!allowedKey(key) || used.has(key)) return '';
      used.add(key); return key;
    });
    const assigned = b.kind === 'axis' ? [slots[0] ?? '', slots[1] ?? ''] : slots.filter(Boolean);
    output.set(b.name, assigned);
  };
  // User choices and still-current automatic assignments win over newly introduced keys.
  for (const b of bindings) {
    const prior = saved[b.name];
    if (prior && (prior.custom || prior.signature === signature(b))) take(b, prior.keys);
  }
  for (const b of bindings) if (!output.has(b.name) && b.keys?.length) take(b, b.keys);
  for (const b of [...bindings].sort((a, b) => a.name.localeCompare(b.name))) {
    const keys = output.get(b.name) ?? [];
    const count = b.kind === 'axis' ? 2 : 1;
    const preferred = b.role === 'move-x' ? ['a', 'd'] : b.role === 'move-y' ? ['s', 'w'] : [];
    for (let i = 0; i < count; i++) {
      if (keys[i]) continue;
      const next = [...(preferred[i] ? [preferred[i]] : []), ...POOL].find(key => !used.has(key));
      if (!next) throw new Error('No free control keys available');
      keys[i] = next; used.add(next);
    }
    output.set(b.name, keys);
  }
  return bindings.map(b => ({ ...b, label: b.label ?? actionLabel(b.name), keys: output.get(b.name)! }));
}
export function rememberBindings(bindings: AssignedBinding[], declarations: Binding[], previous: SavedBindings): SavedBindings {
  const next: SavedBindings = {};
  for (const b of bindings) next[b.name] = { keys: [...b.keys], signature: signature(declarations.find(d => d.name === b.name)!), ...(previous[b.name]?.custom ? { custom: true } : {}) };
  return next;
}
