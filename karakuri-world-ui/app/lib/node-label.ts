import type { SpectatorMapSnapshot } from '../../worker/src/contracts/spectator-snapshot.js';
import type { NodeId } from '../../worker/src/contracts/world-snapshot.js';

export function formatNodeLabel(nodeId: NodeId, map: SpectatorMapSnapshot | undefined): string {
  const label = map?.nodes[nodeId]?.label;
  return label ? `${nodeId} (${label})` : nodeId;
}
