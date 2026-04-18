import { Application, extend } from '@pixi/react';
import { Container, Graphics, Sprite, Text, TextStyle } from 'pixi.js';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SpectatorSnapshot } from '../../../worker/src/contracts/spectator-snapshot.js';
import { animateViewportToSelection, getWorldDimensions } from './map-viewport.js';
import {
  buildAgentRenderTargets,
  buildSelectionRingModels,
  findSelectedGroupNodeId,
  type AgentAvatarRenderModel,
  type AgentGroupRenderModel,
  type AgentRenderTarget,
  type SelectionRingRenderModel,
} from './agent-render-model.js';
import {
  buildMapRenderModel,
  type MapRenderModel,
  type MapTextRenderModel,
} from './map-render-model.js';
import {
  getAvatarTextureSnapshot,
  loadAvatarTexture,
  type AvatarTextureSnapshot,
} from './avatar-texture-cache.js';
import { ActionParticlesLayer, EffectLayer } from './EffectLayer.js';
import { MapViewportHost, useMapViewport } from './MapViewportHost.js';
import type { Phase3EnvironmentEffectFlags } from './environment-effects.js';
import {
  buildMotionEffectsModel,
  hasActiveInterpolatedMotion,
  resolvePhase3MotionEffectFlags,
  type Phase3MotionEffectFlags,
} from './motion-effects.js';
import {
  createInitialMapViewState,
  type MapSelectionFocusCommand,
  type MapViewportViewState,
} from './selection-focus.js';

extend({ Container, Graphics, Sprite, Text });

const MAP_LABEL_FONT_FAMILY = 'Arial, sans-serif';
const MAP_GROUP_POPOVER_MARGIN_PX = 16;
const MAP_GROUP_POPOVER_OFFSET_PX = 24;
const MAP_GROUP_POPOVER_MIN_WIDTH_PX = 192;
const MAP_GROUP_POPOVER_ROW_HEIGHT_PX = 40;
const MAP_GROUP_POPOVER_BASE_HEIGHT_PX = 52;

export interface MapPixiCanvasProps {
  snapshot: SpectatorSnapshot;
  selectedAgentId?: string;
  phase3EffectsEnabled?: boolean;
  phase3EnvironmentEffectFlags?: Partial<Phase3EnvironmentEffectFlags>;
  phase3MotionEffectFlags?: Partial<Phase3MotionEffectFlags>;
  focusCommand?: MapSelectionFocusCommand;
  onSelectAgent?: (agentId: string) => void;
  onLiveViewStateChange?: (viewState: MapViewportViewState) => void;
  onViewStateChange?: (viewState: MapViewportViewState) => void;
}

function shouldRunPhase3AnimationClock(
  snapshot: SpectatorSnapshot,
  flags: Phase3MotionEffectFlags,
): boolean {
  if (!flags.motion && !flags.actionParticles) {
    return false;
  }

  return snapshot.agents.some(
    (agent) => flags.actionParticles && Boolean(agent.current_activity?.emoji.trim()),
  );
}

function usePhase3AnimationClock(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      setNowMs(Date.now());
      return;
    }

    let frameId = 0;
    const tick = () => {
      setNowMs(Date.now());
      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [active]);

  return nowMs;
}

function drawGrid(graphics: Graphics, renderModel: MapRenderModel) {
  graphics.clear();
  graphics.rect(0, 0, renderModel.width, renderModel.height);
  graphics.fill(renderModel.backgroundFill);

  for (const cell of renderModel.cells) {
    graphics.rect(cell.x, cell.y, cell.size, cell.size);
    graphics.fill(cell.fill);
    graphics.stroke({
      color: cell.stroke,
      width: 1,
      alpha: 0.85,
    });
  }
}

function createTextStyle(label: MapTextRenderModel): TextStyle {
  return new TextStyle({
    fill: label.color,
    fontFamily: MAP_LABEL_FONT_FAMILY,
    fontSize: label.fontSize,
  });
}

