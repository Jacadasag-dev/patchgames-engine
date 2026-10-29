/** Small, editable class catalogue. The lobby uses these stable IDs. */
export const CLASSES = [
  { id: 'vanguard', name: 'Vanguard', role: 'Frontline', attack: 'Cleave', skill: 'Iron guard', color: 0xe4ad61, range: 2.8, damage: 24, cooldown: 650, speed: 0.95, guard: 0.72 },
  { id: 'ranger', name: 'Ranger', role: 'Ranged', attack: 'Arrow', skill: 'Volley', color: 0x80c99c, range: 8, damage: 22, cooldown: 600, speed: 1.05, guard: 1 },
  { id: 'mage', name: 'Mage', role: 'Area damage', attack: 'Firebolt', skill: 'Arcane nova', color: 0xa99ae9, range: 6, damage: 26, cooldown: 850, speed: 0.95, guard: 1 },
  { id: 'cleric', name: 'Cleric', role: 'Support', attack: 'Smite', skill: 'Healing light', color: 0xf0e4aa, range: 4.5, damage: 18, cooldown: 700, speed: 1, guard: 0.9 },
  { id: 'rogue', name: 'Rogue', role: 'Mobility', attack: 'Quick stab', skill: 'Shadow dash', color: 0xe58d9e, range: 2.2, damage: 20, cooldown: 360, speed: 1.22, guard: 1 },
] as const;

export function classIndex(id: string | undefined, fallback = 0): number {
  const found = CLASSES.findIndex(value => value.id === id);
  return found >= 0 ? found : Math.abs(fallback) % CLASSES.length;
}

export function classInfo(index: number) { return CLASSES[Math.max(0, Math.min(CLASSES.length - 1, Math.floor(index)))]; }
