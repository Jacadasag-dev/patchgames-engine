import { MatchSandbox, type MatchUpdate } from '../../sandbox/host/match.ts';
import { LOGIC_ENTRIES, loadQuickJS, Sandbox } from '../../sandbox/host/quickjs.ts';
import { parseGameInfo, parseRoster, type GameInfo } from '../../shared/shapes.ts';
import { isGameMode, type GameModeId } from '../../shared/gameModes.ts';
import { withGameRules } from '../../sandbox/host/gameInfo.ts';
import type { PreviewRules, PreviewSimulationRequest } from './previewSimulation.ts';

/** Browser-safe trusted host. Game source executes only inside QuickJS. */
export class PreviewSimulationRuntime {
  readonly info: GameInfo;
  private readonly match: MatchSandbox;
  private constructor(source: string, mode?: GameModeId, rules: PreviewRules = {}) {
    const description = new Sandbox(source, LOGIC_ENTRIES);
    let info: GameInfo;
    try { info = parseGameInfo(description.call('describe', null, 250).value); }
    finally { description.dispose(); }
    if (mode !== undefined && (!isGameMode(mode) || !(info.supportedModes ?? [info.mode]).includes(mode)))
      throw new Error('This content does not support its selected preview mode.');
    const selected = { source, info: { ...info, mode: mode ?? info.mode, roster: rules.roster === undefined ? info.roster : parseRoster(rules.roster) } };
    this.info = (rules.tags ? withGameRules(selected, rules.tags) : selected).info;
    this.match = new MatchSandbox({ source, info: this.info }, 'live-worker');
  }
  static async load(source: string, mode?: GameModeId, rules?: PreviewRules): Promise<PreviewSimulationRuntime> {
    await loadQuickJS(); return new PreviewSimulationRuntime(source, mode, rules);
  }
  execute(request: Extract<PreviewSimulationRequest, { type: 'call' }>): MatchUpdate {
    return request.operation === 'setup' ? this.match.setup(...request.args) : this.match.step(...request.args);
  }
  dispose(): void { this.match.dispose(); }
}
