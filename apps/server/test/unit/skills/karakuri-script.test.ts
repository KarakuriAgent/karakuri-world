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
    it('builds payload with target only when items / money omitted', async () => {
      // 注: validation は server 側 schema で行うので script は payload を組むだけ
      const result = await runScript('transfer', 'bot-bob');
      expect(result).toEqual({
        method: 'POST',
        url: `${BASE_URL}/agents/transfer`,
        body: { target_agent_id: 'bot-bob' },
      });
    });

    it('includes items array when items_json provided', async () => {
      const result = await runScript('transfer', 'bot-bob', '[{"item_id":"apple","quantity":2}]');
      expect(result.body).toEqual({
        target_agent_id: 'bot-bob',
        items: [{ item_id: 'apple', quantity: 2 }],
      });
    });

    it('includes money as integer when provided', async () => {
      const result = await runScript('transfer', 'bot-bob', '', '120');
      expect(result.body).toEqual({
        target_agent_id: 'bot-bob',
        money: 120,
      });
    });

    it('combines items and money when both provided', async () => {
      const result = await runScript('transfer', 'bot-bob', '[{"item_id":"bread","quantity":1}]', '50');
      expect(result.body).toEqual({
        target_agent_id: 'bot-bob',
        items: [{ item_id: 'bread', quantity: 1 }],
        money: 50,
      });
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
    it('builds basic payload without extra_json', async () => {
      const result = await runScript('conversation-speak', 'bot-bob', 'hello', 'world');
      expect(result).toEqual({
        method: 'POST',
        url: `${BASE_URL}/agents/conversation/speak`,
        body: { message: 'hello world', next_speaker_agent_id: 'bot-bob' },
      });
    });

    it('merges extra_json transfer attachment when last arg is JSON', async () => {
      const extra = '{"transfer":{"items":[{"item_id":"apple","quantity":1}],"money":50}}';
      const result = await runScript('conversation-speak', 'bot-bob', 'これあげる', extra);
      expect(result.body).toEqual({
        message: 'これあげる',
        next_speaker_agent_id: 'bot-bob',
        transfer: {
          items: [{ item_id: 'apple', quantity: 1 }],
          money: 50,
        },
      });
    });

    it('merges transfer_response accept', async () => {
      const result = await runScript('conversation-speak', 'bot-alice', 'thanks', '{"transfer_response":"accept"}');
      expect(result.body).toEqual({
        message: 'thanks',
        next_speaker_agent_id: 'bot-alice',
        transfer_response: 'accept',
      });
    });

    it('treats single-word message as message even if it starts with {', async () => {
      // メッセージ 1 単語のみのケースは extra_json 検出をスキップする ($# >= 2 ガード)
      const result = await runScript('conversation-speak', 'bot-bob', '{hello}');
      expect(result.body).toEqual({
        message: '{hello}',
        next_speaker_agent_id: 'bot-bob',
      });
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

    it('merges transfer_response on end', async () => {
      const result = await runScript('conversation-end', 'bot-bob', 'I take it, thanks', '{"transfer_response":"accept"}');
      expect(result.body).toEqual({
        message: 'I take it, thanks',
        next_speaker_agent_id: 'bot-bob',
        transfer_response: 'accept',
      });
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
