/** Plain editable loot data: the same IDs drive authoritative inventory and UI. */
import type { PlayerState, WorldState } from './shapes.ts';

export const ARENA_LOOT = [
  { id: 'sword', label: 'Sword', bit: 1 },
  { id: 'bow', label: 'Bow', bit: 2 },
  { id: 'arrows', label: '6 arrows', bit: 4 },
  { id: 'bandages', label: '2 bandages', bit: 8 },
  { id: 'armorFace', label: 'Face armor', bit: 16 },
  { id: 'armorChest', label: 'Chest armor', bit: 32 },
  { id: 'armorLegs', label: 'Leg armor', bit: 64 },
  { id: 'armorArms', label: 'Arm armor', bit: 128 },
] as const;

/** Per-chest random streams keep loot independent of unrelated procedural work. */
export function chestLoot(random: () => number): number {
  const weapon = random() < .55 ? 1 : 2;
  const armor = 16 << Math.min(3, Math.floor(random() * 4));
  return weapon | armor | 8 | (weapon === 2 || random() < .45 ? 4 : 0);
}

export function takeLoot(state: PlayerState, chest: WorldState['supplies'][number], choice: number): number {
  let taken = 0;
  for (let index = 0; index < ARENA_LOOT.length; index++) {
    const item = ARENA_LOOT[index];
    if ((choice !== 9 && choice !== index + 1) || !(chest.loot & item.bit)) continue;
    if (item.id === 'arrows') {
      if (state.arrows > 114) continue;
      state.arrows += 6;
    } else if (item.id === 'bandages') {
      if (state.bandages > 18) continue;
      state.bandages += 2;
    } else {
      if (state[item.id]) continue;
      state[item.id] = true;
      if (item.id === 'sword' || item.id === 'bow') {
        state.weapon = true;
        if (!state.equipped) state.equipped = item.id === 'sword' ? 1 : 2;
      }
    }
    chest.loot &= ~item.bit;
    taken |= item.bit;
  }
  return taken;
}

export function armorCount(state: PlayerState): number {
  return Number(state.armorFace) + Number(state.armorChest) + Number(state.armorLegs) + Number(state.armorArms);
}
