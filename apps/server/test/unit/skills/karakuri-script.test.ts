import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const KARAKURI_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../skills/api/karakuri.sh',
);

const BASE_URL = 'http://test';
const API_KEY = 'test-api-key';

interface DryRunResult {
  method: string;
  url: string;
  body: unknown;
}

async function runScript(...args: string[]): Promise<DryRunResult> {
  const { stdout } = await execFileAsync('bash', [KARAKURI_SCRIPT, ...args], {
    env: {
      ...process.env,
      KARAKURI_DRY_RUN: '1',
      KARAKURI_API_BASE_URL: BASE_URL,
      KARAKURI_API_KEY: API_KEY,
      PATH: process.env.PATH ?? '',
    },
  });
  return JSON.parse(stdout.trim());
}

describe('karakuri.sh dry-run payloads', () => {
  describe('move', () => {
    it('builds POST /agents/move payload with target_node_id', async () => {
      const result = await runScript('move', '3-2');
      expect(result).toEqual({
        method: 'POST',
        url: `${BASE_URL}/agents/move`,
        body: { target_node_id: '3-2' },
      });
    });
  });

  describe('action', () => {
    it('builds payload with action_id only when duration omitted', async () => {
      const result = await runScript('action', 'cook');
      expect(result.body).toEqual({ action_id: 'cook' });
    });

    it('includes duration_minutes when provided', async () => {
      const result = await runScript('action', 'cook', '20');
      expect(result.body).toEqual({ action_id: 'cook', duration_minutes: 20 });
    });
  });

  describe('use-item', () => {
    it('builds payload with item_id', async () => {
      const result = await runScript('use-item', 'apple');
      expect(result).toEqual({
        method: 'POST',
        url: `${BASE_URL}/agents/use-item`,
        body: { item_id: 'apple' },
      });
    });
  });

  describe('wait', () => {
    it('builds payload with numeric duration', async () => {
      const result = await runScript('wait', '3');
      expect(result.body).toEqual({ duration: 3 });
    });
  });

  describe('transfer', () => {
    it('--item builds payload with default quantity 1', async () => {
      const result = await runScript('transfer', 'bot-bob', '--item', 'apple');
      expect(result).toEqual({
        method: 'POST',
        url: `${BASE_URL}/agents/transfer`,
        body: {
          target_agent_id: 'bot-bob',
          item: { item_id: 'apple', quantity: 1 },
        },
      });
    });

    it('--item with --quantity overrides quantity', async () => {
      const result = await runScript('transfer', 'bot-bob', '--item', 'apple', '--quantity', '3');
      expect(result.body).toEqual({
        target_agent_id: 'bot-bob',
        item: { item_id: 'apple', quantity: 3 },
      });
    });

    it('--money builds payload with integer money', async () => {
      const result = await runScript('transfer', 'bot-bob', '--money', '120');
      expect(result.body).toEqual({
        target_agent_id: 'bot-bob',
        money: 120,
      });
    });

    it('rejects --item and --money used together', async () => {
      await expect(runScript('transfer', 'bot-bob', '--item', 'apple', '--money', '50'))
        .rejects.toThrow();
    });

    it('rejects when neither --item nor --money is given', async () => {
      await expect(runScript('transfer', 'bot-bob'))
        .rejects.toThrow();
    });
  });

  describe('transfer-accept / transfer-reject', () => {
    it('transfer-accept builds payload with transfer_id', async () => {
      const result = await runScript('transfer-accept', 'transfer-abc');
      expect(result).toEqual({
        method: 'POST',
        url: `${BASE_URL}/agents/transfer/accept`,
        body: { transfer_id: 'transfer-abc' },
      });
    });

    it('transfer-reject builds payload with transfer_id', async () => {
      const result = await runScript('transfer-reject', 'transfer-xyz');
      expect(result).toEqual({
        method: 'POST',
        url: `${BASE_URL}/agents/transfer/reject`,
        body: { transfer_id: 'transfer-xyz' },
      });
    });
  });

  describe('conversation-start / -accept / -reject / -join / -stay / -leave', () => {
    it('conversation-start joins multi-word message', async () => {
      const result = await runScript('conversation-start', 'bot-bob', 'hello', 'there');
      expect(result.body).toEqual({ target_agent_id: 'bot-bob', message: 'hello there' });
    });

    it('conversation-accept joins message words', async () => {
      const result = await runScript('conversation-accept', 'received', 'with', 'thanks');
      expect(result.body).toEqual({ message: 'received with thanks' });
    });

    it('conversation-reject sends empty body', async () => {
      const result = await runScript('conversation-reject');
      expect(result.body).toEqual({});
    });

    it('conversation-join sends conversation_id', async () => {
      const result = await runScript('conversation-join', 'conv-abc');
      expect(result.body).toEqual({ conversation_id: 'conv-abc' });
    });

    it('conversation-leave with no message sends empty body', async () => {
      const result = await runScript('conversation-leave');
      expect(result.body).toEqual({});
    });

    it('conversation-leave with message includes it', async () => {
      const result = await runScript('conversation-leave', 'see', 'you');
      expect(result.body).toEqual({ message: 'see you' });
    });
  });

  describe('conversation-speak', () => {
    it('builds basic payload without trailing flags', async () => {
      const result = await runScript('conversation-speak', 'bot-bob', 'hello', 'world');
      expect(result).toEqual({
        method: 'POST',
        url: `${BASE_URL}/agents/conversation/speak`,
        body: { message: 'hello world', next_speaker_agent_id: 'bot-bob' },
      });
    });

    it('attaches transfer with --item (default quantity)', async () => {
      const result = await runScript('conversation-speak', 'bot-bob', 'これあげる', '--item', 'apple');
      expect(result.body).toEqual({
        message: 'これあげる',
        next_speaker_agent_id: 'bot-bob',
        transfer: { item: { item_id: 'apple', quantity: 1 } },
      });
    });

    it('attaches transfer with --item and --quantity in either order', async () => {
      const a = await runScript('conversation-speak', 'bot-bob', 'これあげる', '--item', 'apple', '--quantity', '3');
      const b = await runScript('conversation-speak', 'bot-bob', 'これあげる', '--quantity', '3', '--item', 'apple');
      const expected = {
        message: 'これあげる',
        next_speaker_agent_id: 'bot-bob',
        transfer: { item: { item_id: 'apple', quantity: 3 } },
      };
      expect(a.body).toEqual(expected);
      expect(b.body).toEqual(expected);
    });

    it('attaches transfer with --money', async () => {
      const result = await runScript('conversation-speak', 'bot-bob', 'お金', '--money', '50');
      expect(result.body).toEqual({
        message: 'お金',
        next_speaker_agent_id: 'bot-bob',
        transfer: { money: 50 },
      });
    });

    it('attaches transfer_response with --accept', async () => {
      const result = await runScript('conversation-speak', 'bot-alice', 'thanks', '--accept');
      expect(result.body).toEqual({
        message: 'thanks',
        next_speaker_agent_id: 'bot-alice',
        transfer_response: 'accept',
      });
    });

    it('attaches transfer_response with --reject', async () => {
      const result = await runScript('conversation-speak', 'bot-alice', 'no thanks', '--reject');
      expect(result.body).toEqual({
        message: 'no thanks',
        next_speaker_agent_id: 'bot-alice',
        transfer_response: 'reject',
      });
    });

    it('rejects --item and --money used together', async () => {
      await expect(runScript('conversation-speak', 'bot-bob', 'mixed', '--item', 'apple', '--money', '10'))
        .rejects.toThrow();
    });

    it('rejects --accept combined with --item', async () => {
      await expect(runScript('conversation-speak', 'bot-bob', 'mixed', '--item', 'apple', '--accept'))
        .rejects.toThrow();
    });

    it('rejects --quantity without --item', async () => {
      await expect(runScript('conversation-speak', 'bot-bob', 'msg', '--quantity', '3'))
        .rejects.toThrow();
    });
  });

  describe('conversation-end', () => {
    it('builds basic end payload', async () => {
      const result = await runScript('conversation-end', 'bot-bob', 'goodbye', 'now');
      expect(result).toEqual({
        method: 'POST',
        url: `${BASE_URL}/agents/conversation/end`,
        body: { message: 'goodbye now', next_speaker_agent_id: 'bot-bob' },
      });
    });

    it('attaches transfer_response with --accept', async () => {
      const result = await runScript('conversation-end', 'bot-bob', 'I take it, thanks', '--accept');
      expect(result.body).toEqual({
        message: 'I take it, thanks',
        next_speaker_agent_id: 'bot-bob',
        transfer_response: 'accept',
      });
    });

    it('rejects --item on conversation-end (cannot open new transfer when ending)', async () => {
      await expect(runScript('conversation-end', 'bot-bob', 'bye', '--item', 'apple'))
        .rejects.toThrow();
    });

    it('rejects --money on conversation-end', async () => {
      await expect(runScript('conversation-end', 'bot-bob', 'bye', '--money', '50'))
        .rejects.toThrow();
    });
  });

  describe('GET notification commands', () => {
    it('perception sends GET /agents/perception', async () => {
      const result = await runScript('perception');
      expect(result).toEqual({
        method: 'GET',
        url: `${BASE_URL}/agents/perception`,
        body: null,
      });
    });

    it('actions sends GET /agents/actions', async () => {
      const result = await runScript('actions');
      expect(result.url).toBe(`${BASE_URL}/agents/actions`);
      expect(result.method).toBe('GET');
    });

    it('map sends GET /agents/map', async () => {
      const result = await runScript('map');
      expect(result.url).toBe(`${BASE_URL}/agents/map`);
    });

    it('world-agents sends GET /agents/world-agents', async () => {
      const result = await runScript('world-agents');
      expect(result.url).toBe(`${BASE_URL}/agents/world-agents`);
    });
  });
});
