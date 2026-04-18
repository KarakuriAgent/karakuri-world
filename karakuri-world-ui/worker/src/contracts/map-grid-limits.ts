export const MAX_SPECTATOR_MAP_ROWS = 200;
export const MAX_SPECTATOR_MAP_COLS = 200;
export const MAX_SPECTATOR_MAP_CELLS = 10_000;

export interface SpectatorMapDimensionIssue {
  message: string;
  path: ['rows'] | ['cols'] | ['nodes'];
}

export function getSpectatorMapDimensionIssue(rows: number, cols: number): SpectatorMapDimensionIssue | null {
  if (rows > MAX_SPECTATOR_MAP_ROWS) {
    return {
      message: `map.rows must be <= ${MAX_SPECTATOR_MAP_ROWS}`,
      path: ['rows'],
    };
  }

  if (cols > MAX_SPECTATOR_MAP_COLS) {
    return {
      message: `map.cols must be <= ${MAX_SPECTATOR_MAP_COLS}`,
      path: ['cols'],
    };
  }

  if (rows * cols > MAX_SPECTATOR_MAP_CELLS) {
    return {
      message: `map must contain <= ${MAX_SPECTATOR_MAP_CELLS} cells`,
      path: ['nodes'],
    };
  }

  return null;
}

export function assertSpectatorMapDimensions(rows: number, cols: number): void {
  const issue = getSpectatorMapDimensionIssue(rows, cols);

  if (issue) {
    throw new Error(issue.message);
  }
}

export function isNodeIdWithinGrid(nodeId: string, rows: number, cols: number): boolean {
  const match = /^(\d+)-(\d+)$/.exec(nodeId);

  if (!match) {
    return false;
  }

  const row = Number(match[1]);
  const col = Number(match[2]);

  return row >= 1 && row <= rows && col >= 1 && col <= cols;
}
