import game from '../../../src/game/logic.ts';
import { createInput } from '../../../src/game/controls.ts';
import defaults from '../../../src/game/tuning.json' with { type: 'json' };
import type { FightInput } from '../../../src/game/shapes.ts';
import { describe, it, expect, newMatch, stepMatch } from '../../../src/sandbox/testkit.ts';
const dt = 20;
function duel(gap = 1.5) {
  const match = newMatch(game, { ...defaults });
  match.players.forEach((p, i) => Object.assign(p.state, { x: 0, z: i ? gap / 2 : -gap / 2, facing: i ? Math.PI : 0 }));
  const step = (a: Partial<FightInput> = {}, b: Partial<FightInput> = {}) => stepMatch(game, match, [createInput(a), createInput(b)], dt);
  const run = (ms: number, a: Partial<FightInput> = {}, b: Partial<FightInput> = {}) => { const events = []; for (let n = 0; n < ms; n += dt) events.push(...step(a, b)); return events; };
  return { match, p: match.players, step, run };
}
const lane = (index: number): Partial<FightInput> => index === 0 ? { guardLeft: true } : index === 1 ? { guardUp: true } : { guardRight: true };

describe('three direction sword combat', () => {
  it('starts both knights alive in high guard, with no old projectiles', () => {
    const f = duel();
    expect(f.p.map(p => [p.hp, p.maxHp, p.state.combat.guard, p.state.combat.isBlocking])).toEqual([[100, 100, 1, true], [100, 100, 1, true]]);
    expect(f.match.world.strikes).toHaveLength(0);
  });
  for (const attacker of [0, 1]) for (const direction of [0, 1, 2]) {
    it(`player ${attacker} lane ${direction}: held matching guard blocks, wrong guard takes a single light hit`, () => {
      for (const correct of [true, false]) {
        const f = duel(), defender = 1 - attacker;
        f.p[attacker].state.combat.guard = direction; f.p[defender].state.combat.guard = correct ? direction : (direction + 1) % 3;
        f.step(attacker === 0 ? { attack: true } : {}, attacker === 1 ? { attack: true } : {});
        f.run(850);
        expect(f.p[defender].hp).toBe(correct ? 100 : 85);
      }
    });
    it(`player ${attacker} lane ${direction}: late guard parries and stuns the attacker`, () => {
      const f = duel(), defender = 1 - attacker;
      f.p[attacker].state.combat.guard = direction; f.p[defender].state.combat.guard = (direction + 1) % 3;
      f.step(attacker === 0 ? { attack: true } : {}, attacker === 1 ? { attack: true } : {});
      f.run(300);
      f.step(defender === 0 ? lane(direction) : {}, defender === 1 ? lane(direction) : {});
      const events = f.run(100);
      expect(events.some(event => event.type === 'parry')).toBe(true);
      expect(f.p[defender].hp).toBe(100);
      expect(f.p[attacker].state.combat.stunMs).toBeGreaterThan(0);
    });
  }
  it('switching too early blocks without a parry; held guard input cannot rearm every tick', () => {
    const f = duel(); f.p[0].state.combat.guard = 0;
    f.step({ attack: true }, { guardLeft: true });
    const events = f.run(440, {}, { guardLeft: true });
    expect(events.some(event => event.type === 'block')).toBe(true);
    expect(events.some(event => event.type === 'parry')).toBe(false);
    expect(f.p[1].hp).toBe(100);
  });
  it('sword reach and facing matter', () => {
    const far = duel(4); far.step({ attack: true, guardLeft: true }); far.run(450); expect(far.p[1].hp).toBe(100);
    const back = duel(); back.p[0].state.facing = Math.PI; back.step({ attack: true, guardLeft: true }); back.run(450); expect(back.p[1].hp).toBe(100);
  });
  it('simultaneous unguarded sword attacks trade equally', () => {
    const f = duel(); f.step({ attack: true }, { attack: true }); f.run(440);
    expect(f.p.map(p => p.hp)).toEqual([85, 85]);
  });
  it('resolves a 400ms light attack after exactly twelve authoritative 30Hz intervals', () => {
    const f = duel();
    stepMatch(game, f.match, [createInput({ attack: true, guardLeft: true }), createInput()], 1000 / 30);
    for (let i = 0; i < 11; i++) stepMatch(game, f.match, [createInput(), createInput()], 1000 / 30);
    expect(f.p[1].hp).toBe(100);
    stepMatch(game, f.match, [createInput(), createInput()], 1000 / 30);
    expect(f.p[1].hp).toBe(85);
  });
  for (const attacker of [0, 1]) {
    it(`player ${attacker} heavy charge is held until release and increases damage`, () => {
      const tap = duel(), charged = duel(), defender = 1 - attacker;
      for (const [f, duration] of [[tap, 20], [charged, 1100]] as const) {
        f.p[attacker].state.combat.guard = 0;
        const input = { heavy: true };
        f.step(attacker === 0 ? input : {}, attacker === 1 ? input : {});
        f.run(duration, attacker === 0 ? input : {}, attacker === 1 ? input : {});
        expect(f.p[defender].hp).toBe(100);
        expect(f.p[attacker].state.combat.attackState).toBe('charging');
        f.step(); f.run(560);
      }
      expect(charged.p[defender].hp).toBe(55);
      expect(tap.p[defender].hp).toBeGreaterThan(charged.p[defender].hp);
      expect(tap.p[defender].hp).toBeLessThan(75);
    });
    it(`player ${attacker} heavy can be blocked and parried in its declared lane`, () => {
      const f = duel(), defender = 1 - attacker;
      f.step(attacker === 0 ? { heavy: true } : {}, attacker === 1 ? { heavy: true } : {}); f.step();
      f.run(400); f.step(defender === 0 ? { guardUp: true } : {}, defender === 1 ? { guardUp: true } : {}); f.run(120);
      expect(f.p[defender].hp).toBe(100); expect(f.p[attacker].state.combat.stunMs).toBeGreaterThan(0);
    });
  }
});

