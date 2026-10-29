import type { InspectionSetup, MatchContext } from '../shared/gameApi.ts';
import type { PlayerState, WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
import { DRESSING_AREA, seats } from './layout.ts';
import { chooseTruthPrompt, reconcileTables, startCardRound } from './socialGames.ts';

type Context = MatchContext<WorldState, PlayerState, GameTuning>;
function placeAtSeat(ctx: Context, playerIndex: number, seatIndex: number): void {
  const player = ctx.players[playerIndex], seat = seats[seatIndex];
  if (!player || !seat) return;
  Object.assign(player.state, { x: seat.x, y: seat.y, z: seat.z, facing: seat.facing, aimPitch: 0,
    seatIndex, tableId: seat.tableId ?? -1, velocityX: 0, velocityY: 0, velocityZ: 0, grounded: 1,
    sitHeld: false, attackMs: 0, cooldownMs: 0 });
}
export const loungeInspectionSetups: readonly InspectionSetup<WorldState, PlayerState, GameTuning>[] = [
  {
    id: 'lounge-seated', label: 'Seated posture and standing',
    relevance: { sourcePaths: ['src/game/layout.ts', 'src/game/animations.ts', 'src/game/logic.ts'], tags: ['seatIndex', 'seated'] },
    description: 'Stage the first game chair for seated posture, table clearance, and ordinary stand/move transitions.',
    recommendedScenario: { recipe: 'character-quality' },
    stage(ctx) { placeAtSeat(ctx, 0, 0); reconcileTables(ctx.world.tables, ctx.players); },
  },
  {
    id: 'lounge-mirror', label: 'Dressing mirror and avatar',
    relevance: { sourcePaths: ['src/game/view.ts', 'src/game/models.ts'], tags: ['mirror', 'avatar', 'dressing'] },
    description: 'Stage the subject facing the illuminated dressing mirror. Check the reflected body and dressing-area instructions.',
    recommendedScenario: { recipe: 'character-quality' },
    stage(ctx) { Object.assign(ctx.players[0].state, { x: DRESSING_AREA.x, y: 0, z: DRESSING_AREA.z, facing: 0, aimPitch: 0 }); },
  },
  {
    id: 'lounge-cards', label: 'Color Clash table',
    relevance: { sourcePaths: ['src/game/socialGames.ts', 'src/game/view.ts', 'src/game/loungeOverlay.ts'], tags: ['cards', 'Color Clash', 'table'] },
    description: 'Seat up to four supplied participants at Color Clash. Two or more start a real round; a solo subject sees waiting text.',
    recommendedScenario: { recipe: 'character-quality' },
    stage(ctx) {
      const places = seats.map((seat, index) => ({ seat, index })).filter(entry => entry.seat.tableId === 1);
      for (let i = 0; i < Math.min(ctx.players.length, places.length); i++) placeAtSeat(ctx, i, places[i].index);
      reconcileTables(ctx.world.tables, ctx.players);
      startCardRound(ctx.world.tables[1], ctx.players, () => ctx.random('lounge-table-1'));
    },
  },
  {
    id: 'lounge-truth', label: 'Truth or Dare table',
    relevance: { sourcePaths: ['src/game/socialGames.ts', 'src/game/view.ts', 'src/game/loungeOverlay.ts'], tags: ['truth', 'dare', 'table'] },
    description: 'Seat supplied participants at Truth or Dare and display an optional truth prompt with the next-turn controls.',
    recommendedScenario: { recipe: 'character-quality' },
    stage(ctx) {
      const places = seats.map((seat, index) => ({ seat, index })).filter(entry => entry.seat.tableId === 0);
      for (let i = 0; i < Math.min(ctx.players.length, places.length); i++) placeAtSeat(ctx, i, places[i].index);
      reconcileTables(ctx.world.tables, ctx.players); chooseTruthPrompt(ctx.world.tables[0], ctx.players[0], 'truth');
    },
  },
  {
    id: 'lounge-emote-wheel', label: 'Six-way emote wheel',
    relevance: { sourcePaths: ['src/game/logic.ts', 'src/game/view.ts', 'src/game/loungeOverlay.ts'], tags: ['wheel', 'emote'] },
    description: 'Open the real emote wheel on the subject; arrows change the highlighted choice and E performs it.',
    recommendedScenario: { recipe: 'character-quality' },
    stage(ctx) { Object.assign(ctx.players[0].state, { wheelOpen: true, wheelChoice: 1 }); },
  },
  {
    id: 'lounge-emotes', label: 'Social emote animations',
    relevance: { sourcePaths: ['src/game/animations.ts', 'src/game/view.ts'], tags: ['wave', 'dance', 'emote'] },
    description: 'Stage the supplied actors across the central floor with distinct timed emotes. Ordinary movement cancels their emotes.',
    recommendedScenario: { recipe: 'character-quality', durationMs: 4000 },
    stage(ctx) {
      ctx.players.forEach((player, index) => Object.assign(player.state, {
        x: (index % 4 - 1.5) * 2.2, z: 5 - Math.floor(index / 4) * 2.2, y: 0, facing: Math.PI,
        emoteId: index % 6 + 1, emoteStartedMs: 0, emoteUntilMs: ctx.tuning.emoteDurationMs,
      }));
    },
  },
];
