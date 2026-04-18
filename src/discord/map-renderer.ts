import type { MapConfig, NodeConfig } from '../types/data-model.js';
import type { MapRenderTheme } from '../types/snapshot.js';

export const MAP_RENDER_THEME: MapRenderTheme = {
  cell_size: 96,
  label_font_size: 14,
  node_id_font_size: 12,
  background_fill: '#e2e8f0',
  grid_stroke: '#94a3b8',
  default_node_fill: '#bbf7d0',
  normal_node_fill: '#f8fafc',
  wall_node_fill: '#334155',
  door_node_fill: '#b45309',
  npc_node_fill: '#fde68a',
  building_palette: ['#dbeafe', '#e9d5ff', '#fce7f3', '#fee2e2', '#dcfce7', '#e0f2fe'],
  wall_text_color: '#f8fafc',
  default_text_color: '#0f172a',
};

export function getMapRenderTheme(): MapRenderTheme {
  return {
    ...MAP_RENDER_THEME,
    building_palette: [...MAP_RENDER_THEME.building_palette],
  };
}

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
    return MAP_RENDER_THEME.background_fill;
  }
  return MAP_RENDER_THEME.building_palette[hashString(buildingId) % MAP_RENDER_THEME.building_palette.length];
}

function getNodeFill(node: NodeConfig | undefined): string {
  if (!node) {
    return MAP_RENDER_THEME.default_node_fill;
  }

  switch (node.type) {
    case 'normal':
      return MAP_RENDER_THEME.normal_node_fill;
    case 'wall':
      return MAP_RENDER_THEME.wall_node_fill;
    case 'door':
      return MAP_RENDER_THEME.door_node_fill;
    case 'building_interior':
      return getBuildingFill(node.building_id);
    case 'npc':
      return MAP_RENDER_THEME.npc_node_fill;
  }
}

function getNodeTextColor(node: NodeConfig | undefined): string {
  if (node?.type === 'wall') {
    return MAP_RENDER_THEME.wall_text_color;
  }
  return MAP_RENDER_THEME.default_text_color;
}

export function generateMapSvg(map: MapConfig): string {
  const width = map.cols * MAP_RENDER_THEME.cell_size;
  const height = map.rows * MAP_RENDER_THEME.cell_size;
  const labels: string[] = [];
  const cells: string[] = [];

  for (let row = 1; row <= map.rows; row++) {
    for (let col = 1; col <= map.cols; col++) {
      const nodeId = `${row}-${col}` as const;
      const node = map.nodes[nodeId];
      const x = (col - 1) * MAP_RENDER_THEME.cell_size;
      const y = (row - 1) * MAP_RENDER_THEME.cell_size;
      const fill = getNodeFill(node);
      const textColor = getNodeTextColor(node);

      cells.push(
        `<rect x="${x}" y="${y}" width="${MAP_RENDER_THEME.cell_size}" height="${MAP_RENDER_THEME.cell_size}" fill="${fill}" stroke="${MAP_RENDER_THEME.grid_stroke}" stroke-width="1" />`,
      );
      cells.push(
        `<text x="${x + 8}" y="${y + 18}" font-size="${MAP_RENDER_THEME.node_id_font_size}" font-family="Arial, sans-serif" fill="${textColor}">${nodeId}</text>`,
      );

      if (node?.label) {
        const escapedLabel = escapeXml(node.label);
        labels.push(
          `<text x="${x + MAP_RENDER_THEME.cell_size / 2}" y="${y + MAP_RENDER_THEME.cell_size / 2}" font-size="${MAP_RENDER_THEME.label_font_size}" font-family="Arial, sans-serif" fill="${textColor}" text-anchor="middle" dominant-baseline="middle">${escapedLabel}</text>`,
        );
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${MAP_RENDER_THEME.background_fill}" />`,
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
      value: Math.max(map.cols * MAP_RENDER_THEME.cell_size, 1),
    },
  });
  return Buffer.from(resvg.render().asPng());
}
