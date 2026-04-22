// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App.js';
import { buildAgentRenderTargets } from '../components/map/agent-render-model.js';
import { createSnapshotStore } from '../store/snapshot-store.js';
import { createFixtureSnapshot } from './fixtures/snapshot.js';
import type { SpectatorAgentSnapshot, SpectatorMapSnapshot, SpectatorSnapshot } from '../../worker/src/contracts/spectator-snapshot.js';

const env = {
  snapshotUrl: 'https://snapshot.example.com/snapshot/latest.json',
  authMode: 'public' as const,
};

const HISTORY_URL_PREFIX = 'https://snapshot.example.com/history/';
const AGENT_HISTORY_URL_ALICE = 'https://snapshot.example.com/history/agents/alice.json';
const CONVERSATION_HISTORY_URL_CONV_1 = 'https://snapshot.example.com/history/conversations/conv-1.json';

function createResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
    ...init,
  });
}

function create100AgentSnapshot(overrides: Partial<SpectatorSnapshot> = {}): SpectatorSnapshot {
  const base = createFixtureSnapshot();
  const nodes: SpectatorMapSnapshot['nodes'] = {};
  const agents: SpectatorAgentSnapshot[] = [];

  for (let row = 1; row <= 10; row += 1) {
    for (let col = 1; col <= 10; col += 1) {
      const nodeId = `${row}-${col}` as keyof SpectatorMapSnapshot['nodes'];
      const agentIndex = (row - 1) * 10 + col;
      const padded = String(agentIndex).padStart(3, '0');

      nodes[nodeId] = {
        type: 'normal',
        label: `Node ${nodeId}`,
      };
      agents.push({
        agent_id: `agent-${padded}`,
        agent_name: `Agent ${agentIndex}`,
        node_id: nodeId,
        state: agentIndex % 3 === 0 ? 'moving' : agentIndex % 2 === 0 ? 'in_action' : 'idle',
        status_emoji: agentIndex % 3 === 0 ? '🚶' : agentIndex % 2 === 0 ? '🛠️' : '💤',
        ...(agentIndex === 100
          ? {
              discord_bot_avatar_url: 'https://example.com/agent-100.png',
            }
          : {}),
      });
    }
  }

  const map: SpectatorMapSnapshot = {
    rows: 10,
    cols: 10,
    nodes,
    buildings: [],
    npcs: [],
  };

  return {
    ...base,
    map,
    agents,
    conversations: [],
    recent_server_events: [],
    generated_at: 1_780_000_000_000,
    published_at: 1_780_000_005_000,
    ...overrides,
  };
}

