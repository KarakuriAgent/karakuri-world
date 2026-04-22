import { createStore, type StoreApi } from 'zustand/vanilla';

import {
  agentHistoryDocumentSchema,
  coerceAgentHistoryDocument,
  coerceConversationHistoryDocument,
  conversationHistoryDocumentSchema,
  dedupeHistoryEntriesByEventId,
  historyAgentObjectKey,
  historyConversationObjectKey,
  sortHistoryEntriesByOccurredAtDesc,
  type HistoryEntry,
  type HistoryResponse,
} from '../../worker/src/contracts/history-document.js';
import { spectatorSnapshotSchema } from '../../worker/src/contracts/snapshot-serializer.js';
import type {
  SpectatorBuildingConfig,
  SpectatorMapSnapshot,
  SpectatorNodeConfig,
  SpectatorNpcConfig,
  SpectatorSnapshot,
} from '../../worker/src/contracts/spectator-snapshot.js';
import type { AppEnv } from '../env-contract.js';

export type HistoryScopeKey = `agent:${string}` | `conversation:${string}`;
export type HistoryScope = { agent_id: string } | { conversation_id: string };

export type HistoryCacheEntry =
  | { status: 'idle' }
  | { status: 'loading'; response?: HistoryResponse; last_fetched_at?: number }
  | { status: 'ready'; response: HistoryResponse; last_fetched_at: number }
  | {
      status: 'error';
      response?: HistoryResponse;
      last_fetched_at?: number;
      error_at: number;
    };

export type SnapshotStatus = 'idle' | 'loading' | 'ready' | 'error' | 'incompatible';
export type MobileSheetMode = 'list' | 'detail';

export interface SnapshotStoreState {
  snapshot_url: string;
  auth_mode: AppEnv['authMode'];
  snapshot?: SpectatorSnapshot;
  snapshot_status: SnapshotStatus;
  last_success_at?: number;
  last_error_at?: number;
  is_stale: boolean;
  selected_agent_id?: string;
  selected_agent_revision: number;
  setSelectedAgentId: (agentId?: string) => void;
  history_cache: Record<HistoryScopeKey, HistoryCacheEntry | undefined>;
  fetchHistory: (scope: HistoryScope) => Promise<void>;
  expanded_conversation_ids: Record<string, boolean | undefined>;
  toggleConversationExpanded: (conversationId: string, expanded?: boolean) => void;
  mobile_sheet_mode: MobileSheetMode;
  setMobileSheetMode: (mode: MobileSheetMode) => void;
  poll: () => Promise<void>;
  startPolling: () => Promise<void>;
  stopPolling: () => void;
}

export interface CreateSnapshotStoreOptions {
  snapshotUrl: string;
  authMode: AppEnv['authMode'];
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  fetchTimeoutMs?: number;
  staleAfterMs?: number;
  initialSnapshot?: SpectatorSnapshot;
  initialStatus?: SnapshotStatus;
  initialSelectedAgentId?: string;
}

export type SnapshotStoreApi = StoreApi<SnapshotStoreState>;

interface SnapshotVersion {
  generated_at: number;
  published_at: number;
  last_publish_error_at?: number;
}

class SnapshotIncompatibleError extends Error {}
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const POLL_STOP_ABORT_REASON = 'snapshot-poll-stopped';
const POLL_TIMEOUT_ABORT_REASON = 'snapshot-poll-timeout';
const HISTORY_ABORT_REASON = 'history-request-replaced';
const HISTORY_STOP_ABORT_REASON = 'history-polling-stopped';

export function toHistoryScopeKey(scope: HistoryScope): HistoryScopeKey {
  return 'agent_id' in scope ? `agent:${scope.agent_id}` : `conversation:${scope.conversation_id}`;
}

export function buildAuthModeRequestInit(authMode: AppEnv['authMode']): RequestInit {
  return authMode === 'access' ? { credentials: 'include' } : {};
}