function drawAvatarPlaceholder(graphics: Graphics, avatar: AgentAvatarRenderModel) {
  graphics.clear();
  graphics.circle(avatar.centerX, avatar.centerY, avatar.size / 2);
  graphics.fill(avatar.placeholderColor);
}

function drawAvatarOutline(graphics: Graphics, avatar: AgentAvatarRenderModel) {
  graphics.clear();
  graphics.circle(avatar.centerX, avatar.centerY, avatar.size / 2);
  graphics.stroke({
    color: '#0f172a',
    width: 3,
    alpha: 0.92,
  });
}

function drawAvatarMask(graphics: Graphics, avatar: AgentAvatarRenderModel) {
  graphics.clear();
  graphics.circle(avatar.centerX, avatar.centerY, avatar.size / 2);
  graphics.fill('#ffffff');
}

function drawSelectionRing(graphics: Graphics, ring: SelectionRingRenderModel) {
  graphics.clear();
  graphics.circle(ring.centerX, ring.centerY, ring.radius);
  graphics.stroke({
    color: '#22d3ee',
    width: 4,
    alpha: 0.95,
  });
}

function drawInteractiveTarget(graphics: Graphics, avatar: AgentAvatarRenderModel) {
  graphics.clear();
  graphics.circle(avatar.centerX, avatar.centerY, avatar.size / 2 + 8);
  graphics.fill({
    color: 0xffffff,
    alpha: 0.001,
  });
}

function drawGroupBadgeBubble(graphics: Graphics, group: AgentGroupRenderModel) {
  const badgeRadius = group.visibleAvatars[0]?.size ? group.visibleAvatars[0].size * 0.18 : 10;

  graphics.clear();
  graphics.circle(group.centerX + badgeRadius * 1.2, group.centerY + badgeRadius * 1.2, badgeRadius);
  graphics.fill('#0f172a');
  graphics.stroke({
    color: '#f8fafc',
    width: 2,
    alpha: 0.9,
  });
}