function createAgentHistoryResponse() {
  return {
    items: Array.from({ length: 20 }, (_, index) => {
      const itemNumber = 20 - index;
      const padded = String(itemNumber).padStart(2, '0');

      return {
        event_id: `event-${padded}`,
        type: itemNumber === 20 ? 'conversation_message' : 'action_completed',
        occurred_at: 1_780_000_000_000 + itemNumber * 1_000,
        agent_ids: ['alice'],
        ...(itemNumber === 20 ? { conversation_id: 'conv-1' } : {}),
        summary: {
          emoji: itemNumber === 20 ? '💬' : '✅',
          title: itemNumber === 20 ? 'Conversation opened' : `History ${padded}`,
          text: itemNumber === 20 ? 'Alice talked with Bob.' : `History item ${padded}.`,
        },
        detail: {},
      };
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Phase 1 acceptance', () => {
  it('keeps the desktop/mobile shell stable at 100-agent scale and reflects a later snapshot within 15 seconds', async () => {
    vi.useFakeTimers();

    const initialSnapshot = create100AgentSnapshot();
    const refreshedSnapshot = create100AgentSnapshot({
      generated_at: initialSnapshot.generated_at + 12_000,
      published_at: initialSnapshot.published_at + 12_000,
      agents: initialSnapshot.agents.map((agent) =>
        agent.agent_id === 'agent-100'
          ? {
              ...agent,
              node_id: '1-1',
              status_emoji: '✨',
            }
          : agent,
      ),
    });

    let snapshotCallCount = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();

      if (url.startsWith(HISTORY_URL_PREFIX)) {
        return createResponse({ items: [] });
      }

      snapshotCallCount += 1;
      return createResponse(snapshotCallCount >= 3 ? refreshedSnapshot : initialSnapshot);
    });
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: fetchMock,
      pollIntervalMs: 5_000,
      initialSnapshot: initialSnapshot,
    });

    render(<App env={env} store={store} autoStartPolling={false} />);

    expect(screen.getByTestId('desktop-shell')).toBeInTheDocument();
    expect(screen.getByTestId('desktop-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-top-badge')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bottom-sheet')).toBeInTheDocument();
    expect(within(screen.getByTestId('sidebar-agent-list')).getAllByRole('button')).toHaveLength(100);
    expect(buildAgentRenderTargets(initialSnapshot, 'agent-100')).toHaveLength(100);

    fireEvent.click(screen.getByTestId('sidebar-agent-button-agent-100'));

    expect(screen.getByTestId('desktop-agent-name')).toHaveTextContent('Agent 100');
    expect(screen.getByTestId('desktop-agent-location')).toHaveTextContent('10-10');

    await act(async () => {
      await store.getState().startPolling();
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(store.getState().snapshot?.generated_at).toBe(refreshedSnapshot.generated_at);
    expect(screen.getByTestId('desktop-agent-location')).toHaveTextContent('1-1');

    store.getState().stopPolling();
  });

  it('loads agent detail history with limit=20 and expands conversation history from the same UI flow', async () => {
    const snapshot = createFixtureSnapshot();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();

      if (url === AGENT_HISTORY_URL_ALICE) {
        return createResponse(createAgentHistoryResponse());
      }

      if (url === CONVERSATION_HISTORY_URL_CONV_1) {
        return createResponse({
          items: [
            {
              event_id: 'conversation-2',
              type: 'conversation_message',
              occurred_at: 1_780_000_021_000,
              agent_ids: ['alice', 'bob'],
              conversation_id: 'conv-1',
              summary: {
                emoji: '💬',
                title: 'Bob replied',
                text: 'Bob answered Alice.',
              },
              detail: {},
            },
            {
              event_id: 'conversation-1',
              type: 'conversation_message',
              occurred_at: 1_780_000_020_000,
              agent_ids: ['alice', 'bob'],
              conversation_id: 'conv-1',
              summary: {
                emoji: '💬',
                title: 'Alice spoke',
                text: 'Alice started the conversation.',
              },
              detail: {},
            },
          ],
        });
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: fetchMock,
      initialSnapshot: snapshot,
    });

    render(<App env={env} store={store} autoStartPolling={false} />);

    fireEvent.click(screen.getByTestId('sidebar-agent-button-alice'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        AGENT_HISTORY_URL_ALICE,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId('desktop-agent-history-list')).toBeInTheDocument());

    const items = within(screen.getByTestId('desktop-agent-history-list')).getAllByTestId('desktop-agent-history-item');
    expect(items).toHaveLength(20);
    expect(items[0]).toHaveTextContent('Conversation opened');
    expect(items[19]).toHaveTextContent('History 01');
    expect(screen.getByTestId('mobile-detail-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('desktop-conversation-toggle-conv-1'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        CONVERSATION_HISTORY_URL_CONV_1,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId('desktop-conversation-history-panel-conv-1')).toBeInTheDocument());

    const conversationItems = within(screen.getByTestId('desktop-conversation-history-conv-1-list')).getAllByTestId(
      'desktop-conversation-history-conv-1-item',
    );
    expect(conversationItems).toHaveLength(1);
    expect(conversationItems[0]).toHaveTextContent('Bob replied');
  });

  it('keeps healthy quiet periods fresh and leaves the stale banner hidden until publish health degrades', async () => {
    vi.useFakeTimers();

    const baseNow = new Date('2026-06-20T09:30:00.000Z');
    vi.setSystemTime(baseNow);

    const baseNowMs = baseNow.getTime();
    const initialSnapshot = {
      ...createFixtureSnapshot(),
      generated_at: baseNowMs,
      published_at: baseNowMs + 5_000,
    };
    const quietRefreshSnapshot = {
      ...initialSnapshot,
      generated_at: baseNowMs + 180_000,
      published_at: baseNowMs + 185_000,
    };

    let snapshotCallCount = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();

      if (url.startsWith(HISTORY_URL_PREFIX)) {
        return createResponse({ items: [] });
      }

      snapshotCallCount += 1;
      return createResponse(snapshotCallCount >= 37 ? quietRefreshSnapshot : initialSnapshot);
    });
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: fetchMock,
      pollIntervalMs: 5_000,
      initialSnapshot,
    });

    render(<App env={env} store={store} autoStartPolling={false} />);

    await act(async () => {
      await store.getState().startPolling();
      await vi.advanceTimersByTimeAsync(180_000);
    });

    expect(store.getState().is_stale).toBe(false);
    expect(screen.queryByTestId('snapshot-stale-badge')).not.toBeInTheDocument();

    expect(store.getState().snapshot?.generated_at).toBe(quietRefreshSnapshot.generated_at);
    expect(store.getState().is_stale).toBe(false);
    expect(screen.queryByTestId('snapshot-stale-badge')).not.toBeInTheDocument();

    store.getState().stopPolling();
  });
});