describe('hilt strike and counter', () => {
  for (const attacker of [0, 1]) {
    it(`player ${attacker} hilt stuns through matching weapon guard`, () => {
      const f = duel(.96), defender = 1 - attacker;
      f.step(attacker === 0 ? { bash: true } : {}, attacker === 1 ? { bash: true } : {});
      f.run(300);
      expect(f.p[defender].state.combat.stunMs).toBeGreaterThan(0); expect(f.p[defender].hp).toBe(100);
      const before = f.p[defender].state.z;
      f.step(defender === 0 ? { attack: true, moveZ: 1 } : {}, defender === 1 ? { attack: true, moveZ: 1 } : {});
      expect(f.p[defender].state.combat.attackState).toBe('stunned'); expect(f.p[defender].state.z).toBeCloseTo(before, 3);
    });
    it(`player ${attacker} hilt is countered by a late opposing hilt input`, () => {
      const f = duel(.96), defender = 1 - attacker;
      f.step(attacker === 0 ? { bash: true } : {}, attacker === 1 ? { bash: true } : {}); f.run(200);
      f.step(defender === 0 ? { bash: true } : {}, defender === 1 ? { bash: true } : {});
      const events = f.run(100);
      expect(events.some(event => event.type === 'hiltCounter')).toBe(true);
      expect(f.p.map(p => p.state.combat.stunMs)).toEqual([0, 0]);
      f.run(600); expect(f.p.map(p => p.state.combat.stunMs)).toEqual([0, 0]);
    });
  }
  it('simultaneous hilt strikes counter symmetrically', () => {
    const f = duel(.96); f.step({ bash: true }, { bash: true }); f.run(300);
    expect(f.p.map(p => p.state.combat.stunMs)).toEqual([0, 0]); expect(f.p.map(p => p.state.combat.actionFeedback)).toEqual(['hiltCounter', 'hiltCounter']);
  });
  it('requires close hilt contact instead of stunning from sword distance', () => {
    const f = duel(1.5); f.step({ bash: true }); f.run(300);
    expect(f.p[1].state.combat.stunMs).toBe(0); expect(f.p[1].hp).toBe(100);
  });
});