function clampPopoverPosition(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

type GroupPopoverSize = {
  width: number;
  height: number;
};

export type GroupPopoverOpenState =
  | {
      nodeId: string;
      source: 'manual' | 'selection';
    }
  | undefined;

export function reconcileOpenGroupState(
  currentOpenGroup: GroupPopoverOpenState,
  agentRenderTargets: AgentRenderTarget[],
  selectedAgentId?: string,
): GroupPopoverOpenState {
  const selectedGroupNodeId = findSelectedGroupNodeId(agentRenderTargets, selectedAgentId);

  if (selectedGroupNodeId) {
    return currentOpenGroup?.nodeId === selectedGroupNodeId && currentOpenGroup.source === 'selection'
      ? currentOpenGroup
      : {
          nodeId: selectedGroupNodeId,
          source: 'selection',
        };
  }

  if (!currentOpenGroup) {
    return undefined;
  }

  const groupStillExists = agentRenderTargets.some(
    (target) => target.kind === 'group' && target.nodeId === currentOpenGroup.nodeId,
  );

  if (!groupStillExists) {
    return undefined;
  }

  return currentOpenGroup.source === 'manual' ? currentOpenGroup : undefined;
}

function getEstimatedGroupPopoverSize(
  group: AgentGroupRenderModel,
  hostSize: { width: number; height: number },
  popoverSize: GroupPopoverSize | undefined,
): GroupPopoverSize {
  const availableWidth = Math.max(hostSize.width - MAP_GROUP_POPOVER_MARGIN_PX * 2, 1);
  const availableHeight = Math.max(hostSize.height - MAP_GROUP_POPOVER_MARGIN_PX * 2, 1);
  const fallbackHeight = MAP_GROUP_POPOVER_BASE_HEIGHT_PX + group.agents.length * MAP_GROUP_POPOVER_ROW_HEIGHT_PX;

  return {
    width: Math.min(
      popoverSize?.width && popoverSize.width > 0 ? popoverSize.width : MAP_GROUP_POPOVER_MIN_WIDTH_PX,
      availableWidth,
    ),
    height: Math.min(popoverSize?.height && popoverSize.height > 0 ? popoverSize.height : fallbackHeight, availableHeight),
  };
}

export function getGroupPopoverStyle(
  group: AgentGroupRenderModel,
  hostSize: { width: number; height: number },
  viewState: MapViewportViewState | undefined,
  popoverSize?: GroupPopoverSize,
): { left: number; top: number } {
  if (!viewState || hostSize.width <= 0 || hostSize.height <= 0) {
    return {
      left: MAP_GROUP_POPOVER_MARGIN_PX,
      top: MAP_GROUP_POPOVER_MARGIN_PX,
    };
  }

  const boxSize = getEstimatedGroupPopoverSize(group, hostSize, popoverSize);
  const screenX = (group.centerX - viewState.centerX) * viewState.zoom + hostSize.width / 2;
  const screenY = (group.centerY - viewState.centerY) * viewState.zoom + hostSize.height / 2;
  const preferredTop = screenY - MAP_GROUP_POPOVER_OFFSET_PX - boxSize.height;
  const fallbackTop = screenY + MAP_GROUP_POPOVER_OFFSET_PX;
  const maxLeft = Math.max(hostSize.width - MAP_GROUP_POPOVER_MARGIN_PX - boxSize.width, MAP_GROUP_POPOVER_MARGIN_PX);
  const maxTop = Math.max(hostSize.height - MAP_GROUP_POPOVER_MARGIN_PX - boxSize.height, MAP_GROUP_POPOVER_MARGIN_PX);
  const shouldPlaceBelow =
    preferredTop < MAP_GROUP_POPOVER_MARGIN_PX &&
    (fallbackTop + boxSize.height <= hostSize.height - MAP_GROUP_POPOVER_MARGIN_PX || screenY <= hostSize.height / 2);

  return {
    left: clampPopoverPosition(screenX - boxSize.width / 2, MAP_GROUP_POPOVER_MARGIN_PX, maxLeft),
    top: clampPopoverPosition(
      shouldPlaceBelow ? fallbackTop : preferredTop,
      MAP_GROUP_POPOVER_MARGIN_PX,
      maxTop,
    ),
  };
}

function getGroupPopoverMaxHeight(
  hostSize: { width: number; height: number },
  popoverStyle: { left: number; top: number } | undefined,
): number | undefined {
  if (!popoverStyle || hostSize.height <= 0) {
    return undefined;
  }

  return Math.max(hostSize.height - popoverStyle.top - MAP_GROUP_POPOVER_MARGIN_PX, 1);
}

interface LabelTextSpriteModel extends MapTextRenderModel {
  key: string;
  style: TextStyle;
}

export function buildLabelTextSpriteModels(renderModel: MapRenderModel): LabelTextSpriteModel[] {
  const labels: LabelTextSpriteModel[] = [];

  for (const cell of renderModel.cells) {
    labels.push({
      ...cell.nodeIdLabel,
      key: cell.nodeId + '-node-id',
      style: createTextStyle(cell.nodeIdLabel),
    });

    if (cell.centerLabel) {
      labels.push({
        ...cell.centerLabel,
        key: cell.nodeId + '-label',
        style: createTextStyle(cell.centerLabel),
      });
    }
  }

  return labels;
}

const GridLayer = memo(function GridLayer({
  renderModel,
}: {
  renderModel: MapRenderModel;
}) {
  return <pixiGraphics draw={(graphics) => drawGrid(graphics, renderModel)} />;
});

const LabelLayer = memo(function LabelLayer({
  renderModel,
}: {
  renderModel: MapRenderModel;
}) {
  const labelTextSprites = useMemo(
    () => buildLabelTextSpriteModels(renderModel),
    [renderModel],
  );

  return (
    <>
      {labelTextSprites.map((label) => (
        <pixiText
          key={label.key}
          anchor={label.anchor}
          style={label.style}
          text={label.text}
          x={label.x}
          y={label.y}
        />
      ))}
    </>
  );
});

function MapSelectionViewportBridge({
  focusCommand,
}: {
  focusCommand?: MapSelectionFocusCommand;
}) {
  const viewport = useMapViewport();

  useEffect(() => {
    if (!viewport || !focusCommand) {
      return;
    }

    animateViewportToSelection(viewport, focusCommand);
  }, [focusCommand, viewport]);

  return null;
}

const AgentAvatarVisual = memo(function AgentAvatarVisual({ avatar }: { avatar: AgentAvatarRenderModel }) {
  const [textureSnapshot, setTextureSnapshot] = useState<AvatarTextureSnapshot>(() =>
    getAvatarTextureSnapshot(avatar.avatarUrl),
  );
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [maskGraphic, setMaskGraphic] = useState<Graphics | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!avatar.avatarUrl) {
      setTextureSnapshot({ status: 'idle' });
      return;
    }

    setTextureSnapshot(getAvatarTextureSnapshot(avatar.avatarUrl));

    void loadAvatarTexture(avatar.avatarUrl)
      .then((texture) => {
        if (!cancelled) {
          setTextureSnapshot({ status: 'ready', texture });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          const cachedSnapshot = getAvatarTextureSnapshot(avatar.avatarUrl);
          setTextureSnapshot(
            cachedSnapshot.status === 'error'
              ? cachedSnapshot
              : {
                  status: 'error',
                  error: error instanceof Error ? error : new Error(String(error)),
                },
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [avatar.avatarUrl, retryAttempt]);

  useEffect(() => {
    if (!avatar.avatarUrl || textureSnapshot.status !== 'error' || typeof textureSnapshot.retryAfterMs !== 'number') {
      return;
    }

    const retryDelay = Math.max(textureSnapshot.retryAfterMs - Date.now(), 0);
    const timeoutId = window.setTimeout(() => {
      setRetryAttempt((currentAttempt) => currentAttempt + 1);
    }, retryDelay);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [avatar.avatarUrl, textureSnapshot.retryAfterMs, textureSnapshot.status]);

  const texture = textureSnapshot.status === 'ready' ? textureSnapshot.texture : undefined;
  const handleMaskRef = useCallback((graphic: Graphics | null) => {
    setMaskGraphic((currentGraphic) => (currentGraphic === graphic ? currentGraphic : graphic));
  }, []);
  const placeholderTextStyle = useMemo(
    () =>
      new TextStyle({
        fill: '#f8fafc',
        fontFamily: MAP_LABEL_FONT_FAMILY,
        fontSize: Math.max(avatar.size * 0.42, 14),
        fontWeight: '700',
      }),
    [avatar.size],
  );
  const statusTextStyle = useMemo(
    () =>
      new TextStyle({
        fontFamily: 'Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif',
        fontSize: avatar.statusFontSize,
      }),
    [avatar.statusFontSize],
  );

  return (
    <pixiContainer>
      {texture ? (
        <>
          <pixiGraphics
            ref={handleMaskRef}
            data-testid={'map-agent-avatar-mask-' + avatar.agentId}
            draw={(graphics) => drawAvatarMask(graphics, avatar)}
          />
          <pixiSprite
            anchor={0.5}
            data-testid={'map-agent-avatar-sprite-' + avatar.agentId}
            height={avatar.size}
            mask={maskGraphic ?? undefined}
            texture={texture}
            width={avatar.size}
            x={avatar.centerX}
            y={avatar.centerY}
          />
        </>
      ) : (
        <>
          <pixiGraphics
            data-testid={'map-agent-avatar-fallback-' + avatar.agentId}
            draw={(graphics) => drawAvatarPlaceholder(graphics, avatar)}
          />
          <pixiText
            anchor={0.5}
            style={placeholderTextStyle}
            text={avatar.fallbackLabel}
            x={avatar.centerX}
            y={avatar.centerY}
          />
        </>
      )}
      <pixiGraphics draw={(graphics) => drawAvatarOutline(graphics, avatar)} />
      <pixiText
        anchor={0.5}
        style={statusTextStyle}
        text={avatar.statusEmoji}
        x={avatar.centerX + avatar.size * 0.28}
        y={avatar.centerY - avatar.size * 0.28}
      />
    </pixiContainer>
  );
});

function GroupBadge({ group }: { group: AgentGroupRenderModel }) {
  const badgeTextStyle = useMemo(
    () =>
      new TextStyle({
        fill: '#f8fafc',
        fontFamily: MAP_LABEL_FONT_FAMILY,
        fontSize: group.badgeFontSize,
        fontWeight: '700',
      }),
    [group.badgeFontSize],
  );

  return (
    <>
      <pixiGraphics draw={(graphics) => drawGroupBadgeBubble(graphics, group)} />
      <pixiText
        anchor={0.5}
        style={badgeTextStyle}
        text={String(group.count)}
        x={group.centerX + group.visibleAvatars[0]!.size * 0.216}
        y={group.centerY + group.visibleAvatars[0]!.size * 0.216}
      />
    </>
  );
}

const AgentLayer = memo(function AgentLayer({
  targets,
  onSelectAgent,
  onToggleGroup,
}: {
  targets: AgentRenderTarget[];
  onSelectAgent?: (agentId: string) => void;
  onToggleGroup: (nodeId: string) => void;
}) {
  return (
    <>
      {targets.map((target) => {
        if (target.kind === 'single') {
          return (
            <pixiContainer
              key={target.key}
              cursor="pointer"
              data-testid={'map-agent-target-' + target.agent.agentId}
              eventMode="static"
              onPointerTap={() => onSelectAgent?.(target.agent.agentId)}
            >
              <pixiGraphics draw={(graphics) => drawInteractiveTarget(graphics, target.agent)} />
              <AgentAvatarVisual avatar={target.agent} />
            </pixiContainer>
          );
        }

        return (
          <pixiContainer
            key={target.key}
            cursor="pointer"
            data-testid={'map-agent-group-' + target.nodeId}
            eventMode="static"
            onPointerTap={() => onToggleGroup(target.nodeId)}
          >
            {target.visibleAvatars.map((avatar) => (
              <pixiContainer key={avatar.agentId}>
                <pixiGraphics draw={(graphics) => drawInteractiveTarget(graphics, avatar)} />
                <AgentAvatarVisual avatar={avatar} />
              </pixiContainer>
            ))}
            <GroupBadge group={target} />
          </pixiContainer>
        );
      })}
    </>
  );
});

const SelectionLayer = memo(function SelectionLayer({
  rings,
}: {
  rings: SelectionRingRenderModel[];
}) {
  return (
    <>
      {rings.map((ring) => (
        <pixiGraphics
          key={'selection-' + ring.agentId}
          data-testid={'map-selection-ring-' + ring.agentId}
          draw={(graphics) => drawSelectionRing(graphics, ring)}
        />
      ))}
    </>
  );
});

export function MapPixiCanvas({
  snapshot,
  selectedAgentId,
  phase3EffectsEnabled = false,
  phase3EnvironmentEffectFlags,
  phase3MotionEffectFlags,
  focusCommand,
  onSelectAgent,
  onLiveViewStateChange,
  onViewStateChange,
}: MapPixiCanvasProps) {
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const worldDimensions = getWorldDimensions(snapshot);
  const renderModel = useMemo(
    () =>
      buildMapRenderModel({
        map: snapshot.map,
        map_render_theme: snapshot.map_render_theme,
      }),
    [snapshot.map, snapshot.map_render_theme],
  );
  const resolvedMotionFlags = useMemo(
    () => resolvePhase3MotionEffectFlags(phase3EffectsEnabled, phase3MotionEffectFlags),
    [phase3EffectsEnabled, phase3MotionEffectFlags?.actionParticles, phase3MotionEffectFlags?.motion],
  );
  const currentPhase3NowMs = Date.now();
  const phase3NowMs = usePhase3AnimationClock(
    hasActiveInterpolatedMotion(snapshot, resolvedMotionFlags, currentPhase3NowMs) ||
      shouldRunPhase3AnimationClock(snapshot, resolvedMotionFlags),
  );
  const motionEffectsModel = useMemo(
    () => buildMotionEffectsModel(snapshot, resolvedMotionFlags, phase3NowMs),
    [phase3NowMs, resolvedMotionFlags, snapshot],
  );
  const agentRenderTargets = useMemo(
    () => buildAgentRenderTargets(snapshot, selectedAgentId, motionEffectsModel.agentPositions),
    [motionEffectsModel.agentPositions, selectedAgentId, snapshot],
  );
  const selectionRingModels = useMemo(
    () => buildSelectionRingModels(agentRenderTargets),
    [agentRenderTargets],
  );
  const [openGroupState, setOpenGroupState] = useState<GroupPopoverOpenState>(undefined);
  const mapGeometryKey =
    String(snapshot.map.rows) + ':' + String(snapshot.map.cols) + ':' + String(snapshot.map_render_theme.cell_size);
  const [viewportViewState, setViewportViewState] = useState<MapViewportViewState | undefined>(() =>
    createInitialMapViewState(snapshot),
  );
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  const [groupPopoverSize, setGroupPopoverSize] = useState<GroupPopoverSize>({ width: 0, height: 0 });
  const groupPopoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setViewportViewState(createInitialMapViewState(snapshot));
  }, [mapGeometryKey]);

  useEffect(() => {
    setOpenGroupState((currentOpenGroup) =>
      reconcileOpenGroupState(currentOpenGroup, agentRenderTargets, selectedAgentId),
    );
  }, [agentRenderTargets, selectedAgentId]);
  const openGroupNodeId = openGroupState?.nodeId;

  useEffect(() => {
    const element = canvasHostRef.current;

    if (!element) {
      return;
    }

    const updateSize = () => {
      setHostSize({
        width: element.clientWidth,
        height: element.clientHeight,
      });
    };

    updateSize();
    window.addEventListener('resize', updateSize);

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => updateSize()) : undefined;
    resizeObserver?.observe(element);

    return () => {
      window.removeEventListener('resize', updateSize);
      resizeObserver?.disconnect();
    };
  }, []);
  const openGroup = useMemo(
    () =>
      agentRenderTargets.find(
        (target): target is AgentGroupRenderModel => target.kind === 'group' && target.nodeId === openGroupNodeId,
      ),
    [agentRenderTargets, openGroupNodeId],
  );

  useEffect(() => {
    const element = groupPopoverRef.current;

    if (!openGroup || !element) {
      setGroupPopoverSize({ width: 0, height: 0 });
      return;
    }

    const updateSize = () => {
      setGroupPopoverSize({
        width: element.offsetWidth,
        height: element.offsetHeight,
      });
    };

    updateSize();

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => updateSize()) : undefined;
    resizeObserver?.observe(element);

    return () => {
      resizeObserver?.disconnect();
    };
  }, [hostSize.height, hostSize.width, openGroup, selectedAgentId]);

  const handleSelectAgent = useCallback(
    (agentId: string) => {
      setOpenGroupState(undefined);
      onSelectAgent?.(agentId);
    },
    [onSelectAgent],
  );
  const handleToggleGroup = useCallback((nodeId: string) => {
    setOpenGroupState((currentOpenGroup) =>
      currentOpenGroup?.nodeId === nodeId
        ? undefined
        : {
            nodeId,
            source: 'manual',
          },
    );
  }, []);
  const handleLiveViewStateChange = useCallback(
    (viewState: MapViewportViewState) => {
      setViewportViewState(viewState);
      onLiveViewStateChange?.(viewState);
    },
    [onLiveViewStateChange],
  );
  const handleViewStateChange = useCallback(
    (viewState: MapViewportViewState) => {
      setViewportViewState(viewState);
      onViewStateChange?.(viewState);
    },
    [onViewStateChange],
  );
  const groupPopoverStyle = openGroup
    ? getGroupPopoverStyle(openGroup, hostSize, viewportViewState, groupPopoverSize)
    : undefined;
  const groupPopoverSurfaceStyle = useMemo(() => {
    const availableWidth = Math.max(hostSize.width - MAP_GROUP_POPOVER_MARGIN_PX * 2, 0);
    const maxHeight = getGroupPopoverMaxHeight(hostSize, groupPopoverStyle);
    const style: {
      maxHeight?: number;
      maxWidth?: number;
      minWidth?: number;
    } = {};

    if (typeof maxHeight === 'number') {
      style.maxHeight = maxHeight;
    }

    if (availableWidth > 0) {
      style.maxWidth = availableWidth;
      style.minWidth = Math.min(MAP_GROUP_POPOVER_MIN_WIDTH_PX, availableWidth);
    }

    return Object.keys(style).length > 0 ? style : undefined;
  }, [groupPopoverStyle, hostSize.height, hostSize.width]);

  return (
    <div
      ref={canvasHostRef}
      className="relative h-full w-full"
      data-testid="map-pixi-shell"
      style={{ backgroundColor: snapshot.map_render_theme.background_fill }}
    >
      <Application
        antialias
        autoDensity
        backgroundAlpha={0}
        resizeTo={canvasHostRef}
        sharedTicker={false}
      >
        <MapViewportHost
          worldWidth={worldDimensions.worldWidth}
          worldHeight={worldDimensions.worldHeight}
          onLiveViewStateChange={handleLiveViewStateChange}
          onViewStateChange={handleViewStateChange}
        >
          <MapSelectionViewportBridge focusCommand={focusCommand} />
          <pixiContainer data-testid="map-render-layers">
            <pixiContainer data-testid="map-grid-layer">
              <GridLayer renderModel={renderModel} />
            </pixiContainer>
            <pixiContainer data-testid="map-label-layer">
              <LabelLayer renderModel={renderModel} />
            </pixiContainer>
            <pixiContainer data-testid="map-agent-layer">
              <AgentLayer
                onSelectAgent={handleSelectAgent}
                onToggleGroup={handleToggleGroup}
                targets={agentRenderTargets}
              />
            </pixiContainer>
            <pixiContainer data-testid="map-selection-layer">
              <SelectionLayer rings={selectionRingModels} />
            </pixiContainer>
            <pixiContainer data-testid="map-effect-layer">
              <EffectLayer
                enabled={phase3EffectsEnabled}
                flags={phase3EnvironmentEffectFlags}
                snapshot={snapshot}
              />
              <ActionParticlesLayer actionParticles={motionEffectsModel.actionParticles} />
            </pixiContainer>
          </pixiContainer>
        </MapViewportHost>
      </Application>

      {openGroup && groupPopoverStyle ? (
        <div
          className="pointer-events-none absolute z-20"
          style={{
            left: groupPopoverStyle.left,
            top: groupPopoverStyle.top,
          }}
        >
          <div
            ref={groupPopoverRef}
            className="pointer-events-auto flex flex-col overflow-hidden rounded-2xl border border-cyan-400/30 bg-slate-950/95 p-2 shadow-2xl backdrop-blur"
            data-testid={'map-group-popover-' + openGroup.nodeId}
            style={groupPopoverSurfaceStyle}
          >
            <div className="px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">
              {openGroup.nodeId}
            </div>
            <div
              className="space-y-1 overflow-y-auto pr-1"
              data-testid={'map-group-popover-list-' + openGroup.nodeId}
            >
              {openGroup.agents.map((agent) => (
                <button
                  key={agent.agent_id}
                  type="button"
                  className={
                    'flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors ' +
                    (selectedAgentId === agent.agent_id
                      ? 'bg-cyan-400/15 text-cyan-100'
                      : 'text-slate-100 hover:bg-slate-900')
                  }
                  aria-pressed={selectedAgentId === agent.agent_id}
                  data-testid={'map-group-agent-button-' + agent.agent_id}
                  onClick={() => handleSelectAgent(agent.agent_id)}
                >
                  <span className="truncate font-medium">{agent.agent_name}</span>
                  <span className="shrink-0">{agent.status_emoji}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
