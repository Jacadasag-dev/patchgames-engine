import type { GamePlayer } from '../shared/gameApi.ts';
import { seats, TABLES } from './layout.ts';
import type { PlayerState, TableState } from './shapes.ts';

/** A small original matching game. All decisions are resolved on the authority. */
export const CARD_COLORS = [
  { name: 'Coral', hex: '#ef7b7b' }, { name: 'Gold', hex: '#e8be58' },
  { name: 'Mint', hex: '#65cab3' }, { name: 'Sky', hex: '#7dacf3' },
] as const;
export const EMOTES = [
  { id: 1, name: 'Wave', label: 'Wave' }, { id: 2, name: 'Dance', label: 'Dance' },
  { id: 3, name: 'Cheer', label: 'Cheer' }, { id: 4, name: 'Laugh', label: 'Laugh' },
  { id: 5, name: 'Clap', label: 'Clap' }, { id: 6, name: 'Pose', label: 'Pose' },
] as const;
export const CARD_HAND_SIZE = 7;
export const WILD_CARD = 52;
export const CARD_RULES = 'Match the color or symbol. Skip, reverse and +2 affect the next turn. Wilds choose any color. R draws one and passes.';
const TRUTHS = [
  'What tiny thing always makes your day better?', 'Which fictional world would you visit for a weekend?',
  'What is a hobby you would love to try?', 'What song puts you in a good mood?',
  'What is the best snack for a late-night hangout?', 'What is a skill you are proud of learning?',
  'If you could design a room, what would it look like?', 'What is a kind thing someone did for you?',
  'Which game could you talk about for hours?', 'What would your ideal lazy Sunday look like?',
  'If you could have a harmless superpower, what would it be?', 'What is your favorite way to make a new friend?',
] as const;
const DARES = [
  'Use the emote wheel to give everyone a wave.', 'Describe your avatar as a dramatic movie trailer.',
  'Do your favorite dance emote for the table.', 'Invent a silly name for this lounge.',
  'Give the table a cheerful round of applause.', 'Speak like a friendly robot for your next reply.',
  'Tell a tiny story using only five words.', 'Strike a pose and give it a dramatic name.',
  'Give someone at the table a friendly compliment.', 'Pretend to be the host of a very fancy cafe.',
  'Make up a completely harmless superhero catchphrase.', 'Cheer for everyone at the table with an emote.',
] as const;
type Players = readonly GamePlayer<PlayerState>[];
type Random = () => number;
const live = (player: GamePlayer<PlayerState>) => player.active !== false && player.hp > 0 && !player.state.eliminated;
function seated(table: TableState, players: Players): GamePlayer<PlayerState>[] {
  return players.filter(player => live(player) && player.state.tableId === table.id
    && seats[player.state.seatIndex]?.tableId === table.id)
    .sort((a, b) => (seats[a.state.seatIndex].tableSlot ?? 0) - (seats[b.state.seatIndex].tableSlot ?? 0) || a.index - b.index).slice(0, 4);
}
const validCard = (card: number) => Number.isInteger(card) && card >= 0 && card <= WILD_CARD;
export function cardColor(card: number): number { return card === WILD_CARD ? -1 : Math.floor(card / 13); }
export function cardValue(card: number): number { return card === WILD_CARD ? 13 : card % 13; }
export function cardLabel(card: number): string {
  if (!validCard(card)) return 'No card';
  if (card === WILD_CARD) return 'Wild';
  const value = cardValue(card);
  return `${CARD_COLORS[cardColor(card)].name} ${value < 10 ? value : ['Skip', 'Reverse', '+2'][value - 10]}`;
}
export function canPlayCard(card: number, table: TableState): boolean {
  return validCard(card) && table.phase === 'playing' && table.kind === 'cards'
    && (card === WILD_CARD || cardColor(card) === table.currentColor || cardValue(card) === cardValue(table.topCard));
}
export function createTables(): TableState[] {
  return TABLES.map(table => ({ id: table.id, kind: table.kind, phase: 'waiting', round: 0, playerOrder: [],
    turn: -1, direction: 1, topCard: -1, currentColor: 0, deck: [], discard: [], winner: -1,
    prompt: '', promptKind: '', promptIndex: 0, message: table.kind === 'cards' ? 'Take a seat. Two players start a round.' : 'Take a seat. Truth, dare, or pass — your choice.' }));
}
function shuffle(cards: number[], random: Random): void {
  for (let i = cards.length - 1; i > 0; i--) {
    const sample = random();
    const j = Math.min(i, Math.max(0, Math.floor((Number.isFinite(sample) ? sample : 0) * (i + 1))));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
}
function nextPlayer(table: TableState, from = table.turn, steps = 1): number {
  const order = table.playerOrder, index = order.indexOf(from);
  if (!order.length) return -1;
  return order[((index < 0 ? 0 : index) + table.direction * steps % order.length + order.length) % order.length];
}
function resetCards(table: TableState, players: Players): void {
  for (const player of players) if (table.playerOrder.includes(player.index) || player.state.tableId === table.id) {
    player.state.hand = []; player.state.selectedCard = 0;
  }
  Object.assign(table, { phase: 'waiting', turn: -1, topCard: -1, currentColor: 0, direction: 1,
    deck: [], discard: [], winner: -1, message: 'Waiting for at least two seated players.' });
}
/** Session slot reuse can replace a departed hand before the first cleanup tick.
 * Recover its exact multiset from the cards still in play, without storing a
 * second copy of every hand or changing another player's state during join. */
function restoreMissingCards(table: TableState, players: Players): void {
  const remaining = Array.from({ length: WILD_CARD + 1 }, (_, card) => card === WILD_CARD ? 4 : 2);
  const accounted = [...table.deck, ...table.discard];
  for (const player of players) if (table.playerOrder.includes(player.index)) accounted.push(...player.state.hand);
  for (const card of accounted) if (validCard(card)) remaining[card]--;
  for (let card = 0; card < remaining.length; card++) for (let count = 0; count < remaining[card]; count++) table.deck.push(card);
}
/** Departures return cards and advance a departed turn. New arrivals wait for the next round. */
export function reconcileTables(tables: TableState[], players: Players): void {
  for (const table of tables) {
    const present = seated(table, players).map(player => player.index);
    if (table.kind === 'truth') {
      const turnLeft = !present.includes(table.turn);
      let successor = table.turn;
      for (let step = 1; step <= table.playerOrder.length && !present.includes(successor); step++) successor = nextPlayer(table, table.turn, step);
      table.playerOrder = present;
      table.phase = present.length ? 'playing' : 'waiting';
      if (turnLeft) { table.turn = present.includes(successor) ? successor : present[0] ?? -1; table.prompt = ''; table.promptKind = ''; }
      continue;
    }
    if (table.phase !== 'playing') {
      // Winner indices name a session occupant; do not credit a replacement
      // occupant after the winner has left their chair or the session.
      if (table.phase === 'finished' && !present.includes(table.winner)) resetCards(table, players);
      table.playerOrder = present; continue;
    }
    const previous = [...table.playerOrder], previousTurn = table.turn;
    let successor = previousTurn;
    for (let step = 1; step <= previous.length && !present.includes(successor); step++) successor = nextPlayer(table, previousTurn, step);
    let replacedParticipant = false;
    for (const index of previous.filter(index => !present.includes(index))) {
      const player = players.find(player => player.index === index);
      if (!player?.state.hand.length) replacedParticipant = true;
      if (player) { table.deck.push(...player.state.hand); player.state.hand = []; player.state.selectedCard = 0; }
    }
    table.playerOrder = previous.filter(index => present.includes(index));
    if (table.playerOrder.length < 2) {
      resetCards(table, players); table.playerOrder = present;
    } else {
      if (replacedParticipant) restoreMissingCards(table, players);
      if (!table.playerOrder.includes(previousTurn)) {
        table.turn = table.playerOrder.includes(successor) ? successor : table.playerOrder[0];
        table.message = 'A player left. The round continues.';
      }
    }
  }
  for (const player of players) if (!tables.some(table => table.kind === 'cards'
    && table.phase !== 'waiting' && table.playerOrder.includes(player.index))) {
    player.state.hand = []; player.state.selectedCard = 0;
  }
}
export function startCardRound(table: TableState, players: Players, random: Random): boolean {
  if (table.kind !== 'cards' || table.phase === 'playing') return false;
  const roster = seated(table, players);
  if (roster.length < 2) { table.message = 'A friend must take a seat to start Color Clash.'; return false; }
  const deck: number[] = [];
  for (let copy = 0; copy < 2; copy++) for (let card = 0; card < WILD_CARD; card++) deck.push(card);
  for (let copy = 0; copy < 4; copy++) deck.push(WILD_CARD);
  shuffle(deck, random);
  Object.assign(table, { phase: 'playing', round: table.round + 1, playerOrder: roster.map(player => player.index),
    turn: roster[0].index, direction: 1, winner: -1, deck, discard: [], prompt: '', promptKind: '', message: 'Round started. Match the color or symbol.' });
  for (const player of roster) {
    player.state.hand = []; player.state.selectedCard = 0;
    for (let card = 0; card < CARD_HAND_SIZE; card++) player.state.hand.push(table.deck.pop()!);
  }
  // Start on a number, so an opening action never silently penalizes a player.
  const opening = table.deck.findIndex(card => cardValue(card) < 10);
  table.topCard = table.deck.splice(opening, 1)[0]; table.currentColor = cardColor(table.topCard);
  table.discard = [table.topCard];
  return true;
}
function drawCards(table: TableState, player: GamePlayer<PlayerState>, count: number, random: Random): number {
  let drawn = 0;
  for (let i = 0; i < count && player.state.hand.length < 108; i++) {
    if (!table.deck.length && table.discard.length > 1) {
      table.deck = table.discard.slice(0, -1); table.discard = [table.topCard]; shuffle(table.deck, random);
    }
    const card = table.deck.pop();
    if (card === undefined) break;
    player.state.hand.push(card); drawn++;
  }
  return drawn;
}
function ownsTurn(table: TableState, player: GamePlayer<PlayerState>): boolean {
  return table.kind === 'cards' && table.phase === 'playing' && table.turn === player.index
    && table.playerOrder.includes(player.index) && live(player) && player.state.tableId === table.id
    && seats[player.state.seatIndex]?.tableId === table.id;
}
export function playSelectedCard(table: TableState, player: GamePlayer<PlayerState>, players: Players, random: Random): boolean {
  if (!ownsTurn(table, player)) return false;
  const selected = player.state.selectedCard;
  if (!Number.isInteger(selected) || selected < 0 || selected >= player.state.hand.length) return false;
  const card = player.state.hand[selected];
  if (!canPlayCard(card, table)) return false;
  player.state.hand.splice(selected, 1);
  player.state.selectedCard = Math.max(0, Math.min(selected, player.state.hand.length - 1));
  table.topCard = card; table.discard.push(card);
  table.currentColor = card === WILD_CARD ? (Number.isInteger(player.state.selectedColor) ? Math.max(0, Math.min(3, player.state.selectedColor)) : 0) : cardColor(card);
  const value = cardValue(card);
  let steps = value === 10 ? 2 : 1;
  if (value === 11) { table.direction *= -1; if (table.playerOrder.length === 2) steps = 2; }
  if (value === 12) {
    const next = players.find(candidate => candidate.index === nextPlayer(table));
    if (next) drawCards(table, next, 2, random);
    steps = 2;
  }
  table.message = `${cardLabel(card)} played.${player.state.hand.length === 1 ? ' One card left!' : ''}`;
  if (!player.state.hand.length) {
    table.phase = 'finished'; table.winner = player.index; table.turn = -1; table.message = 'Round won! Start a rematch when ready.';
  } else table.turn = nextPlayer(table, player.index, steps);
  return true;
}
export function drawAndPass(table: TableState, player: GamePlayer<PlayerState>, _players: Players, random: Random): boolean {
  if (!ownsTurn(table, player)) return false;
  const drawn = drawCards(table, player, 1, random);
  table.turn = nextPlayer(table); table.message = drawn ? 'One card drawn. Turn passed.' : 'Draw pile empty. Turn passed.';
  return true;
}
export function chooseTruthPrompt(table: TableState, player: GamePlayer<PlayerState>, kind: 'truth' | 'dare'): boolean {
  if (table.kind !== 'truth' || table.phase !== 'playing' || table.turn !== player.index || !live(player)
    || player.state.tableId !== table.id || seats[player.state.seatIndex]?.tableId !== table.id
    || !table.playerOrder.includes(player.index) || table.prompt) return false;
  const prompts = kind === 'truth' ? TRUTHS : DARES;
  table.prompt = prompts[(table.promptIndex + table.id * 3) % prompts.length];
  table.promptIndex++; table.promptKind = kind; table.message = 'Answer in chat or voice. E finishes or passes; every prompt is optional.';
  return true;
}
export function completeTruthPrompt(table: TableState, player: GamePlayer<PlayerState>): boolean {
  if (table.kind !== 'truth' || table.phase !== 'playing' || table.turn !== player.index || !live(player)
    || player.state.tableId !== table.id || seats[player.state.seatIndex]?.tableId !== table.id
    || !table.playerOrder.includes(player.index)) return false;
  table.turn = nextPlayer(table); table.prompt = ''; table.promptKind = ''; table.round++;
  table.message = 'Next player: choose T for truth or R for dare. E passes.';
  return true;
}
export function tableStatus(table: TableState): string {
  if (table.phase === 'waiting') return table.kind === 'cards' ? 'Two players to start • take a seat' : 'Take a seat • choose truth or dare';
  if (table.phase === 'finished') return 'Round complete • T to rematch';
  return table.kind === 'truth' ? table.prompt || 'T truth • R dare • E pass' : `${cardLabel(table.topCard)} • ${CARD_COLORS[table.currentColor]?.name ?? 'Coral'} to play`;
}
