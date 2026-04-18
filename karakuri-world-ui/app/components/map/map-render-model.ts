import type {
  SpectatorNodeConfig,
  SpectatorSnapshot,
} from '../../../worker/src/contracts/spectator-snapshot.js';
import type { MapRenderTheme } from '../../../worker/src/contracts/world-snapshot.js';

export interface MapNodeLayout {
  nodeId: string;
  row: number;
  col: number;
  size: number;
  x: number;
  y: number;
  centerX: number;
  centerY: number;
}

export interface MapTextRenderModel {
  text: string;
  x: number;
  y: number;
  color: string;
  fontSize: number;
  anchor?: number;
}

export interface MapCellRenderModel extends MapNodeLayout {
  fill: string;
  stroke: string;
  textColor: string;
  nodeIdLabel: MapTextRenderModel;
  centerLabel?: MapTextRenderModel;
}

export interface MapRenderModel {
  width: number;
  height: number;
  backgroundFill: string;
  cells: MapCellRenderModel[];
}

export type StaticMapRenderInputs = Pick<SpectatorSnapshot, 'map' | 'map_render_theme'>;

const NODE_ID_OFFSET_X = 8;
const NODE_ID_BASELINE_OFFSET_Y = 18;
const CENTER_LABEL_ANCHOR = 0.5;

function getNodeIdLabelTopY(cellY: number, fontSize: number): number {
  return cellY + NODE_ID_BASELINE_OFFSET_Y - fontSize;
}

function hashString(value: string): number {
  let hash = 0;

  for (const char of value) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }

  return Math.abs(hash);
}

export function getBuildingPaletteColor(
  theme: MapRenderTheme,
  buildingId: string | undefined,
): string {
  if (!buildingId || theme.building_palette.length === 0) {
    return theme.background_fill;
  }

  return theme.building_palette[hashString(buildingId) % theme.building_palette.length]!;
}

export function getNodeFillColor(
  theme: MapRenderTheme,
  node: SpectatorNodeConfig | undefined,
): string {
  if (!node) {
    return theme.default_node_fill;
  }

  switch (node.type) {
    case 'normal':
      return theme.normal_node_fill;
    case 'wall':
      return theme.wall_node_fill;
    case 'door':
      return theme.door_node_fill;
    case 'building_interior':
      return getBuildingPaletteColor(theme, node.building_id);
    case 'npc':
      return theme.npc_node_fill;
  }
}

export function getNodeTextColor(
  theme: MapRenderTheme,
  node: SpectatorNodeConfig | undefined,
): string {
  if (node?.type === 'wall') {
    return theme.wall_text_color;
  }

  return theme.default_text_color;
}

export function getNodeLayout(
  snapshot: StaticMapRenderInputs,
  nodeId: string,
): MapNodeLayout | undefined {
  const match = /^(\d+)-(\d+)$/.exec(nodeId);

  if (!match) {
    return undefined;
  }

  const row = Number.parseInt(match[1] ?? '', 10);
  const col = Number.parseInt(match[2] ?? '', 10);

  if (
    !Number.isInteger(row) ||
    !Number.isInteger(col) ||
    row < 1 ||
    row > snapshot.map.rows ||
    col < 1 ||
    col > snapshot.map.cols
  ) {
    return undefined;
  }

  const size = snapshot.map_render_theme.cell_size;
  const x = (col - 1) * size;
  const y = (row - 1) * size;

  return {
    nodeId,
    row,
    col,
    size,
    x,
    y,
    centerX: x + size / 2,
    centerY: y + size / 2,
  };
}

export function getNodeCenter(
  snapshot: StaticMapRenderInputs,
  nodeId: string,
): {
  centerX: number;
  centerY: number;
} | undefined {
  const layout = getNodeLayout(snapshot, nodeId);

  if (!layout) {
    return undefined;
  }

  return {
    centerX: layout.centerX,
    centerY: layout.centerY,
  };
}

export function buildMapRenderModel(snapshot: StaticMapRenderInputs): MapRenderModel {
  const { map, map_render_theme: theme } = snapshot;
  const cells: MapCellRenderModel[] = [];

  for (let row = 1; row <= map.rows; row += 1) {
    for (let col = 1; col <= map.cols; col += 1) {
      const nodeId = `${row}-${col}` as `${number}-${number}`;
      const layout = getNodeLayout(snapshot, nodeId)!;
      const node = map.nodes[nodeId];
      const textColor = getNodeTextColor(theme, node);

      cells.push({
        ...layout,
        fill: getNodeFillColor(theme, node),
        stroke: theme.grid_stroke,
        textColor,
        nodeIdLabel: {
          text: nodeId,
          x: layout.x + NODE_ID_OFFSET_X,
          y: getNodeIdLabelTopY(layout.y, theme.node_id_font_size),
          color: textColor,
          fontSize: theme.node_id_font_size,
        },
        ...(node?.label
          ? {
              centerLabel: {
                text: node.label,
                x: layout.centerX,
                y: layout.centerY,
                color: textColor,
                fontSize: theme.label_font_size,
                anchor: CENTER_LABEL_ANCHOR,
              },
            }
          : {}),
      });
    }
  }

  return {
    width: map.cols * theme.cell_size,
    height: map.rows * theme.cell_size,
    backgroundFill: theme.background_fill,
    cells,
  };
}
