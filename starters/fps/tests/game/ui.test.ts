import { expect, it, newMatch, stepMatch } from '../../src/sandbox/testkit.ts';
import type { Buttons } from '../../src/shared/gameApi.ts';
import type { GameUiNode } from '../../src/shared/gameUi.ts';
import game from '../../src/game/logic.ts';
import { createFpsUi } from '../../src/game/ui.ts';
import tuning from '../../src/game/tuning.json';
import { createInput } from '../../src/game/shapes.ts';
import { BUY_MS, GUNS, OPERATORS, SHOP_ITEMS } from '../../src/game/catalog.ts';

const fresh = () => newMatch(game, tuning, 10, 'just-chatting', undefined, {tags:['team'],roster:{players:10,teams:2,teamSize:5}});
const buttons = (actions: { name: string; index?: number; item?: string }[] = []): Buttons => ({ value: () => 0, held: () => false, tapped: () => false,
  pointer: { x: 0, y: 0, deltaX: 0, deltaY: 0, locked: false, captured: false },
  ui: name => actions.filter(action => action.name === name).map(action => ({ ...action, panel: 'kestrel:shop' })),
});
const nodes = (values: GameUiNode[]): GameUiNode[] => values.flatMap(node => [node,
  ...(node.kind === 'stack' || node.kind === 'row' ? nodes(node.children) : node.kind === 'tabs' ? node.tabs.flatMap(tab => nodes(tab.children)) : [])]);
