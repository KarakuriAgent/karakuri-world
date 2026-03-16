import { generateText, type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

import { getConfig } from './config.js';

export const MAX_MESSAGES = 20;
export const KEEP_RECENT_MESSAGES = 10;
export const SUMMARY_PREFIX = '[Previous conversation summary]';

const summaryPrompt =
  'Summarize the following conversation concisely in the same language. '
  + 'Preserve key facts, decisions, and context about the virtual world.';

export interface CompactConversationOptions {
  messages: ModelMessage[];
  maxMessages?: number;
  keepRecentMessages?: number;
  summarize?: (messages: ModelMessage[]) => Promise<string>;
}

async function summarizeConversation(messages: ModelMessage[]): Promise<string> {
  const config = getConfig();
  const openai = createOpenAI({
    apiKey: config.openai.apiKey,
    baseURL: config.openai.baseURL,
  });

  const { text } = await generateText({
    model: openai.chat(config.openai.model),
    messages: [
      {
        role: 'system',
        content: summaryPrompt,
      },
      ...messages,
    ],
  });

  return text;
}

export async function compactConversation({
  messages,
  maxMessages = MAX_MESSAGES,
  keepRecentMessages = KEEP_RECENT_MESSAGES,
  summarize = summarizeConversation,
}: CompactConversationOptions): Promise<ModelMessage[] | null> {
  if (messages.length <= maxMessages) {
    return null;
  }

  const oldMessages = messages.slice(0, -keepRecentMessages);
  const recentMessages = messages.slice(-keepRecentMessages);
  const summary = await summarize(oldMessages);

  return [
    {
      role: 'system',
      content: `${SUMMARY_PREFIX}\n${summary}`,
    },
    ...recentMessages,
  ];
}
