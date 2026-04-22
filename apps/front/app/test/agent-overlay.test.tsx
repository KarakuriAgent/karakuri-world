// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgentOverlay } from '../components/overlay/AgentOverlay.js';
import type { HistoryCacheEntry } from '../store/snapshot-store.js';
import { createFixtureSnapshot } from './fixtures/snapshot.js';
import type { SpectatorAgentSnapshot, SpectatorSnapshot } from '../../worker/src/contracts/spectator-snapshot.js';

function createReadyHistory(): HistoryCacheEntry {
  return {
    status: 'ready',
    request: {
      limit: 20,
      merge: 'replace',
    },
    last_fetched_at: 1_780_000_010_000,
    response: {
      items: [
        {
          event_id: 'event-new',
          type: 'action_completed',
          occurred_at: 1_780_000_010_000,
          agent_ids: ['alice'],
          summary: {
            emoji: '✅',
            title: 'Craft complete',
            text: 'Alice finished crafting.',
          },
          detail: {},
        },
        {
          event_id: 'event-old',
          type: 'movement_started',
          occurred_at: 1_780_000_000_000,
          agent_ids: ['alice'],
          summary: {
            emoji: '🚶',
            title: 'Moved',
            text: 'Alice started moving.',
          },
          detail: {},
        },
      ],
    },
  };
}

function renderOverlay(
  agent: SpectatorAgentSnapshot,
  snapshot?: SpectatorSnapshot,
  compact = false,
  history?: HistoryCacheEntry,
) {
  render(<AgentOverlay agent={agent} snapshot={snapshot} compact={compact} history={history} />);
}