describe('tap dodge and held sprint', () => {
  for (const player of [0, 1]) {
    it(`player ${player} can dodge each cardinal and diagonal direction`, () => {
      for (const [moveX, moveZ] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
        const f = duel(6), input = { dodge: true, moveX, moveZ };
        f.step(player === 0 ? input : {}, player === 1 ? input : {});
        const before = { ...f.p[player].state };
        f.step(player === 0 ? { moveX, moveZ } : {}, player === 1 ? { moveX, moveZ } : {});
        expect(f.p[player].state.combat.attackState).toBe('dodge');
        expect((f.p[player].state.x - before.x) * moveX + (f.p[player].state.z - before.z) * moveZ).toBeGreaterThan(0);
      }
    });
    it(`player ${player} holds Space to sprint and releasing it does not dodge`, () => {
      const f = duel(6), input = { dodge: true, moveX: 1 };
      f.run(200, player === 0 ? input : {}, player === 1 ? input : {});
      expect(f.p[player].state.combat.sprint).toBe(true); expect(f.p[player].state.combat.dodgeMs).toBe(0);
      expect(Math.abs(f.p[player].state.velocityX)).toBeGreaterThan(defaults.moveSpeed);
      f.step(); expect(f.p[player].state.combat.sprint).toBe(false); expect(f.p[player].state.combat.dodgeMs).toBe(0);
    });
  }
  it('tap dodge avoids a connecting slash and cannot be chained during cooldown', () => {
    const f = duel(); f.step({ attack: true, guardLeft: true }); f.run(340);
    f.step({}, { dodge: true, moveX: 1 }); f.step({}, { moveX: 1 }); f.run(60);
    expect(f.p[1].hp).toBe(100);
    f.run(260); f.step({}, { dodge: true }); f.step(); expect(f.p[1].state.combat.dodgeMs).toBe(0);
  });
  it('movement respects the shared circular arena boundary', () => {
    const f = duel(6); f.run(2500, { moveX: 1, dodge: true });
    expect(Math.hypot(f.p[0].state.x, f.p[0].state.z)).toBeLessThan(defaults.arenaRadius);
  });
  it('classifies release just below the hold threshold as dodge and at threshold as sprint release', () => {
    const short = duel(6), held = duel(6);
    short.run(160, { dodge: true, moveX: 1 }); short.step({ moveX: 1 });
    expect(short.p[0].state.combat.attackState).toBe('dodge');
    held.run(180, { dodge: true, moveX: 1 });
    expect(held.p[0].state.combat.sprint).toBe(true);
    held.step({ moveX: 1 }); expect(held.p[0].state.combat.attackState).toBe('idle');
  });
});

describe('camera-relative controls', () => {
  it('writes remappable action bindings and movement relative to the actual camera', () => {
    const f = duel(), input = createInput();
    game.controls.writeInput(input, {
      value: name => name === 'moveAhead' ? 1 : 0,
      held: name => name === 'heavy' || name === 'dodge',
      tapped: name => name === 'guardRight' || name === 'bash',
      pointer: { x: 0, y: 0, deltaX: 7, deltaY: -3, locked: true, captured: true },
    }, { phase: 'fighting', world: f.match.world, tuning: f.match.tuning, now: 0, dt: .02,
      view: { forwardX: 1, forwardZ: 0 }, players: f.p.map((p, i) => ({ ...p, id: String(i), name: String(i), isLocal: i === 0 })) });
    expect(input).toMatchObject({ moveX: 1, moveZ: 0, heavy: true, dodge: true, bash: true, guardRight: true, attack: false, lookX: 7, lookY: -3 });
  });
});
