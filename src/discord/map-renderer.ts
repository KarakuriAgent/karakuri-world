import type { MapConfig, NodeConfig } from '../types/data-model.js';

const CELL_SIZE = 96;
const LABEL_FONT_SIZE = 14;
const GRID_STROKE = '#94a3b8';
const DEFAULT_NODE_FILL = '#bbf7d0';
const NORMAL_NODE_FILL = '#f8fafc';
const WALL_NODE_FILL = '#334155';
const DOOR_NODE_FILL = '#b45309';
const NPC_NODE_FILL = '#fde68a';
const BUILDING_PALETTE = ['#dbeafe', '#e9d5ff', '#fce7f3', '#fee2e2', '#dcfce7', '#e0f2fe'];

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function hashString(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash);
}

function getBuildingFill(buildingId: string | undefined): string {
  if (!buildingId) {
    return '#e2e8f0';
  }
  return BUILDING_PALETTE[hashString(buildingId) % BUILDING_PALETTE.length];
}

function getNodeFill(node: NodeConfig | undefined): string {
  if (!node) {
    return DEFAULT_NODE_FILL;
  }

  switch (node.type) {
    case 'normal':
      return NORMAL_NODE_FILL;
    case 'wall':
      return WALL_NODE_FILL;
    case 'door':
      return DOOR_NODE_FILL;
    case 'building_interior':
      return getBuildingFill(node.building_id);
    case 'npc':
      return NPC_NODE_FILL;
  }
}

function getNodeTextColor(node: NodeConfig | undefined): string {
  if (node?.type === 'wall') {
    return '#f8fafc';
  }
  return '#0f172a';
}

export function generateMapSvg(map: MapConfig): string {
  const width = map.cols * CELL_SIZE;
  const height = map.rows * CELL_SIZE;
  const labels: string[] = [];
  const cells: string[] = [];

  for (let row = 1; row <= map.rows; row++) {
    for (let col = 1; col <= map.cols; col++) {
      const nodeId = `${row}-${col}` as const;
      const node = map.nodes[nodeId];
      const x = (col - 1) * CELL_SIZE;
      const y = (row - 1) * CELL_SIZE;
      const fill = getNodeFill(node);
      const textColor = getNodeTextColor(node);

      cells.push(`<rect x="${x}" y="${y}" width="${CELL_SIZE}" height="${CELL_SIZE}" fill="${fill}" stroke="${GRID_STROKE}" stroke-width="1" />`);
      cells.push(`<text x="${x + 8}" y="${y + 18}" font-size="12" font-family="Arial, sans-serif" fill="${textColor}">${nodeId}</text>`);

      if (node?.label) {
        const escapedLabel = escapeXml(node.label);
        labels.push(
          `<text x="${x + CELL_SIZE / 2}" y="${y + CELL_SIZE / 2}" font-size="${LABEL_FONT_SIZE}" font-family="Arial, sans-serif" fill="${textColor}" text-anchor="middle" dominant-baseline="middle">${escapedLabel}</text>`,
        );
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="#e2e8f0" />`,
    ...cells,
    ...labels,
    '</svg>',
  ].join('');
}

export async function renderMapImage(map: MapConfig): Promise<Buffer> {
  const { Resvg } = await import('@resvg/resvg-js');
  const svg = generateMapSvg(map);
  const resvg = new Resvg(svg, {
    fitTo: {
      mode: 'width',
      value: Math.max(map.cols * CELL_SIZE, 1),
    },
  });
  return Buffer.from(resvg.render().asPng());
}
