/** Afterglow's single editable floor plan drives meshes, physics, seating and games. */
export const LOUNGE = { halfWidth: 18, halfDepth: 14, wallHeight: 6, wallThickness: .4 } as const;
export const DRESSING_AREA = { x: 0, z: 10.5, radius: 4, mirrorZ: 13.72, mirrorWidth: 11, mirrorHeight: 4, mirrorY: 2.5 } as const;
export const SEATING = { cushionTop: .59, hipHeight: .13, upperHeight: .3, thighLength: .3485, thighDepth: .23, calfDepth: .2, kneeClearance: .025 } as const;
export interface Furniture {
  id: string; kind: 'sofa' | 'armchair' | 'table' | 'counter' | 'stool' | 'planter';
  x: number; z: number; width: number; depth: number; height: number; facing: number; color?: number;
}
export interface LoungeSeat {
  id: string; x: number; y: number; z: number; facing: number; exit: { x: number; z: number };
  tableId?: number; tableSlot?: number;
}
export const TABLES = [
  { id: 0, label: 'Truth or Dare', kind: 'truth', x: -10, z: -4 },
  { id: 1, label: 'Color Clash', kind: 'cards', x: 10, z: -4 },
  { id: 2, label: 'Truth or Dare', kind: 'truth', x: -10, z: 4 },
  { id: 3, label: 'Color Clash', kind: 'cards', x: 10, z: 4 },
] as const;
export const furniture: Furniture[] = [];
export const seats: LoungeSeat[] = [];
function seat(item: Furniture, id: string, offset = 0, tableId?: number, tableSlot?: number) {
  const sin = Math.sin(item.facing), cos = Math.cos(item.facing);
  const front = item.depth / 2 + SEATING.calfDepth / 2 + SEATING.kneeClearance - SEATING.thighLength;
  seats.push({ id, x: item.x + cos * offset + sin * front, y: SEATING.cushionTop,
    z: item.z - sin * offset + cos * front, facing: item.facing,
    // Leave sideways from game chairs: the table occupies the space in front.
    exit: tableId === undefined ? { x: item.x + cos * offset + sin * 1.45, z: item.z - sin * offset + cos * 1.45 }
      : { x: item.x + cos * 1.2, z: item.z - sin * 1.2 }, tableId, tableSlot });
}
for (const table of TABLES) {
  furniture.push({ id: `table-${table.id}`, kind: 'table', x: table.x, z: table.z, width: 2.35, depth: 2.1, height: .87, facing: 0,
    color: table.kind === 'truth' ? 0x176969 : 0x46357c });
  for (let slot = 0; slot < 4; slot++) {
    const facing = slot * Math.PI / 2, x = table.x - Math.sin(facing) * 2.12, z = table.z - Math.cos(facing) * 2.12;
    const chair: Furniture = { id: `table-${table.id}-seat-${slot}`, kind: 'armchair', x, z, facing, width: 1.1, depth: 1.05, height: 1.16,
      color: table.kind === 'truth' ? 0x307d75 : 0x695592 };
    furniture.push(chair); seat(chair, chair.id, 0, table.id, slot);
  }
}
for (const side of [-1, 1]) for (const z of [-5, 5]) {
  const couch: Furniture = { id: `sofa-${side}-${z}`, kind: 'sofa', x: side * 15.9, z, width: 5.2, depth: 1.5, height: 1.22,
    facing: -side * Math.PI / 2, color: z < 0 ? 0xbd735c : 0x426e79 };
  furniture.push(couch);
  for (let index = 0; index < 4; index++) seat(couch, `${couch.id}-${index}`, (index - 1.5) * 1.15);
}
furniture.push({ id: 'coffee-bar', kind: 'counter', x: 0, z: -11.8, width: 11.5, depth: 1.7, height: 1.15, facing: 0 });
for (const side of [-1, 1]) for (const z of [-11, 11]) furniture.push({ id: `plant-${side}-${z}`, kind: 'planter', x: side * 15.6, z,
  width: 1.3, depth: 1.3, height: .75, facing: 0 });
export const spawnPoints = Array.from({ length: 32 }, (_, index) => ({ x: (index % 4 - 1.5) * 2.2, z: 8.4 - Math.floor(index / 4) * 2.25 }));
export const seatExit = (value: LoungeSeat) => ({ ...value.exit });
