import type { GameUiChoice, GameUiDocument, GameUiItem, GameUiNode, GameUiPanel, GameUiPreset, GameUiTheme } from '../shared/gameUi.ts';
export type { GameUiDocument, GameUiEvent, GameUiNode, GameUiPanel, GameUiPreset, GameUiTheme } from '../shared/gameUi.ts';

export const gameUiPresets: readonly { id: GameUiPreset; label: string; description: string }[] = [
  { id: 'voxel', label: 'Voxel inventory', description: 'Hotbar, expandable storage and a connected chest.' },
  { id: 'spatial-pack', label: 'Spatial pack', description: 'Equipment and a pack with items that occupy multiple cells.' },
  { id: 'mmo-bags', label: 'MMO bags', description: 'Equipment sockets, independent bags and item comparison.' },
  { id: 'survival', label: 'Survival kit', description: 'Quick slots, supplies, condition and crafting.' },
  { id: 'compact-loot', label: 'Compact loot', description: 'Fast transfers between a container and your inventory.' },
  { id: 'shop', label: 'Outpost shop', description: 'Categories, stock, currency and purchase intents.' },
  { id: 'rpg-classes', label: 'RPG classes', description: 'Choose a role and review its starting abilities.' },
  { id: 'agent-select', label: 'Agent selection', description: 'A portrait roster, team lineup and explicit lock in.' },
  { id: 'champion-draft', label: 'Champion draft', description: 'Two teams, bans and a configurable selection phase.' },
];
const text = (value: string, tone?: 'muted' | 'accent', heading = false): GameUiNode => ({ kind: 'text', text: value, tone, heading });
const stack = (...children: GameUiNode[]): GameUiNode => ({ kind: 'stack', children });
const row = (...children: GameUiNode[]): GameUiNode => ({ kind: 'row', children });
const button = (label: string, name: string, primary = false, disabled = false): GameUiNode => ({ kind: 'button', label, action: { name }, primary, disabled });
const items: GameUiItem[] = [
  { id: 'pickaxe', label: 'Pickaxe', icon: '⚒', description: 'A reliable tool for stone and ore.', rarity: 'rare' },
  { id: 'timber', label: 'Timber', icon: '▥', count: 32, description: 'A versatile building resource.' },
  { id: 'stone', label: 'Stone', icon: '◆', count: 64 }, { id: 'apple', label: 'Apple', icon: '●', count: 8, meta: 'Restores energy' },
  { id: 'torch', label: 'Torch', icon: '♜', count: 16 }, { id: 'potion', label: 'Tonic', icon: '⚗', count: 3, rarity: 'uncommon' },
  { id: 'blade', label: 'Trail blade', icon: '†', rarity: 'epic', meta: '24 damage' }, { id: 'rope', label: 'Rope', icon: '∞', count: 5 },
  { id: 'compass', label: 'Compass', icon: '✥', rarity: 'rare' },
];
const copyItems = (prefix: string, count = items.length): GameUiItem[] => items.slice(0, count).map((item, index) => ({ ...item, id: `${prefix}-${item.id}`, slot: index }));
const grid = (id: string, label: string, columns: number, rows: number, content: GameUiItem[], move = true): GameUiNode => ({ kind: 'grid', id, label, columns, rows, items: content, flow: /hotbar|quickbar|hud-quick/.test(id) ? 'scroll' : 'reflow', action: { name: 'inspect' }, ...(move ? { moveAction: { name: 'moveItem' } } : {}) });
const roster: GameUiChoice[] = [
  { id: 'warden', label: 'Warden', role: 'Defender', icon: '♜', description: 'Raise a barrier and protect nearby allies.', selected: true },
  { id: 'ember', label: 'Ember', role: 'Striker', icon: '✹', description: 'Control space with a rolling wall of flame.' },
  { id: 'mira', label: 'Mira', role: 'Support', icon: '✚', description: 'Restore health and reveal hidden paths.' },
  { id: 'echo', label: 'Echo', role: 'Scout', icon: '◈', description: 'Track movement and place a remote beacon.' },
  { id: 'rook', label: 'Rook', role: 'Controller', icon: '♟', description: 'Block sight lines and secure an approach.' },
  { id: 'vesper', label: 'Vesper', role: 'Striker', icon: '☽', description: 'Reposition quickly and strike from cover.', disabled: true, meta: 'Unavailable' },
  { id: 'atlas', label: 'Atlas', role: 'Defender', icon: '⬡', description: 'Anchor your team with a reinforced shield.' },
  { id: 'sol', label: 'Sol', role: 'Support', icon: '☀', description: 'Share energy and bolster nearby allies.' },
  { id: 'drift', label: 'Drift', role: 'Scout', icon: '➶', description: 'Traverse difficult terrain and find new angles.' },
];
const choices = (label: string, variant: 'cards' | 'portraits' | 'roster', content = roster, columns = 3): GameUiNode => ({ kind: 'choices', label, variant, items: content.map(item => ({ ...item })), columns, action: { name: 'selectCharacter' }, searchable: variant !== 'cards' });
export interface GameUiPresetOptions {
  title?: string;
  theme?: GameUiTheme;
  status?: string;
  containers?: Record<string, Partial<Pick<Extract<GameUiNode, { kind: 'grid' }>, 'label' | 'columns' | 'rows' | 'items' | 'spatial' | 'flow'>>>;
  characters?: GameUiChoice[];
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function visit(nodes: GameUiNode[], callback: (node: GameUiNode) => void): void {
  for (const node of nodes) { callback(node); if (node.kind === 'row' || node.kind === 'stack') visit(node.children, callback); if (node.kind === 'tabs') node.tabs.forEach(tab => visit(tab.children, callback)); }
}
const detailText = (id: string, value: string, tone?: 'muted' | 'accent', heading = false): GameUiNode => ({ kind: 'text', id, text: value, tone, heading });

/** Pure sample documents. Consumers map the named intents into their own checked game input. */
export function createGameUiPreset(preset: GameUiPreset, options: GameUiPresetOptions = {}): GameUiDocument {
  const descriptor = gameUiPresets.find(item => item.id === preset)!;
  const panel: GameUiPanel = { id: `preset:${preset}`, role: preset === 'shop' ? 'store' : preset.includes('select') || preset.includes('draft') || preset === 'rpg-classes' ? 'selection' : preset === 'compact-loot' ? 'loot' : 'inventory', title: descriptor.label,
    presentation: 'modal', width: 960, height: 650, onDismiss: { name: 'closeUi' }, children: [] };
  const intro = text(descriptor.description, 'muted');
  if (preset === 'voxel') panel.children = [intro, row(
    stack(grid('chest', 'Supply chest · 27 slots', 9, 3, copyItems('chest', 6)), text('Select an item, then an empty destination slot.', 'muted')),
    stack(grid('backpack', 'Backpack · expandable storage', 9, 3, copyItems('bag', 5)), grid('hotbar', 'Quick access · 1–9', 9, 1, copyItems('bar', 9))))];
  if (preset === 'spatial-pack') {
    const spatial: GameUiNode = { kind: 'grid', id: 'pack', label: 'Field pack · 8 × 6', columns: 8, rows: 6, spatial: true, action: { name: 'inspect' }, moveAction: { name: 'moveItem' }, items: [
      { id: 'rifle', label: 'Field rifle', icon: '➶', x: 0, y: 0, width: 4, height: 2, rarity: 'rare', meta: '3.2 kg' },
      { id: 'medkit', label: 'Medical kit', icon: '✚', x: 4, y: 0, width: 2, height: 2, meta: '1.1 kg' },
      { id: 'water', label: 'Water', icon: '♧', x: 6, y: 0, width: 1, height: 2, count: 2 },
      { id: 'magazine', label: 'Magazine', icon: '▤', x: 0, y: 2, width: 1, height: 2, count: 30 },
      { id: 'field-knife', label: 'Knife', icon: '†', x: 2, y: 3, width: 1, height: 2, rotated: true },
    ] };
    panel.children = [intro, row(stack(text('EXPEDITION 07', 'accent'), grid('equipment', 'Equipped', 2, 3, [
      { id: 'helmet', label: 'Helmet', icon: '⌂', meta: 'Head · 84%' }, { id: 'vest', label: 'Field vest', icon: '♜', meta: 'Body · 100%' },
      { id: 'radio', label: 'Radio', icon: '▣', meta: 'Utility' }]), text('Carry weight  18.4 / 30 kg', 'muted')), stack(spatial, text('Select an item, rotate if needed, then choose its destination.', 'muted')))];
  }
  if (preset === 'mmo-bags') panel.children = [intro, row(stack(text('Aster · Level 24', 'accent', true), grid('equipment', 'Equipment sockets', 3, 3, [
    { id: 'crown', label: 'Crown', icon: '♛', meta: 'Head · +12 armor', rarity: 'epic' }, { id: 'armor', label: 'Scale armor', icon: '♜', meta: 'Chest · +32 armor', rarity: 'rare' }, { id: 'boots', label: 'Trail boots', icon: '♟', meta: 'Feet · +4 speed' },
    { id: 'staff', label: 'Oak staff', icon: '⚒', meta: 'Main hand · +18 power' }, { id: 'ring', label: 'Moon ring', icon: '○', meta: 'Trinket · +6 focus', rarity: 'rare' }]), text('Armor 64 · Power 38 · Focus 22', 'muted')),
    { kind: 'tabs', label: 'Bags', tabs: ['Satchel', 'Herb bag', 'Vault'].map((name, index) => ({ id: `bag-${index}`, label: name, children: [grid(`bag-${index}`, `${name} · 20 slots`, 5, 4, copyItems(`mmo-${index}`, index === 1 ? 3 : 7))] })) })];
  if (preset === 'survival') panel.children = [intro, row(stack(text('NORTH RIDGE · DAY 12', 'accent'), { kind: 'bar', label: 'Condition', value: 82, max: 100, tone: 'health' }, { kind: 'bar', label: 'Hydration', value: 64, max: 100, tone: 'armor' }, { kind: 'bar', label: 'Energy', value: 71, max: 100, tone: 'energy' }, text('Carry weight  12.8 / 24 kg', 'muted'), grid('craft', 'Crafting ingredients', 2, 2, copyItems('craft', 2)), button('Craft campfire', 'craftItem', true)), stack(grid('supplies', 'Backpack', 6, 3, copyItems('supplies', 8)), grid('quickbar', 'Quick access', 6, 1, copyItems('quick', 6))))];
  if (preset === 'compact-loot') { panel.width = 780; panel.height = 530; panel.children = [text('Weathered chest · 6 items remaining', 'muted'), row(stack(grid('loot', 'Container', 4, 3, copyItems('loot', 6)), button('Take all available', 'takeAll', true)), stack(grid('player', 'Your inventory', 4, 3, copyItems('player', 4)), text('8 empty slots · 5.4 kg available', 'muted')))]; }
  if (preset === 'shop') panel.children = [row(text('WAYFARER SUPPLY', 'accent'), text('Your balance  ◈ 480', 'accent')), { kind: 'tabs', label: 'Shop categories', tabs: ['Supplies', 'Equipment', 'Special'].map((name, index) => {
    const id = `shop-${index}`, catalog = copyItems(id, 8).map((item, itemIndex) => ({ ...item, meta: `${[40, 65, 120, 30, 180, 50, 520, 80][itemIndex]} credits`, disabled: itemIndex === 6, selected: itemIndex === 5, action: { name: 'inspect', index: itemIndex, item: item.id, source: id } }));
    const selected = catalog[5];
    return { id: name.toLowerCase(), label: name, children: [row(grid(id, name, 4, 3, catalog, false), stack(
      detailText(`${id}:name`, selected.label, undefined, true), detailText(`${id}:icon`, selected.icon ?? '◇', 'accent', true),
      detailText(`${id}:description`, selected.description ?? `${selected.label} is available from the outpost supplier.`, 'muted'), detailText(`${id}:price`, `${selected.meta} · ${selected.count ?? 8} in stock`, 'accent'),
      text('Purchases are checked by your game.', 'muted'), { kind: 'button', id: `${id}:purchase`, label: `Buy 1 · ${selected.meta}`, action: { name: 'buyItem', index: 5, item: selected.id, source: id }, primary: true }, button('Unavailable · 520 credits', 'buyUnavailable', false, true))) ] };
  }) }];
  if (preset === 'rpg-classes') { panel.height = 590; panel.children = [text('Every expedition needs a different kind of hero.', 'muted'), choices('Choose your path', 'cards', [
    { ...roster[0], label: 'Guardian', role: 'Defense', description: 'Shield Wall · Rally · Steadfast. Starts with a sword and tower shield.', meta: 'Armor 9 · Power 5' },
    { ...roster[1], label: 'Arcanist', role: 'Magic', description: 'Firebolt · Blink · Arcane Well. Starts with a staff and a spellbook.', meta: 'Armor 3 · Power 10' },
    { ...roster[3], label: 'Ranger', role: 'Precision', description: 'Aimed Shot · Trail Sense · Snare. Starts with a bow and a hunting knife.', meta: 'Armor 5 · Power 8' },
  ]), row(detailText('character-summary', 'Guardian · Protect allies and hold the line.', 'accent'), button('Choose Guardian', 'confirmCharacter', true))]; }
  if (preset === 'agent-select') panel.children = [row(stack(text('YOUR SQUAD', 'accent'), detailText('character-team', 'You · Warden · Preview'), text('River · Sol · Ready', 'muted'), text('Ash · Choosing…', 'muted'), text('Kai · Choosing…', 'muted')), stack(
    detailText('character-name', 'Warden', 'accent', true), detailText('character-icon', '♜', 'accent', true), detailText('character-role', 'Defender', undefined, true),
    detailText('character-meta', 'Ready to preview', 'muted'), detailText('character-description', 'Raise a barrier and protect nearby allies.', 'muted'), detailText('character-confirmation', 'Preview · Not locked in', 'muted'), button('Lock in Warden', 'confirmCharacter', true))), choices('Available agents', 'portraits', roster.map(item => item.id === 'sol' ? { ...item, confirmed: true, disabled: true, meta: 'Teammate locked' } : item), 6)];
  if (preset === 'champion-draft') panel.children = [row(text('BLUE TEAM · YOUR PICK', 'accent'), text('Pick phase 2 · 00:28', 'muted')), row(
    stack(text('BLUE TEAM', 'accent'), text('1 · Mira · Support'), detailText('character-team', 'You · Warden · Preview'), text('3 · Awaiting pick', 'muted'), text('Bans · Rook / Vesper', 'muted')),
    choices('Champion roster', 'roster', roster.map(item => ({ ...item, disabled: item.disabled || item.id === 'rook', confirmed: item.id === 'mira' }))),
    stack(text('RED TEAM', 'accent'), text('1 · Ember · Striker'), text('2 · Atlas · Defender'), text('3 · Awaiting pick', 'muted'), text('Bans · Drift / Sol', 'muted'))), row(detailText('character-summary', 'Warden · Defender · Available', 'accent'), button('Confirm Warden', 'confirmCharacter', true))];
  if (preset === 'agent-select' || preset === 'champion-draft' || preset === 'rpg-classes') panel.children.unshift({ kind: 'text', id: 'character-preview', text: preset === 'rpg-classes' ? 'Guardian · Defense · Protect allies and hold the line.' : 'Warden · Defender · Raise a barrier and protect nearby allies.', tone: 'accent' });
  panel.title = options.title ?? panel.title;
  if (options.status) panel.children.unshift(detailText('preset-status', options.status, 'muted'));
  let initialCharacter: GameUiChoice | undefined, initialIndex = 0;
  visit(panel.children, node => {
    if (node.kind === 'grid' && options.containers?.[node.id]) Object.assign(node, clone(options.containers[node.id]));
    if (node.kind === 'choices') {
      if (options.characters) node.items = clone(options.characters);
      initialIndex = Math.max(0, node.items.findIndex(item => item.selected)); initialCharacter = node.items[initialIndex];
    }
  });
  if (panel.role === 'store') {
    const catalogs: Extract<GameUiNode, { kind: 'grid' }>[] = []; visit(panel.children, node => { if (node.kind === 'grid') catalogs.push(node); });
    for (const catalog of catalogs) {
      const index = Math.max(0, catalog.items.findIndex(item => item.selected && !item.disabled)), item = catalog.items[index]; if (!item) continue;
      const values: Record<string, string> = { [`${catalog.id}:name`]: item.label, [`${catalog.id}:icon`]: item.icon ?? '◇', [`${catalog.id}:description`]: item.description ?? `${item.label} is available from the outpost supplier.`, [`${catalog.id}:price`]: `${item.meta ?? 'Ask for price'} · ${item.count ?? 8} in stock` };
      visit(panel.children, node => {
        if (node.kind === 'text' && node.id && values[node.id] !== undefined) node.text = values[node.id];
        if (node.kind === 'button' && node.id === `${catalog.id}:purchase`) { node.label = `Buy 1 · ${item.meta ?? 'See price'}`; node.action = { name: 'buyItem', item: item.id, index: item.slot ?? index, source: catalog.id }; node.disabled = item.disabled; }
      });
    }
  }
  if (initialCharacter) {
    const selected = initialCharacter;
    const values: Record<string, string> = { 'character-name': selected.label, 'character-icon': selected.icon ?? '✦', 'character-role': selected.role ?? '', 'character-description': selected.description ?? '', 'character-meta': selected.meta ?? 'Ready to preview', 'character-preview': `${selected.label} · ${selected.role ?? ''} · ${selected.description ?? ''}`, 'character-summary': `${selected.label} · ${selected.role ?? ''}`, 'character-team': `You · ${selected.label} · ${selected.confirmed ? 'Locked in' : 'Preview'}`, 'character-confirmation': selected.confirmed ? `Locked in · ${selected.label}` : 'Preview · Not locked in' };
    visit(panel.children, node => { if (node.kind === 'text' && node.id && values[node.id] !== undefined) node.text = values[node.id]; if (node.kind === 'button' && node.action.name === 'confirmCharacter') { node.action = { name: 'confirmCharacter', item: selected.id, index: initialIndex }; node.label = `${preset === 'rpg-classes' ? 'Choose' : preset === 'agent-select' ? 'Lock in' : 'Confirm'} ${selected.label}`; node.disabled = selected.disabled || selected.confirmed; } });
  }
  return { version: 1, panels: [panel], ...(options.theme ? { theme: clone(options.theme) } : {}), defaults: { health: false, timer: false, status: false, info: false, crosshair: false }, actions: [
    { name: 'closeUi', label: 'Close panel' }, { name: 'inspect', label: 'Inspect item' }, { name: 'moveItem', label: 'Move item' },
    { name: 'takeAll', label: 'Take all' }, { name: 'craftItem', label: 'Craft item' }, { name: 'buyItem', label: 'Buy item' },
    { name: 'buyUnavailable', label: 'Unavailable item' }, { name: 'selectCharacter', label: 'Preview character' }, { name: 'confirmCharacter', label: 'Confirm character' },
  ] };
}
export const gameUiPreset = createGameUiPreset;

/** Compose a familiar HUD using the same components as inventory panels. */
export function createGameUiHud(): GameUiDocument {
  return { version: 1, actions: [{ name: 'equipItem', label: 'Equip item' }], panels: [
    { id: 'hud:health', role: 'health', children: [{ kind: 'bar', label: 'Health', value: 82, max: 100 }] },
    { id: 'hud:objective', role: 'objective', children: [text('THE LOST SIGNAL', 'accent'), text('Reach the ridge beacon', 'muted')] },
    { id: 'hud:hotbar', role: 'hotbar', width: 540, height: 115, children: [{ ...grid('hud-quick', 'Quick access', 9, 1, copyItems('hud'), false), action: { name: 'equipItem' } } as GameUiNode] },
    { id: 'hud:crosshair', role: 'crosshair', children: [{ kind: 'crosshair', shape: 'ticks', size: 22, gap: 6, thickness: 2 }] },
  ] };
}
