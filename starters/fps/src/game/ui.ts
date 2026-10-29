import type { GameUiDocument, GameUiNode, GameUiPanel, GameUiTheme } from '../shared/gameUi.ts';
import type { ViewFrame } from '../shared/gameApi.ts';
import { createGameUiPreset } from '../sandbox/gameUi.ts';
import type { PlayerState, WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
import { ARMOR_LIGHT, BUY_MS, GUNS, OPERATORS, ROUND_MS, radarContacts } from './catalog.ts';
import { GROUND, MAP_CALLOUTS, MAP_NAME, MAP_ROOMS, SITES, WALLS } from './ground.ts';

type Frame = ViewFrame<WorldState, PlayerState, GameTuning>;
const text = (value: string, className = '', tone?: 'muted' | 'accent' | 'danger' | 'success'): GameUiNode => ({ kind: 'text', text: value, className: className || undefined, tone });
const stack = (...children: GameUiNode[]): GameUiNode => ({ kind: 'stack', children });
const percentage = (value: number) => Math.max(0, Math.min(100, (value + GROUND.halfExtent) / (GROUND.halfExtent * 2) * 100));
const bucket = (value: number) => Math.round(percentage(value));
const decimal = (value: number) => Math.round(value * 1000) / 1000;
const footprint = (x: number, z: number, width: number, depth: number) => `left:${decimal(percentage(x))}%;top:${decimal(percentage(z))}%;width:${decimal(width / (GROUND.halfExtent * 2) * 100)}%;height:${decimal(depth / (GROUND.halfExtent * 2) * 100)}%`;
const covers = WALLS.filter(wall => wall.kind !== 'building' && wall.kind !== 'ceiling');
const mapGeometry: GameUiNode[] = [
  ...MAP_ROOMS.map((_, index) => text('', `map-room room-${index}`)),
  ...covers.map((_, index) => text('', `map-cover cover-${index}`)),
  ...SITES.map((site, index) => text(site.label, `map-site site-${index}`)),
];

/** Geometry and percent buckets never change with the frame. Moving contacts
 * change only panel data/classes, preserving the other HUD panels and skins. */
export const FPS_UI_THEME: GameUiTheme = { id: 'kestrel-field', tokens: {
  '--ui-accent': '#89dbc8', '--ui-bg': '#10242ce8', '--ui-surface': '#19333e', '--ui-border': '#5d7b7870',
  '--ui-text': '#eff5ee', '--ui-muted': '#b2c5bd', '--ui-radius': '6px',
}, css: `
.ui-hud .ui-content{padding:8px 10px}.ui-hud .ui-text{font-size:11px;line-height:1.3;margin:0}.ui-hud .ui-stack{gap:4px}.ui-hud .hud-name{font-size:13px;font-weight:700;letter-spacing:.03em}.ui-hud .hud-ammo{font-size:20px;line-height:1.1;font-weight:700}.ui-hud .hud-small{font-size:10px;line-height:1.25}.ui-hud .hud-score{font-size:15px;font-weight:700;white-space:nowrap}.ui-hud .hud-feed{font-size:10px;overflow-wrap:anywhere}.ui-role-health .ui-bar{height:20px;min-height:20px}.ui-role-health .ui-bar-label{font-size:10px}.ui-role-objective .ui-bar{height:16px;min-height:16px}.ui-role-objective .ui-bar-label{font-size:9px}.ui-role-crosshair .ui-content{padding:0}.ui-role-minimap .ui-content{padding:7px;overflow:hidden}.map-board{display:block;position:relative;width:100%;aspect-ratio:1;overflow:hidden;background:#07161c;border:1px solid #67858366;border-radius:3px;flex:none}.map-board .ui-text{position:absolute;margin:0;line-height:1;pointer-events:none}.map-room{background:#9da98d77}.map-cover{background:#25444c;border:1px solid #46636b}.map-site{width:15px;height:15px;background:#a7852e99;color:#fff1bb;border:1px solid #f1d088;font-size:10px!important;font-weight:700;display:grid;place-items:center;transform:translate(-50%,-50%);border-radius:2px}.map-contact{width:5px;height:5px;border-radius:50%;transform:translate(-50%,-50%);background:#7be5cf;box-shadow:0 0 0 1px #0b252d}.map-hostile{background:#ff9c84}.map-self{color:#f6fff8;font-size:11px!important;line-height:1!important;transform:translate(-50%,-50%);font-weight:700}.map-callout{font-size:9px!important;color:#c9d7cb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-top:4px}.ui-modal .ui-choice{min-height:100px;gap:4px;padding:10px 6px}.ui-modal .ui-choice-icon{font-size:22px}.ui-modal .ui-choice-label{font-size:12px}.ui-modal .ui-choice-detail{min-height:24px;margin:10px 0 0}.ui-modal .shop-balance{font-size:18px;color:#efd79a;font-weight:700}.ui-modal .shop-note{font-size:12px;color:var(--ui-muted)}
${MAP_ROOMS.map((room, index) => `.room-${index}{${footprint(room.x0, room.z0, room.x1 - room.x0, room.z1 - room.z0)}}`).join('')}
${covers.map((wall, index) => `.cover-${index}{${footprint(wall.x - wall.w / 2, wall.z - wall.d / 2, wall.w, wall.d)}}`).join('')}
${SITES.map((site, index) => `.site-${index}{left:${decimal(percentage(site.x))}%;top:${decimal(percentage(site.z))}%}`).join('')}
${Array.from({ length: 101 }, (_, index) => `.map-x-${index}{left:${index}%}.map-z-${index}{top:${index}%}`).join('')}
${Array.from({ length: 16 }, (_, index) => `.map-heading-${index}{transform:translate(-50%,-50%) rotate(${180 - index * 22.5}deg)}`).join('')}
` };

const weaponName = (index: number) => (GUNS[index] ?? GUNS[0]).name.split(' / ')[0];
const clock = (milliseconds: number) => { const seconds = Math.max(0, Math.ceil(milliseconds / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };

/** All screen UI is host-created HTML/CSS. Health reads the engine's player
 * values; purchases remain intents mapped to the game's checked numeric input. */
export function createFpsUi(frame: Frame): GameUiDocument | null {
  const player = frame.players.find(candidate => candidate.isLocal && candidate.active !== false), world = frame.world;
  if (!player || frame.phase === 'menu') return null;
  if (frame.phase === 'waiting') {
    const selected = OPERATORS.find(operator => operator.id === player.classId) ?? OPERATORS[0];
    const document = createGameUiPreset('agent-select', { title: 'KESTREL PROTOCOL · Choose your operator', theme: FPS_UI_THEME,
      status: 'Waiting for players · You can change your selection until the match starts.',
      characters: OPERATORS.map(operator => ({ id: operator.id, label: operator.name, role: operator.role,
        description: operator.description, icon: operator.name[0], meta: `${operator.a} · ${operator.b}`, selected: operator.id === selected.id,
        action: { name: 'host:chooseClass', item: operator.id } })),
    });
    const panel = document.panels[0]; delete panel.onDismiss;
    const detail = panel.children.find(node => node.kind === 'row');
    if (detail?.kind === 'row') detail.children[0] = stack(text('LOBBY OPERATORS', '', 'accent'),
      ...frame.players.filter(candidate => candidate.active !== false).map(candidate => text(`${candidate.isLocal ? 'You' : candidate.name} · ${OPERATORS.find(operator => operator.id === candidate.classId)?.name ?? 'Choosing'}`, '', 'muted')));
    const customize = (values: GameUiNode[]): void => { for (const node of values) {
      if (node.kind === 'row' || node.kind === 'stack') customize(node.children);
      if (node.kind === 'choices') node.action = { name: 'host:chooseClass' };
      if (node.kind === 'text' && node.id === 'character-confirmation') node.text = `Selected · ${selected.name} · Change while waiting`;
      if (node.kind === 'button' && node.action.name === 'confirmCharacter') { node.id = 'confirm-operator'; node.label = `Selected: ${selected.name}`; node.action = { name: 'host:chooseClass', item: selected.id }; node.disabled = false; }
    } };
    customize(panel.children);
    document.actions = [{ name: 'host:chooseClass', label: 'Select operator' }];
    return document;
  }
  if (!world) return null;
  const state = player.state, operator = OPERATORS[state.operator] ?? OPERATORS[0];
  const buy = world.elapsedMs < BUY_MS && world.round.phase === 0;
  const alive = player.hp > 0, spectating = !!frame.spectator, attacking = player.team === world.round.attackingTeam;
  const showRequisitions = buy && alive && !spectating && frame.phase === 'fighting' && !state.shop;
  const time = buy ? `BUY ${clock(BUY_MS - world.elapsedMs)}` : world.bomb.state === 1 ? clock(world.bomb.timer) : clock(ROUND_MS - world.elapsedMs);
  const roundTitle = world.round.phase > 0 ? `${world.round.phase === 2 ? 'MATCH' : 'ROUND'} ${world.round.winner === player.team ? 'WON' : 'LOST'}` : '';
  const mission = world.bomb.state === 1 ? 'DEVICE ARMED' : attacking ? 'ATK · PLANT AT A / B / C' : 'DEF · PROTECT A / B / C';
  const objective: GameUiNode[] = [text(`${world.round.scoreA} : ${world.round.scoreB}  ·  R${world.round.number}  ·  ${time}`, 'hud-score'),
    text(roundTitle || mission, '', world.round.phase > 0 ? world.round.winner === player.team ? 'success' : 'danger' : 'accent')];
  if (state.channel > 0) objective.push({ kind: 'bar', label: world.bomb.state === 1 ? 'Defusing' : 'Arming device', value: Math.max(0, Math.min(1, world.bomb.progress)), max: 1, tone: 'energy' });
  else objective.push(text(spectating ? world.bomb.carrier === frame.players.indexOf(player) ? `${player.name} carries the device` : MAP_NAME
    : !alive ? 'Eliminated · watching your team' : world.reason && world.reason !== mission ? world.reason
    : buy ? 'Requisitions available' : world.bomb.carrier === frame.players.indexOf(player) ? 'You carry the device' : MAP_NAME, 'hud-small', 'muted'));
  const cooldown = (label: string, remaining: number) => `${label} · ${remaining > 0 ? `${Math.ceil(remaining / 1000)}s` : 'READY'}`;
  const feed = world.kills.slice(-2).reverse().map(kill => text(`${(frame.players[kill.owner]?.name ?? 'Player').slice(0, 14)} ${kill.head ? 'HS' : '›'} ${(frame.players[kill.target]?.name ?? 'Player').slice(0, 14)}`, 'hud-feed', kill.owner === frame.players.indexOf(player) ? 'success' : 'muted'));
  const nearest = MAP_CALLOUTS.reduce((best, callout) => Math.hypot(callout.x - state.x, callout.z - state.z) < Math.hypot(best.x - state.x, best.z - state.z) ? callout : best, MAP_CALLOUTS[0]);
  const contacts = radarContacts(frame.players, world.effects, player.team).map(contact => text('', `map-contact ${contact.friendly ? 'map-friendly' : 'map-hostile'} map-x-${bucket(contact.x)} map-z-${bucket(contact.z)}`));
  const heading = (Math.round(state.facing / (Math.PI * 2) * 16) % 16 + 16) % 16;
  const panels: GameUiPanel[] = [
    { id: 'kestrel:health', role: 'health', width: 176, height: 90, priority: -30, children: [stack(text(operator.name, 'hud-name', 'accent'),
      { kind: 'bar', label: 'Health', value: Math.max(0, Math.min(player.maxHp, player.hp)), max: Math.max(1, player.maxHp), tone: 'health' },
      { kind: 'bar', label: 'Armor', value: Math.max(0, Math.min(75, state.armor)), max: 75, tone: 'armor' })] },
    { id: 'kestrel:ammo', role: 'ammo', width: 176, height: showRequisitions ? 126 : 84, priority: -20, children: [stack(
      text(`${weaponName(state.weapon)} · $${state.credits}`, 'hud-name'), text(state.reload > 0 ? `RELOAD ${clock(state.reload)}` : `${state.ammo} / ${state.reserve}`, 'hud-ammo', 'accent'),
      showRequisitions ? { kind: 'button', id: 'open-requisitions', label: 'Requisitions', primary: true, action: { name: 'openUi' } }
        : text(`Primary ${state.primary ? weaponName(state.primary) : '—'} · Pistol ${weaponName(state.stash.pistol)}`, 'hud-small', 'muted'))] },
    { id: 'kestrel:objective', role: 'objective', width: 220, height: 88, priority: -40, children: [stack(...objective)] },
    { id: 'kestrel:status', role: 'status', width: 190, height: 100, priority: -10, children: [stack(
      text(cooldown(operator.a, state.skillA), '', state.skillA > 0 ? 'muted' : 'accent'), text(cooldown(operator.b, state.skillB), '', state.skillB > 0 ? 'muted' : 'accent'),
      ...(feed.length ? feed : [text(state.stash.notice || operator.role, 'hud-small', 'muted')]))] },
    { id: 'kestrel:minimap', role: 'minimap', width: 156, height: 176, priority: -50, children: [
      { kind: 'stack', className: 'map-board', label: `${MAP_NAME} radar`, children: [...mapGeometry, ...contacts,
        text('▲', `map-self map-x-${bucket(state.x)} map-z-${bucket(state.z)} map-heading-${heading}`)] }, text(nearest.label, 'map-callout'),
    ] },
    { id: 'crosshair', role: 'crosshair', visible: alive && !spectating && !state.shop && world.round.phase === 0, children: [{ kind: 'crosshair', shape: 'ticks', size: 22, gap: 6, thickness: 2, color: '#e5fff1', outline: true }] },
  ];
  if (state.shop && buy && alive && !spectating) panels.push({ id: 'kestrel:shop', role: 'store', title: 'Requisitions', presentation: 'modal', width: 900, height: 650,
    onDismiss: { name: 'closeUi' }, children: [text(`$${state.credits} available · ${clock(BUY_MS - world.elapsedMs)} to deploy`, 'shop-balance'),
      text(state.stash.notice || 'Select equipment to purchase. Your balance and the buy phase are checked by the game.', 'shop-note'),
      { kind: 'choices', label: 'Weapons and armor', columns: 4, variant: 'cards', items: [
        ...GUNS.map((gun, index) => ({ id: `weapon-${index}`, label: gun.name, icon: gun.slot === 'sidearm' ? '◇' : '↗', role: gun.type,
          description: `${gun.type} · ${gun.mag} rounds · ${gun.reserve} reserve`, meta: `$${gun.cost}`, selected: state.selection === index,
          disabled: state.credits < gun.cost, action: { name: 'buyItem', index } })),
        ...[25, 50].map((armor, index) => ({ id: `armor-${armor}`, label: `${armor === 25 ? 'Light' : 'Heavy'} armor`, icon: '⬡', role: `${armor} armor`,
          description: `Equip ${armor} armor.`, meta: `$${armor === 25 ? 400 : 1000}`, selected: state.selection === ARMOR_LIGHT + index,
          disabled: state.credits < (armor === 25 ? 400 : 1000) || state.armor >= armor, action: { name: 'buyItem', index: ARMOR_LIGHT + index } })),
      ] },
    ] });
  return { version: 1, panels, theme: FPS_UI_THEME, defaults: { health: false, timer: false, status: false, info: false, crosshair: false },
    actions: [{ name: 'openUi', label: 'Open requisitions' }, { name: 'buyItem', label: 'Purchase equipment' }, { name: 'closeUi', label: 'Close requisitions' }] };
}

