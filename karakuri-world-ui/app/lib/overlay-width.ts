export const OVERLAY_WIDTH_MIN_PX = 280;
export const OVERLAY_WIDTH_MAX_PX = 640;
export const OVERLAY_WIDTH_DEFAULT_PX = 580;
export const OVERLAY_WIDTH_STORAGE_KEY = 'karakuri-world-ui:agent-overlay-width';

export function clampOverlayWidth(value: number, viewportWidth?: number): number {
  const dynamicMax = typeof viewportWidth === 'number' && viewportWidth > 0
    ? Math.min(OVERLAY_WIDTH_MAX_PX, Math.floor(viewportWidth * 0.4))
    : OVERLAY_WIDTH_MAX_PX;
  const effectiveMax = Math.max(OVERLAY_WIDTH_MIN_PX, dynamicMax);

  if (!Number.isFinite(value)) {
    return OVERLAY_WIDTH_DEFAULT_PX;
  }

  return Math.min(Math.max(Math.round(value), OVERLAY_WIDTH_MIN_PX), effectiveMax);
}

export function loadOverlayWidth(storage?: Pick<Storage, 'getItem'> | null): number {
  const source = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : undefined;

  if (!source) {
    return clampOverlayWidth(OVERLAY_WIDTH_DEFAULT_PX, viewportWidth);
  }

  const raw = source.getItem(OVERLAY_WIDTH_STORAGE_KEY);
  const parsed = raw === null ? OVERLAY_WIDTH_DEFAULT_PX : Number(raw);

  return clampOverlayWidth(Number.isFinite(parsed) ? parsed : OVERLAY_WIDTH_DEFAULT_PX, viewportWidth);
}

export function saveOverlayWidth(
  value: number,
  storage?: Pick<Storage, 'setItem'> | null,
): void {
  const target = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
  if (!target) {
    return;
  }

  target.setItem(OVERLAY_WIDTH_STORAGE_KEY, String(Math.round(value)));
}