it('binds the waiting operator preset to the real host class selection without fixture actions or locks', () => {
  const match = fresh();
  const frame: Parameters<typeof createFpsUi>[0] = { mode: 'just-chatting', phase: 'waiting', world: match.world,
    players: match.players.map((player, index) => ({ ...player, id: `player-${index}`, name: `Player ${index}`, isLocal: index === 0, classId: OPERATORS[index % OPERATORS.length].id })), tuning, now: 0, dt: 0 };
  for (const operator of OPERATORS) {
    frame.players[0] = { ...frame.players[0], classId: operator.id };
    const document = createFpsUi(frame)!, content = nodes(document.panels[0].children);
    const roster = content.find(node => node.kind === 'choices');
    if (roster?.kind !== 'choices') throw new Error('Expected the operator roster');
    expect(document.panels.length).toBe(1); expect(document.panels[0].role).toBe('selection');
    expect(document.panels[0].presentation).toBe('modal'); expect(document.panels[0].onDismiss).toBe(undefined);
    expect(document.actions).toEqual([{ name: 'host:chooseClass', label: 'Select operator' }]);
    expect(roster.items.map(item => item.id)).toEqual(OPERATORS.map(item => item.id));
    expect(roster.items.map(item => item.action)).toEqual(OPERATORS.map(item => ({ name: 'host:chooseClass', item: item.id })));
    expect(roster.items.filter(item => item.selected).map(item => item.id)).toEqual([operator.id]);
    expect(roster.items.some(item => item.confirmed || item.disabled)).toBe(false);
    expect(content.find(node => node.kind === 'button')).toEqual({ kind: 'button', id: 'confirm-operator', label: `Selected: ${operator.name}`,
      action: { name: 'host:chooseClass', item: operator.id }, primary: true, disabled: false });
    expect(content.some(node => node.kind === 'text' && node.id === 'character-confirmation' && node.text === `Selected · ${operator.name} · Change while waiting`)).toBe(true);
    expect(content.some(node => node.kind === 'text' && /Warden|River|Sol|Ash|Kai|locked/i.test(node.text))).toBe(false);
  }
});
it('renders waiting selection before world initialization and leaves gameplay inputs untouched', () => {
  const match = fresh();
  const frame: Parameters<typeof createFpsUi>[0] = { mode: 'just-chatting', phase: 'waiting', world: null,
    players: [{ ...match.players[0], id: 'self', name: 'Local player', isLocal: true, classId: 'wraith' }], tuning, now: 0, dt: 0 };
  const before = JSON.stringify(frame), document = createFpsUi(frame)!;
  expect(document.panels[0].role).toBe('selection'); expect(JSON.stringify(frame)).toBe(before);
  const input = createInput(); game.controls.writeInput(input, buttons([{ name: 'host:chooseClass', item: 'wraith' }]), {} as never);
  expect(input).toEqual(createInput());
  frame.phase = 'menu'; expect(createFpsUi(frame)).toBe(null);
});
it('opens requisitions from a UI intent through the existing checked shop input', () => {
  const match = fresh(), player = match.players[0], input = createInput();
  game.controls.writeInput(input, buttons([{ name: 'openUi' }]), {} as never);
  expect(input.shop).toBe(true); expect(input.buy).toBe(false);
  stepMatch(game, match, match.players.map((_, index) => index ? createInput() : input), 100);
  expect(player.state.shop).toBe(true);
  match.world.elapsedMs = BUY_MS + 1;
  stepMatch(game, match, match.players.map((_, index) => index ? createInput() : input), 100);
  expect(player.state.shop).toBe(false);
});
it('offers a buy-phase HUD entry only after countdown and restores the compact combat panel', () => {
  const match = fresh();
  const frame: Parameters<typeof createFpsUi>[0] = { mode: 'just-chatting', phase: 'countdown', world: match.world,
    players: match.players.map((player, index) => ({ ...player, id: `player-${index}`, name: `Player ${index}`, isLocal: index === 0 })), tuning, now: 0, dt: 0 };
  const entry = () => createFpsUi(frame)!.panels.flatMap(panel => nodes(panel.children)).find(node => node.kind === 'button' && node.action.name === 'openUi');
  expect(entry()).toBe(undefined);
  frame.phase = 'waiting'; expect(entry()).toBe(undefined);
  frame.phase = 'fighting'; expect(entry()).toEqual({ kind: 'button', id: 'open-requisitions', label: 'Requisitions', primary: true, action: { name: 'openUi' } });
  expect(createFpsUi(frame)!.actions!.some(action => action.name === 'openUi' && action.label === 'Open requisitions')).toBe(true);
  expect(createFpsUi(frame)!.panels.find(panel => panel.role === 'ammo')!.height).toBe(126);
  frame.players[0].hp = 0; expect(entry()).toBe(undefined);
  frame.players[0].hp = 100; frame.world!.elapsedMs = BUY_MS;
  expect(entry()).toBe(undefined); expect(createFpsUi(frame)!.panels.find(panel => panel.role === 'ammo')!.height).toBe(84);
});
it('shows a watched teammate loadout without enabling their requisitions, aiming overlay or owner-only objective text', () => {
  const match = fresh();
  const frame: Parameters<typeof createFpsUi>[0] = { mode: 'just-chatting', phase: 'fighting', world: match.world,
    players: match.players.map((player, index) => ({ ...player, id: `player-${index}`, name: `Player ${index}`, isLocal: index === 2 })),
    spectator: { targetId: 'player-2', delayRemainingMs: 0 }, tuning, now: 0, dt: 0 };
  frame.players[0].hp = 0; frame.players[2].hp = 83;
  frame.players[2].state.ammo = 9; frame.players[2].state.reserve = 36;
  frame.world!.elapsedMs = 1000; frame.world!.bomb.carrier = 2;
  for (const shop of [false, true]) {
    frame.players[2].state.shop = shop;
    const document = createFpsUi(frame)!, content = document.panels.flatMap(panel => nodes(panel.children));
    expect(document.panels.some(panel => panel.role === 'store')).toBe(false);
    expect(content.some(node => node.kind === 'button' && node.action.name === 'openUi')).toBe(false);
    expect(document.panels.find(panel => panel.role === 'crosshair')!.visible).toBe(false);
    expect(content.some(node => node.kind === 'bar' && node.tone === 'health' && node.value === 83)).toBe(true);
    expect(content.some(node => node.kind === 'text' && node.text === '9 / 36')).toBe(true);
    expect(content.some(node => node.kind === 'text' && node.text === 'Player 2 carries the device')).toBe(true);
    expect(content.some(node => node.kind === 'text' && node.text === 'You carry the device')).toBe(false);
  }
});
it('maps a clicked shop item to a checked selection and purchases only inside an open buy station', () => {
  const match = fresh(), player = match.players[0], input = createInput();
  player.state.shop = true; player.state.credits = 5000;
  game.controls.writeInput(input, buttons([{ name: 'buyItem', index: 3 }]), {} as never);
  expect(input.buySelection).toBe(4); expect(input.buy).toBe(true);
  stepMatch(game, match, match.players.map((_, index) => index ? createInput() : input), 100);
  expect(player.state.weapon).toBe(3); expect(player.state.credits).toBe(5000 - GUNS[3].cost);
  match.world.elapsedMs = BUY_MS + 1; player.state.credits = 5000;
  stepMatch(game, match, match.players.map((_, index) => index ? createInput() : input), 100);
  expect(player.state.credits).toBe(5000); expect(player.state.shop).toBe(false);
});
it('maps dismissal independently and rejects invalid UI indices without buying the current selection', () => {
  for (const index of [-1, .5, SHOP_ITEMS, Infinity]) {
    const input = createInput(); game.controls.writeInput(input, buttons([{ name: 'buyItem', index }]), {} as never);
    expect(input.buy).toBe(false); expect(input.buySelection).toBe(0);
  }
  const match = fresh(), input = createInput(); match.players[0].state.shop = true;
  game.controls.writeInput(input, buttons([{ name: 'closeUi' }]), {} as never);
  expect(input.closeUi).toBe(true);
  stepMatch(game, match, match.players.map((_, index) => index ? createInput() : input), 100);
  expect(match.players[0].state.shop).toBe(false);
});
it('retains keyboard selection/purchase controls and authoritative insufficient-funds checks', () => {
  const match = fresh(), player = match.players[0]; player.state.credits = 0;
  const input = createInput(); game.controls.writeInput(input, { ...buttons(), tapped: name => ['shop', 'next', 'buy'].includes(name) }, {} as never);
  expect(input.buySelection).toBe(0);
  stepMatch(game, match, match.players.map((_, index) => index ? createInput() : input), 100);
  expect(player.state.selection).toBe(2); expect(player.state.weapon).toBe(0); expect(player.state.credits).toBe(0);
  expect(player.state.stash.notice).toBe('Insufficient credits');
});
it('rejects malformed direct selections and never opens a shop from a purchase intent', () => {
  for (const buySelection of [-1, .5, SHOP_ITEMS + 1]) {
    const match = fresh(), player = match.players[0]; player.state.credits = 5000; player.state.shop = true;
    stepMatch(game, match, match.players.map((_, index) => index ? createInput() : createInput({ buy: true, buySelection })), 100);
    expect(player.state.credits).toBe(5000); expect(player.state.weapon).toBe(0);
  }
  const match = fresh(), player = match.players[0]; player.state.credits = 5000;
  stepMatch(game, match, match.players.map((_, index) => index ? createInput() : createInput({ buy: true, buySelection: 4 })), 100);
  expect(player.state.shop).toBe(false); expect(player.state.credits).toBe(5000);
});

