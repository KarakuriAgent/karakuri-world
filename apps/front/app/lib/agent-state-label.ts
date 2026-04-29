import type { SpectatorAgentSnapshot } from '../../worker/src/contracts/spectator-snapshot.js';

export function getAgentStateLabel(state: SpectatorAgentSnapshot['state']): string {
  switch (state) {
    case 'moving':
      return '移動中';
    case 'in_action':
      return 'アクション中';
    case 'in_conversation':
      return '会話中';
    case 'in_transfer':
      return '譲渡中';
    case 'idle':
      return '待機中';
  }
}