describe('AgentOverlay', () => {
  it('renders the required detail header and summary fields', () => {
    const snapshot = createFixtureSnapshot();
    const agent = snapshot.agents[0]!;

    renderOverlay(agent, snapshot);

    expect(screen.getByTestId('desktop-agent-name')).toHaveTextContent('Alice');
    expect(screen.getByTestId('desktop-agent-location')).toHaveTextContent('1-2');
    expect(screen.getByTestId('desktop-agent-activity')).toHaveTextContent('Craft');
    expect(screen.getByRole('img', { name: 'Alice avatar' })).toHaveAttribute('src', 'https://example.com/alice.png');
    expect(screen.queryByTestId('desktop-agent-status-emoji')).not.toBeInTheDocument();
    expect(screen.queryByTestId('desktop-agent-state')).not.toBeInTheDocument();
    expect(screen.queryByText(/selected_agent_id/i)).not.toBeInTheDocument();
  });

  it('derives moving activity text from movement when current_activity is absent', () => {
    const snapshot = createFixtureSnapshot();
    const agent: SpectatorAgentSnapshot = {
      ...snapshot.agents[1]!,
      state: 'moving',
      movement: {
        from_node_id: '2-1',
        to_node_id: '1-1',
        path: ['2-1', '1-1'],
        arrives_at: snapshot.generated_at + 60_000,
      },
    };

    renderOverlay(agent, snapshot);

    expect(screen.getByText('移動中 2-1 → 1-1 (Square)')).toBeInTheDocument();
  });

  it('derives conversation activity text from conversation context when current_activity is absent', () => {
    const snapshot: SpectatorSnapshot = {
      ...createFixtureSnapshot(),
      agents: createFixtureSnapshot().agents.map((agent) =>
        agent.agent_id === 'alice'
          ? {
              ...agent,
              state: 'in_conversation',
              current_activity: undefined,
              current_conversation_id: 'conv-1',
            }
          : agent,
      ),
    };
    const agent = snapshot.agents.find((candidate) => candidate.agent_id === 'alice')!;

    renderOverlay(agent, snapshot);

    expect(screen.getByText('会話中（Bob） / 発話中')).toBeInTheDocument();
  });

  it('renders the Discord avatar when available and falls back safely when absent', () => {
    const snapshot = createFixtureSnapshot();
    const desktopAgent = snapshot.agents[0]!;
    const compactAgent = snapshot.agents[1]!;

    const { rerender } = render(
      <AgentOverlay agent={desktopAgent} snapshot={snapshot} onClose={() => undefined} />,
    );

    const desktopOverlay = screen.getByTestId('desktop-overlay');
    expect(within(desktopOverlay).getByRole('img', { name: 'Alice avatar' })).toHaveAttribute(
      'src',
      'https://example.com/alice.png',
    );
    expect(within(desktopOverlay).getByTestId('desktop-agent-location')).toHaveTextContent('1-2');

    rerender(<AgentOverlay agent={compactAgent} snapshot={snapshot} compact />);

    const mobileOverlay = screen.getByTestId('mobile-agent-overlay');
    expect(within(mobileOverlay).queryByRole('img', { name: 'Bob avatar' })).not.toBeInTheDocument();
    expect(within(mobileOverlay).getByTestId('mobile-agent-avatar-fallback')).toHaveTextContent('B');
    expect(within(mobileOverlay).getByTestId('mobile-agent-activity')).toHaveTextContent('待機中');
  });

  it('retries rendering a new avatar after the previous agent image failed', () => {
    const snapshot = createFixtureSnapshot();
    const failingAgent = snapshot.agents[0]!;
    const nextAgent: SpectatorAgentSnapshot = {
      ...snapshot.agents[1]!,
      discord_bot_avatar_url: 'https://example.com/bob.png',
    };

    const { rerender } = render(
      <AgentOverlay agent={failingAgent} snapshot={snapshot} onClose={() => undefined} />,
    );

    fireEvent.error(screen.getByRole('img', { name: 'Alice avatar' }));

    const desktopOverlay = screen.getByTestId('desktop-overlay');
    expect(within(desktopOverlay).queryByRole('img', { name: 'Alice avatar' })).not.toBeInTheDocument();
    expect(within(desktopOverlay).getByTestId('desktop-agent-avatar-fallback')).toHaveTextContent('A');

    rerender(<AgentOverlay agent={nextAgent} snapshot={snapshot} onClose={() => undefined} />);

    expect(within(desktopOverlay).getByRole('img', { name: 'Bob avatar' })).toHaveAttribute(
      'src',
      'https://example.com/bob.png',
    );
  });

  it('renders the newest-first history timeline instead of the placeholder copy', () => {
    const snapshot = createFixtureSnapshot();
    const agent = snapshot.agents[0]!;

    renderOverlay(agent, snapshot, false, createReadyHistory());

    const items = within(screen.getByTestId('desktop-agent-history-list')).getAllByTestId('desktop-agent-history-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Craft complete');
    expect(items[0]).toHaveTextContent('Alice finished crafting.');
    expect(items[1]).toHaveTextContent('Moved');
    expect(screen.queryByText('履歴タイムラインと会話展開は後続 Unit で接続します。')).not.toBeInTheDocument();
  });

  it('keeps replace-failure retry affordances visible when preserved empty agent history is shown', () => {
    const snapshot = createFixtureSnapshot();
    const agent = snapshot.agents[0]!;
    const fetchHistory = vi.fn();
    const history: HistoryCacheEntry = {
      status: 'error',
      request: {
        limit: 20,
        merge: 'replace',
      },
      response: {
        items: [],
      },
      last_fetched_at: 1_780_000_010_000,
      error_at: 1_780_000_020_000,
    };

    render(
      <AgentOverlay agent={agent} snapshot={snapshot} history={history} fetchHistory={fetchHistory} />,
    );

    expect(screen.getByTestId('desktop-agent-history-empty')).toHaveTextContent('履歴はまだありません');
    expect(screen.getByTestId('desktop-agent-history-warning')).toHaveTextContent('更新に失敗しました');

    fireEvent.click(screen.getByTestId('desktop-agent-history-warning-retry'));

    expect(fetchHistory).toHaveBeenCalledWith({ agent_id: 'alice' }, { limit: 20, merge: 'replace' });
  });

  it('expands conversation history lazily and retries nested history loads from the separate conversation cache', async () => {
    const snapshot = createFixtureSnapshot();
    const agent = snapshot.agents[0]!;
    const history: HistoryCacheEntry = {
      status: 'ready',
      request: {
        limit: 20,
        merge: 'replace',
      },
      last_fetched_at: 1_780_000_010_000,
      response: {
        items: [
          {
            event_id: 'event-conv',
            type: 'conversation_requested',
            occurred_at: 1_780_000_020_000,
            agent_ids: ['alice', 'bob'],
            conversation_id: 'conv-1',
            summary: {
              emoji: '📨',
              title: 'Conversation requested',
              text: 'Hello Bob?',
            },
            detail: {
              initiator_agent_id: 'alice',
              target_agent_id: 'bob',
              message: 'Hello Bob?',
            },
          },
        ],
      },
    };
    const fetchHistory = vi.fn();
    const onToggleConversationExpanded = vi.fn();

    const { rerender } = render(
      <AgentOverlay
        agent={agent}
        snapshot={snapshot}
        history={history}
        historyCache={{ 'conversation:conv-1': { status: 'idle' } }}
        expandedConversationIds={{}}
        fetchHistory={fetchHistory}
        onToggleConversationExpanded={onToggleConversationExpanded}
      />,
    );

    fireEvent.click(screen.getByTestId('desktop-conversation-toggle-conv-1'));

    expect(onToggleConversationExpanded).toHaveBeenCalledWith('conv-1', true);
    expect(fetchHistory).toHaveBeenCalledWith({ conversation_id: 'conv-1' }, undefined);

    rerender(
      <AgentOverlay
        agent={agent}
        snapshot={snapshot}
        history={history}
        historyCache={{
          'conversation:conv-1': {
            status: 'error',
            request: {
              limit: 50,
              merge: 'replace',
            },
            error_at: 1_780_000_030_000,
          },
        }}
        expandedConversationIds={{ 'conv-1': true }}
        fetchHistory={fetchHistory}
        onToggleConversationExpanded={onToggleConversationExpanded}
      />,
    );

    expect(screen.getByTestId('desktop-conversation-history-conv-1-error')).toHaveTextContent('履歴の取得に失敗しました');

    fireEvent.click(screen.getByTestId('desktop-conversation-history-conv-1-retry'));

    expect(fetchHistory).toHaveBeenLastCalledWith({ conversation_id: 'conv-1' }, { limit: 50, merge: 'replace' });

    fetchHistory.mockClear();
    onToggleConversationExpanded.mockClear();

    rerender(
      <AgentOverlay
        agent={agent}
        snapshot={snapshot}
        history={history}
        historyCache={{
          'conversation:conv-1': {
            status: 'error',
            request: {
              cursor: 'cursor-2',
              limit: 50,
              merge: 'append',
            },
            response: {
              items: [
                {
                  event_id: 'event-conv',
                  type: 'conversation_message',
                  occurred_at: 1_780_000_020_000,
                  agent_ids: ['alice', 'bob'],
                  conversation_id: 'conv-1',
                  summary: {
                    emoji: '💬',
                    title: 'Conversation',
                    text: 'Alice talked with Bob.',
                  },
                  detail: {},
                },
              ],
              next_cursor: 'cursor-2',
            },
            last_fetched_at: 1_780_000_010_000,
            error_at: 1_780_000_040_000,
          },
        }}
        expandedConversationIds={{}}
        fetchHistory={fetchHistory}
        onToggleConversationExpanded={onToggleConversationExpanded}
      />,
    );

    fireEvent.click(screen.getByTestId('desktop-conversation-toggle-conv-1'));

    expect(onToggleConversationExpanded).toHaveBeenCalledWith('conv-1', true);
    expect(fetchHistory).toHaveBeenCalledWith({ conversation_id: 'conv-1' }, {
      cursor: 'cursor-2',
      limit: 50,
      merge: 'append',
    });
  });

  it('collapses each conversation to its head utterance in the agent timeline and shows the full log with speaker bubbles when expanded', () => {
    const snapshot = createFixtureSnapshot();
    const agent = snapshot.agents[0]!;
    const agentHistory: HistoryCacheEntry = {
      status: 'ready',
      request: { limit: 20, merge: 'replace' },
      last_fetched_at: 1_780_000_010_000,
      response: {
        items: [
          {
            event_id: 'event-speak',
            type: 'conversation_message',
            occurred_at: 1_780_000_030_000,
            agent_ids: ['alice', 'bob'],
            conversation_id: 'conv-1',
            summary: {
              emoji: '💬',
              title: 'Message sent',
              text: 'Alice said hi.',
            },
            detail: { speaker_agent_id: 'alice' },
          },
          {
            event_id: 'event-accepted',
            type: 'conversation_accepted',
            occurred_at: 1_780_000_025_000,
            agent_ids: ['alice', 'bob'],
            conversation_id: 'conv-1',
            summary: {
              emoji: '🤝',
              title: 'Conversation accepted',
              text: 'Accepted.',
            },
            detail: {},
          },
          {
            event_id: 'event-requested',
            type: 'conversation_requested',
            occurred_at: 1_780_000_020_000,
            agent_ids: ['alice', 'bob'],
            conversation_id: 'conv-1',
            summary: {
              emoji: '📨',
              title: 'Conversation requested',
              text: 'Hello?',
            },
            detail: {
              initiator_agent_id: 'alice',
              target_agent_id: 'bob',
              message: 'Hello?',
            },
          },
        ],
      },
    };
    const conversationHistory: HistoryCacheEntry = {
      status: 'ready',
      request: { limit: 50, merge: 'replace' },
      last_fetched_at: 1_780_000_040_000,
      response: {
        items: [
          {
            event_id: 'event-speak',
            type: 'conversation_message',
            occurred_at: 1_780_000_030_000,
            agent_ids: ['alice', 'bob'],
            conversation_id: 'conv-1',
            summary: {
              emoji: '💬',
              title: 'Message sent',
              text: 'Alice said hi.',
            },
            detail: { speaker_agent_id: 'alice' },
          },
          {
            event_id: 'event-requested',
            type: 'conversation_requested',
            occurred_at: 1_780_000_020_000,
            agent_ids: ['alice', 'bob'],
            conversation_id: 'conv-1',
            summary: {
              emoji: '📨',
              title: 'Conversation requested',
              text: 'Hello?',
            },
            detail: {
              initiator_agent_id: 'alice',
              target_agent_id: 'bob',
              message: 'Hello?',
            },
          },
        ],
      },
    };

    render(
      <AgentOverlay
        agent={agent}
        snapshot={snapshot}
        history={agentHistory}
        historyCache={{ 'conversation:conv-1': conversationHistory }}
        expandedConversationIds={{ 'conv-1': true }}
      />,
    );

    const timelineList = screen.getByTestId('desktop-agent-history-list');
    const timelineItems = within(timelineList).getAllByTestId('desktop-agent-history-item');
    expect(timelineItems).toHaveLength(1);
    expect(
      within(timelineItems[0]!).getByTestId('desktop-agent-history-item-speaker-avatar-event-requested'),
    ).toBeInTheDocument();
    expect(
      within(timelineItems[0]!).getByTestId('desktop-agent-history-item-speaker-name-event-requested'),
    ).toHaveTextContent('Alice');
    expect(timelineItems[0]).toHaveTextContent('Hello?');
    expect(timelineItems[0]).not.toHaveTextContent('Conversation accepted');
    expect(timelineItems[0]).not.toHaveTextContent('Message sent');

    const conversationPanel = screen.getByTestId('desktop-conversation-history-panel-conv-1');
    const conversationItems = within(conversationPanel).getAllByTestId('desktop-conversation-history-conv-1-item');
    expect(conversationItems).toHaveLength(1);
    expect(
      within(conversationPanel).getByTestId('desktop-conversation-history-conv-1-item-speaker-avatar-event-speak'),
    ).toBeInTheDocument();
    expect(
      within(conversationPanel).queryByTestId('desktop-conversation-history-conv-1-item-speaker-avatar-event-requested'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/conversation:\s*conv-1/i)).not.toBeInTheDocument();
  });

  it('falls back to emoji + title for non-speaking history items', () => {
    const snapshot = createFixtureSnapshot();
    const agent = snapshot.agents[0]!;
    renderOverlay(agent, snapshot, false, createReadyHistory());

    expect(screen.getByText('Craft complete')).toBeInTheDocument();
    expect(screen.queryByTestId('desktop-agent-history-item-speaker-avatar-event-new')).not.toBeInTheDocument();
  });

  it('keeps replace-failure retry affordances visible for empty nested conversation history', () => {
    const snapshot = createFixtureSnapshot();
    const agent = snapshot.agents[0]!;
    const history: HistoryCacheEntry = {
      status: 'ready',
      request: {
        limit: 20,
        merge: 'replace',
      },
      last_fetched_at: 1_780_000_010_000,
      response: {
        items: [
          {
            event_id: 'event-conv',
            type: 'conversation_requested',
            occurred_at: 1_780_000_020_000,
            agent_ids: ['alice', 'bob'],
            conversation_id: 'conv-1',
            summary: {
              emoji: '📨',
              title: 'Conversation requested',
              text: 'Alice asked Bob for a chat.',
            },
            detail: {
              initiator_agent_id: 'alice',
              target_agent_id: 'bob',
              message: 'Alice asked Bob for a chat.',
            },
          },
        ],
      },
    };
    const fetchHistory = vi.fn();

    render(
      <AgentOverlay
        agent={agent}
        snapshot={snapshot}
        history={history}
        historyCache={{
          'conversation:conv-1': {
            status: 'error',
            request: {
              limit: 50,
              merge: 'replace',
            },
            response: {
              items: [],
            },
            last_fetched_at: 1_780_000_010_000,
            error_at: 1_780_000_020_000,
          },
        }}
        expandedConversationIds={{ 'conv-1': true }}
        fetchHistory={fetchHistory}
        onToggleConversationExpanded={() => undefined}
      />,
    );

    expect(screen.getByTestId('desktop-conversation-history-conv-1-empty')).toHaveTextContent('履歴はまだありません');
    expect(screen.getByTestId('desktop-conversation-history-conv-1-warning')).toHaveTextContent('更新に失敗しました');

    fireEvent.click(screen.getByTestId('desktop-conversation-history-conv-1-warning-retry'));

    expect(fetchHistory).toHaveBeenCalledWith({ conversation_id: 'conv-1' }, { limit: 50, merge: 'replace' });
  });
});
