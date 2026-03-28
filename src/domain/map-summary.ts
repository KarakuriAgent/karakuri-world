import type { MapConfig } from '../types/data-model.js';

export function buildMapSummaryText(mapConfig: MapConfig): string {
  const buildingLines =
    mapConfig.buildings.length > 0
      ? mapConfig.buildings
          .map(
            (building) =>
              `  ${building.name} [入口: ${building.door_nodes.join(', ')}] - ${building.description}`,
          )
          .join('\n')
      : '  なし';
  const npcLines =
    mapConfig.npcs.length > 0
      ? mapConfig.npcs.map((npc) => `  ${npc.name} @ ${npc.node_id} - ${npc.description}`).join('\n')
      : '  なし';

  return [`マップ: ${mapConfig.rows}行 × ${mapConfig.cols}列`, `建物:\n${buildingLines}`, `NPC:\n${npcLines}`].join('\n\n');
}