export function compareSnapshotVersion(left: SnapshotVersion, right: SnapshotVersion): number {
  if (left.generated_at !== right.generated_at) {
    return left.generated_at - right.generated_at;
  }

  if (left.published_at !== right.published_at) {
    return left.published_at - right.published_at;
  }

  return (left.last_publish_error_at ?? 0) - (right.last_publish_error_at ?? 0);
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function areNodeConfigsEqual(left: SpectatorNodeConfig | undefined, right: SpectatorNodeConfig | undefined): boolean {
  if (!left || !right) {
    return left === right;
  }

  return (
    left.type === right.type &&
    left.label === right.label &&
    left.building_id === right.building_id &&
    left.npc_id === right.npc_id
  );
}

function areBuildingConfigsEqual(left: SpectatorBuildingConfig, right: SpectatorBuildingConfig): boolean {
  return (
    left.building_id === right.building_id &&
    left.name === right.name &&
    left.description === right.description &&
    areStringArraysEqual(left.wall_nodes, right.wall_nodes) &&
    areStringArraysEqual(left.interior_nodes, right.interior_nodes) &&
    areStringArraysEqual(left.door_nodes, right.door_nodes)
  );
}

function areNpcConfigsEqual(left: SpectatorNpcConfig, right: SpectatorNpcConfig): boolean {
  return (
    left.npc_id === right.npc_id &&
    left.name === right.name &&
    left.description === right.description &&
    left.node_id === right.node_id
  );
}

function areMapsEqual(left: SpectatorMapSnapshot, right: SpectatorMapSnapshot): boolean {
  if (left.rows !== right.rows || left.cols !== right.cols) {
    return false;
  }

  const leftNodeIds = Object.keys(left.nodes) as Array<keyof SpectatorMapSnapshot['nodes']>;
  const rightNodeIds = Object.keys(right.nodes) as Array<keyof SpectatorMapSnapshot['nodes']>;
  if (leftNodeIds.length !== rightNodeIds.length) {
    return false;
  }

  for (const nodeId of leftNodeIds) {
    if (!areNodeConfigsEqual(left.nodes[nodeId], right.nodes[nodeId])) {
      return false;
    }
  }

  if (left.buildings.length !== right.buildings.length || left.npcs.length !== right.npcs.length) {
    return false;
  }

  for (let index = 0; index < left.buildings.length; index += 1) {
    if (!areBuildingConfigsEqual(left.buildings[index]!, right.buildings[index]!)) {
      return false;
    }
  }

  for (let index = 0; index < left.npcs.length; index += 1) {
    if (!areNpcConfigsEqual(left.npcs[index]!, right.npcs[index]!)) {
      return false;
    }
  }

  return true;
}

function areMapThemesEqual(left: SpectatorSnapshot['map_render_theme'], right: SpectatorSnapshot['map_render_theme']): boolean {
  return (
    left.cell_size === right.cell_size &&
    left.label_font_size === right.label_font_size &&
    left.node_id_font_size === right.node_id_font_size &&
    left.background_fill === right.background_fill &&
    left.grid_stroke === right.grid_stroke &&
    left.default_node_fill === right.default_node_fill &&
    left.normal_node_fill === right.normal_node_fill &&
    left.wall_node_fill === right.wall_node_fill &&
    left.door_node_fill === right.door_node_fill &&
    left.npc_node_fill === right.npc_node_fill &&
    left.wall_text_color === right.wall_text_color &&
    left.default_text_color === right.default_text_color &&
    areStringArraysEqual(left.building_palette, right.building_palette)
  );
}

function preserveStaticSnapshotReferences(
  previousSnapshot: SpectatorSnapshot | undefined,
  nextSnapshot: SpectatorSnapshot,
): SpectatorSnapshot {
  if (!previousSnapshot) {
    return nextSnapshot;
  }

  const nextMap = areMapsEqual(previousSnapshot.map, nextSnapshot.map) ? previousSnapshot.map : nextSnapshot.map;
  const nextMapRenderTheme = areMapThemesEqual(previousSnapshot.map_render_theme, nextSnapshot.map_render_theme)
    ? previousSnapshot.map_render_theme
    : nextSnapshot.map_render_theme;

  if (nextMap === nextSnapshot.map && nextMapRenderTheme === nextSnapshot.map_render_theme) {
    return nextSnapshot;
  }

  return {
    ...nextSnapshot,
    map: nextMap,
    map_render_theme: nextMapRenderTheme,
  };
}

function isSchemaIncompatible(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (!('schema_version' in value)) {
    return false;
  }

  return value.schema_version !== 1;
}

function snapshotHasAgent(snapshot: SpectatorSnapshot, agentId?: string): boolean {
  return agentId ? snapshot.agents.some((agent) => agent.agent_id === agentId) : false;
}

function resolveMobileSheetModeOnSelection(
  agentId: string | undefined,
  currentMode: MobileSheetMode,
): MobileSheetMode {
  if (agentId) {
    return 'detail';
  }
  if (currentMode === 'detail') {
    return 'list';
  }
  return currentMode;
}

function reconcileSelectionState(
  snapshot: SpectatorSnapshot,
  state: Pick<SnapshotStoreState, 'selected_agent_id' | 'mobile_sheet_mode'>,
): Partial<Pick<SnapshotStoreState, 'selected_agent_id' | 'mobile_sheet_mode'>> {
  if (!snapshotHasAgent(snapshot, state.selected_agent_id)) {
    if (!state.selected_agent_id) {
      return state.mobile_sheet_mode === 'detail' ? { mobile_sheet_mode: 'list' } : {};
    }

    return {
      selected_agent_id: undefined,
      ...(state.mobile_sheet_mode === 'detail' ? { mobile_sheet_mode: 'list' } : {}),
    };
  }

  return {};
}

function deriveHistoryBaseUrl(snapshotUrl: string): string {
  return new URL(snapshotUrl).origin;
}

function buildHistoryObjectUrl(historyBaseUrl: string, scope: HistoryScope): string {
  const objectKey =
    'agent_id' in scope ? historyAgentObjectKey(scope.agent_id) : historyConversationObjectKey(scope.conversation_id);
  return `${historyBaseUrl}/${objectKey}`;
}

function normalizeAgentHistory(document: unknown, agentId: string): HistoryResponse {
  const parsed = agentHistoryDocumentSchema.parse(document);
  const coerced = coerceAgentHistoryDocument(parsed, agentId);
  const combined: HistoryEntry[] = [
    ...coerced.items,
    ...coerced.recent_actions,
    ...coerced.recent_conversations,
  ];

  return {
    items: sortHistoryEntriesByOccurredAtDesc(dedupeHistoryEntriesByEventId(combined)),
  };
}

function normalizeConversationHistory(document: unknown, conversationId: string): HistoryResponse {
  const parsed = conversationHistoryDocumentSchema.parse(document);
  const coerced = coerceConversationHistoryDocument(parsed, conversationId);
  return {
    items: sortHistoryEntriesByOccurredAtDesc(coerced.items),
  };
}

export function createSnapshotStore({
  snapshotUrl,
  authMode,
  fetchImpl = ((...args) => fetch(...args)) as typeof fetch,
  pollIntervalMs = 5_000,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  initialSnapshot,
  initialStatus = initialSnapshot ? 'ready' : 'idle',
  initialSelectedAgentId,
}: CreateSnapshotStoreOptions): SnapshotStoreApi {
  const hasInitialSelectedAgent = initialSnapshot ? snapshotHasAgent(initialSnapshot, initialSelectedAgentId) : false;
  const historyBaseUrl = deriveHistoryBaseUrl(snapshotUrl);
  let pollingInterval: ReturnType<typeof setInterval> | undefined;
  let pollingStarted = false;
  let pollInFlight = false;
  let pollQueued = false;
  let queuedLifecycleId: number | undefined;
  let queuedManualPoll = false;
  let currentPollingLifecycleId = 0;
  let activePollAbortController: AbortController | undefined;
  let activePollTimeout: ReturnType<typeof setTimeout> | undefined;
  let historyRequestId = 0;
  const activeHistoryRequests = new Map<HistoryScopeKey, { id: number; controller: AbortController }>();
  const notifiedMissingScopes = new Set<HistoryScopeKey>();

  const store = createStore<SnapshotStoreState>(() => ({
    snapshot_url: snapshotUrl,
    auth_mode: authMode,
    ...(initialSnapshot ? { snapshot: initialSnapshot } : {}),
    snapshot_status: initialStatus,
    ...(initialSnapshot ? { last_success_at: Date.now() } : {}),
    is_stale: false,
    ...(hasInitialSelectedAgent ? { selected_agent_id: initialSelectedAgentId } : {}),
    selected_agent_revision: hasInitialSelectedAgent ? 1 : 0,
    setSelectedAgentId: (agentId?: string) => {
      store.setState((state) => {
        const nextMobileSheetMode = resolveMobileSheetModeOnSelection(agentId, state.mobile_sheet_mode);
        return {
          selected_agent_id: agentId,
          selected_agent_revision: state.selected_agent_revision + 1,
          mobile_sheet_mode: nextMobileSheetMode,
        };
      });
    },
    history_cache: {},
    fetchHistory: (scope) => fetchHistory(scope),
    expanded_conversation_ids: {},
    toggleConversationExpanded: (conversationId, expanded) => {
      store.setState((state) => {
        const currentExpanded = Boolean(state.expanded_conversation_ids[conversationId]);
        const nextExpanded = expanded ?? !currentExpanded;

        return {
          expanded_conversation_ids: {
            ...state.expanded_conversation_ids,
            [conversationId]: nextExpanded,
          },
        };
      });
    },
    mobile_sheet_mode: hasInitialSelectedAgent ? 'detail' : 'list',
    setMobileSheetMode: (mode) => {
      store.setState((state) => {
        if (mode === 'detail' && !state.selected_agent_id) {
          return {};
        }

        if (state.mobile_sheet_mode === 'detail' && mode !== 'detail') {
          return {
            mobile_sheet_mode: mode,
            selected_agent_id: undefined,
          };
        }

        return {
          mobile_sheet_mode: mode,
        };
      });
    },
    poll: () => pollSnapshot(),
    startPolling: async () => {
      if (pollingStarted) {
        return;
      }

      pollingStarted = true;
      const lifecycleId = ++currentPollingLifecycleId;
      const currentSnapshot = store.getState().snapshot;
      if (currentSnapshot) {
        applyStaleState(currentSnapshot, lifecycleId);
      }
      startPollingInterval(lifecycleId);
      await pollSnapshot(lifecycleId);
      if (!isPollingLifecycleActive(lifecycleId)) {
        return;
      }
    },
    stopPolling: () => {
      pollingStarted = false;
      currentPollingLifecycleId += 1;
      pollQueued = false;
      queuedLifecycleId = undefined;
      queuedManualPoll = false;
      abortActivePollRequest(POLL_STOP_ABORT_REASON);
      abortAllHistoryRequests(HISTORY_STOP_ABORT_REASON);

      if (pollingInterval !== undefined) {
        clearInterval(pollingInterval);
        pollingInterval = undefined;
      }
    },
  }));

  function isPollingLifecycleActive(lifecycleId: number): boolean {
    return pollingStarted && currentPollingLifecycleId === lifecycleId;
  }

  function setIfActive(updater: () => Partial<SnapshotStoreState>, lifecycleId?: number): void {
    if (lifecycleId !== undefined && !isPollingLifecycleActive(lifecycleId)) {
      return;
    }

    store.setState(updater());
  }

  function abortActivePollRequest(reason: string): void {
    if (activePollTimeout !== undefined) {
      clearTimeout(activePollTimeout);
      activePollTimeout = undefined;
    }

    activePollAbortController?.abort(reason);
    activePollAbortController = undefined;
  }

  function abortAllHistoryRequests(reason: string): void {
    for (const { controller } of activeHistoryRequests.values()) {
      controller.abort(reason);
    }
    activeHistoryRequests.clear();
  }

  function startPollingInterval(lifecycleId: number): void {
    pollingInterval = setInterval(() => {
      void pollSnapshot(lifecycleId);
    }, pollIntervalMs);
  }

  function applyStaleState(snapshot: SpectatorSnapshot, lifecycleId?: number): void {
    if (lifecycleId !== undefined && !isPollingLifecycleActive(lifecycleId)) {
      return;
    }

    setIfActive(
      () => ({
        is_stale:
          snapshot.last_publish_error_at !== undefined && snapshot.last_publish_error_at > snapshot.published_at,
      }),
      lifecycleId,
    );
  }

  async function fetchJsonOrThrow(url: string, signal: AbortSignal): Promise<unknown> {
    const response = await fetchImpl(url, {
      ...buildAuthModeRequestInit(authMode),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Snapshot fetch failed with HTTP ${response.status}`);
    }

    let parsed: unknown;

    try {
      parsed = await response.json();
    } catch (error) {
      throw new Error(`Snapshot JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return parsed;
  }

  async function fetchSnapshot(signal: AbortSignal): Promise<SpectatorSnapshot> {
    const parsed = await fetchJsonOrThrow(snapshotUrl, signal);

    if (isSchemaIncompatible(parsed)) {
      const issue =
        typeof parsed === 'object' && parsed !== null && 'schema_version' in parsed
          ? String(parsed.schema_version)
          : 'unknown';
      throw new SnapshotIncompatibleError(`Unsupported snapshot schema_version: ${issue}`);
    }

    const result = spectatorSnapshotSchema.safeParse(parsed);

    if (!result.success) {
      throw new Error(result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    }

    return result.data as SpectatorSnapshot;
  }

  async function fetchHistory(scope: HistoryScope): Promise<void> {
    const scopeKey = toHistoryScopeKey(scope);

    activeHistoryRequests.get(scopeKey)?.controller.abort(HISTORY_ABORT_REASON);

    const controller = new AbortController();
    const requestId = ++historyRequestId;
    activeHistoryRequests.set(scopeKey, { id: requestId, controller });

    store.setState((state) => {
      const previousEntry = state.history_cache[scopeKey];
      return {
        history_cache: {
          ...state.history_cache,
          [scopeKey]: {
            status: 'loading',
            ...(previousEntry && 'response' in previousEntry && previousEntry.response
              ? { response: previousEntry.response }
              : {}),
            ...(previousEntry && 'last_fetched_at' in previousEntry && previousEntry.last_fetched_at !== undefined
              ? { last_fetched_at: previousEntry.last_fetched_at }
              : {}),
          },
        },
      };
    });

    const historyUrl = buildHistoryObjectUrl(historyBaseUrl, scope);

    try {
      const response = await fetchImpl(historyUrl, {
        ...buildAuthModeRequestInit(authMode),
        signal: controller.signal,
      });

      if (activeHistoryRequests.get(scopeKey)?.id !== requestId) {
        return;
      }

      let responseData: HistoryResponse;

      if (response.status === 404) {
        if (!notifiedMissingScopes.has(scopeKey)) {
          notifiedMissingScopes.add(scopeKey);
          console.warn('History object missing (treating as empty)', { scope, url: historyUrl });
        }
        responseData = { items: [] };
      } else if (!response.ok) {
        throw new Error(`History fetch failed with HTTP ${response.status}`);
      } else {
        notifiedMissingScopes.delete(scopeKey);
        const parsed = await response.json();
        try {
          responseData =
            'agent_id' in scope
              ? normalizeAgentHistory(parsed, scope.agent_id)
              : normalizeConversationHistory(parsed, scope.conversation_id);
        } catch (parseError) {
          console.error('History schema parse failed', {
            scope,
            url: historyUrl,
            error: parseError instanceof Error ? parseError.message : String(parseError),
          });
          throw parseError;
        }
      }

      store.setState((state) => ({
        history_cache: {
          ...state.history_cache,
          [scopeKey]: {
            status: 'ready',
            response: responseData,
            last_fetched_at: Date.now(),
          },
        },
      }));
    } catch (error) {
      if (
        controller.signal.aborted &&
        (controller.signal.reason === HISTORY_ABORT_REASON || controller.signal.reason === HISTORY_STOP_ABORT_REASON)
      ) {
        return;
      }

      if (activeHistoryRequests.get(scopeKey)?.id !== requestId) {
        return;
      }

      store.setState((state) => {
        const currentEntry = state.history_cache[scopeKey];
        return {
          history_cache: {
            ...state.history_cache,
            [scopeKey]: {
              status: 'error',
              ...(currentEntry && 'response' in currentEntry && currentEntry.response
                ? { response: currentEntry.response }
                : {}),
              ...(currentEntry && 'last_fetched_at' in currentEntry && currentEntry.last_fetched_at !== undefined
                ? { last_fetched_at: currentEntry.last_fetched_at }
                : {}),
              error_at: Date.now(),
            },
          },
        };
      });
    } finally {
      if (activeHistoryRequests.get(scopeKey)?.id === requestId) {
        activeHistoryRequests.delete(scopeKey);
      }
    }
  }

  function refreshActiveHistoryScopes(lifecycleId?: number): void {
    if (lifecycleId !== undefined && !isPollingLifecycleActive(lifecycleId)) {
      return;
    }

    const { selected_agent_id: selectedAgentId, expanded_conversation_ids: expandedConversationIds } = store.getState();

    if (selectedAgentId) {
      void fetchHistory({ agent_id: selectedAgentId });
    }

    for (const [conversationId, expanded] of Object.entries(expandedConversationIds)) {
      if (expanded) {
        void fetchHistory({ conversation_id: conversationId });
      }
    }
  }

  async function pollSnapshot(lifecycleId?: number): Promise<void> {
    if (lifecycleId !== undefined && !isPollingLifecycleActive(lifecycleId)) {
      return;
    }

    if (pollInFlight) {
      pollQueued = true;
      if (lifecycleId !== undefined) {
        queuedLifecycleId = lifecycleId;
      } else if (pollingStarted) {
        queuedLifecycleId = currentPollingLifecycleId;
      } else {
        queuedManualPoll = true;
      }
      return;
    }

    pollInFlight = true;
    const { snapshot: currentSnapshot, snapshot_status: currentStatus } = store.getState();
    const requestController = new AbortController();
    activePollAbortController = requestController;
    activePollTimeout = setTimeout(() => {
      requestController.abort(POLL_TIMEOUT_ABORT_REASON);
    }, fetchTimeoutMs);

    if (!currentSnapshot && currentStatus !== 'incompatible') {
      setIfActive(() => ({ snapshot_status: 'loading' }), lifecycleId);
    }

    try {
      const nextSnapshot = await fetchSnapshot(requestController.signal);
      if (lifecycleId !== undefined && !isPollingLifecycleActive(lifecycleId)) {
        return;
      }

      const previousSnapshot = store.getState().snapshot;

      if (previousSnapshot) {
        const comparison = compareSnapshotVersion(nextSnapshot, previousSnapshot);

        if (comparison < 0) {
          return;
        }

        if (comparison === 0) {
          setIfActive(
            () => ({
              snapshot_status: 'ready',
              last_success_at: Date.now(),
              is_stale: false,
            }),
            lifecycleId,
          );
          applyStaleState(previousSnapshot, lifecycleId);
          refreshActiveHistoryScopes(lifecycleId);
          return;
        }
      }

      const snapshotWithSharedStaticRefs = preserveStaticSnapshotReferences(previousSnapshot, nextSnapshot);
      const currentState = store.getState();
      const reconciledSelectionState = reconcileSelectionState(snapshotWithSharedStaticRefs, currentState);

      setIfActive(
        () => ({
          snapshot: snapshotWithSharedStaticRefs,
          snapshot_status: 'ready',
          last_success_at: Date.now(),
          is_stale: false,
          ...reconciledSelectionState,
        }),
        lifecycleId,
      );
      applyStaleState(snapshotWithSharedStaticRefs, lifecycleId);
      refreshActiveHistoryScopes(lifecycleId);
    } catch (error) {
      if (requestController.signal.aborted && requestController.signal.reason === POLL_STOP_ABORT_REASON) {
        return;
      }

      if (lifecycleId !== undefined && !isPollingLifecycleActive(lifecycleId)) {
        return;
      }

      if (error instanceof SnapshotIncompatibleError) {
        setIfActive(() => ({ snapshot_status: 'incompatible' }), lifecycleId);
        return;
      }

      const { snapshot_status: currentStatus } = store.getState();

      if (currentStatus === 'incompatible') {
        return;
      }

      setIfActive(
        () => ({
          snapshot_status: 'error',
          last_error_at: Date.now(),
        }),
        lifecycleId,
      );
    } finally {
      if (activePollTimeout !== undefined) {
        clearTimeout(activePollTimeout);
        activePollTimeout = undefined;
      }
      if (activePollAbortController === requestController) {
        activePollAbortController = undefined;
      }
      pollInFlight = false;

      if (!pollQueued) {
        return;
      }

      const nextLifecycleId = queuedLifecycleId;
      const shouldRunQueuedManualPoll = queuedManualPoll;
      pollQueued = false;
      queuedLifecycleId = undefined;
      queuedManualPoll = false;

      if (nextLifecycleId !== undefined && isPollingLifecycleActive(nextLifecycleId)) {
        await pollSnapshot(nextLifecycleId);
        return;
      }

      if (shouldRunQueuedManualPoll) {
        await pollSnapshot();
      }
    }
  }

  if (initialSnapshot) {
    applyStaleState(initialSnapshot);
  }

  return store;
}
