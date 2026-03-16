import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { compactConversation, KEEP_RECENT_MESSAGES, MAX_MESSAGES, SUMMARY_PREFIX } from '../../src/compact.js';

function createMessages(count: number): ModelMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index + 1}`,
  }));
}

describe('compactConversation', () => {
  it('does not compact when the threshold is not exceeded', async () => {
    const summarize = vi.fn(async () => 'unused');

    await expect(
      compactConversation({
        messages: createMessages(MAX_MESSAGES),
        summarize,
      }),
    ).resolves.toBeNull();

    expect(summarize).not.toHaveBeenCalled();
  });

  it('summarizes older messages and keeps the recent tail', async () => {
    const messages = createMessages(MAX_MESSAGES + 3);
    const summarize = vi.fn(async () => 'summary text');

    const compacted = await compactConversation({
      messages,
      summarize,
    });

    expect(summarize).toHaveBeenCalledWith(messages.slice(0, -KEEP_RECENT_MESSAGES));
    expect(compacted).toEqual([
      {
        role: 'system',
        content: `${SUMMARY_PREFIX}\nsummary text`,
      },
      ...messages.slice(-KEEP_RECENT_MESSAGES),
    ]);
  });
});
