import {defineFeature} from '../../../sandbox/features.ts';
export const config = {
  color: {type: 'string', default: '#46cfc1', values: ['#46cfc1', '#7c98ad', '#b09d83']},
  scale: {type: 'number', default: .82, min: 0.35, max: 2},
} as const;
export default defineFeature({apiVersion: 1, config, requires: ['player.appearance.v1'],
  playerModels: [{id: 'default', label: "Kestrel operators", description: 'A custom character model.'}],
});

