import type { ToolExecutionOptions } from '@ai-sdk/provider-utils';
import { describe, expect, it, vi } from 'vitest';

import {
  createKarakuriWorldTools,
  karakuriWorldInputSchema,
  KarakuriWorldApiError,
  KarakuriWorldResponseError,
} from '../../src/karakuri-world-tools.js';

const DEFAULT_OPTIONS: ToolExecutionOptions = {
  toolCallId: 'tool-1',
  messages: [],
};

const EXPECTED_TOOL_NAMES = [
  'karakuri_world_get_perception',
  'karakuri_world_get_available_actions',
  'karakuri_world_get_map',
  'karakuri_world_get_world_agents',
  'karakuri_world_move',
  'karakuri_world_action',
  'karakuri_world_wait',
  'karakuri_world_conversation_start',
  'karakuri_world_conversation_accept',
  'karakuri_world_conversation_reject',
  'karakuri_world_conversation_speak',
  'karakuri_world_end_conversation',
  'karakuri_world_server_event_select',
] as const;

describe('karakuri-world tools', () => {
  it('exports dedicated operation-specific tools and keeps the combined schema strict', () => {
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      fetch: vi.fn(),
    });

    expect(Object.keys(tools)).toEqual(EXPECTED_TOOL_NAMES);
    expect(karakuriWorldInputSchema.parse({ operation: 'move', target_node_id: '1-2' })).toEqual({
      operation: 'move',
      target_node_id: '1-2',
    });
    expect(karakuriWorldInputSchema.parse({ operation: 'wait', duration: '3' })).toEqual({
      operation: 'wait',
      duration: 3,
    });
    expect(() => karakuriWorldInputSchema.parse({ operation: 'get_map', extra: true })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({ operation: 'wait', duration: '1000ms' })).toThrow();
  });

  it('posts move requests with bearer auth and returns the API result directly', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          from_node_id: '1-1',
          to_node_id: '1-2',
          arrives_at: 42,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api/',
      apiKey: 'secret',
      fetch,
    });

    const result = await tools.karakuri_world_move.execute!(
      { target_node_id: '1-2' },
      DEFAULT_OPTIONS,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/api/agents/move',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ target_node_id: '1-2' }),
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(result).toEqual({
      from_node_id: '1-1',
      to_node_id: '1-2',
      arrives_at: 42,
    });
  });

  it('uses GET endpoints without sending a request body for read operations', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          message: '正常に受け付けました。結果が通知されるまで待機してください。',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      fetch,
    });

    const result = await tools.karakuri_world_get_map.execute!({}, DEFAULT_OPTIONS);

    expect(fetch).toHaveBeenCalledTimes(1);
    const firstCall = fetch.mock.calls[0];
    if (!firstCall) {
      throw new Error('Expected fetch to be called.');
    }

    const [requestUrl, requestInit] = firstCall;

    expect(requestUrl).toBe('https://example.com/api/agents/map');
    expect(requestInit).toMatchObject({
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer secret',
      },
    });
    expect(requestInit).not.toHaveProperty('body');
    expect(result).toEqual({
      ok: true,
      message: '正常に受け付けました。結果が通知されるまで待機してください。',
    });
  });

  it('accepts notification acknowledgements for perception requests', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          message: '正常に受け付けました。結果が通知されるまで待機してください。',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      fetch,
    });

    const result = await tools.karakuri_world_get_perception.execute!({}, DEFAULT_OPTIONS);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      message: '正常に受け付けました。結果が通知されるまで待機してください。',
    });
  });

  it('retries once on transient network failures', async () => {
    const transientError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ completes_at: 123 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      fetch,
    });

    const result = await tools.karakuri_world_wait.execute!(
      { duration: 3 },
      DEFAULT_OPTIONS,
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ completes_at: 123 });
  });

  it('normalizes numeric-string wait durations before sending requests', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({ completes_at: 123 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      fetch,
    });

    const parsedInput = karakuriWorldInputSchema.parse({
      operation: 'wait',
      duration: '3',
    });
    if (parsedInput.operation !== 'wait') {
      throw new Error('Expected a wait input.');
    }
    const { operation: _operation, ...waitInput } = parsedInput;
    const result = await tools.karakuri_world_wait.execute!(waitInput, DEFAULT_OPTIONS);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/api/agents/wait',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ duration: 3 }),
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(result).toEqual({ completes_at: 123 });
  });

  it('returns a busy response instead of throwing for state_conflict errors', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          error: 'state_conflict',
          message: 'Agent is not idle',
        }),
        {
          status: 409,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      fetch,
    });

    const result = await tools.karakuri_world_action.execute!({ action_id: 'rest' }, DEFAULT_OPTIONS);

    expect(result).toEqual({
      status: 'busy',
      message: 'Agent is not idle',
      instruction: expect.stringContaining('再送しないでください'),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns a busy response instead of throwing for not_your_turn errors', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          error: 'not_your_turn',
          message: 'It is not your turn to speak.',
        }),
        {
          status: 409,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      fetch,
    });

    const result = await tools.karakuri_world_conversation_speak.execute!(
      { message: 'hello' },
      DEFAULT_OPTIONS,
    );

    expect(result).toEqual({
      status: 'busy',
      message: 'It is not your turn to speak.',
      instruction: expect.stringContaining('再送しないでください'),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws for non-busy 409 errors like target_unavailable', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          error: 'target_unavailable',
          message: 'Target agent cannot receive a conversation right now.',
        }),
        {
          status: 409,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      fetch,
    });

    let thrownError: unknown;
    try {
      await tools.karakuri_world_conversation_start.execute!(
        { target_agent_id: 'a-1', message: 'hello' },
        DEFAULT_OPTIONS,
      );
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(KarakuriWorldApiError);
    expect(thrownError).toMatchObject({
      status: 409,
      code: 'target_unavailable',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws for 400-level application errors', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          error: 'out_of_bounds',
          message: 'Destination is outside the map.',
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      fetch,
    });

    let thrownError: unknown;
    try {
      await tools.karakuri_world_move.execute!({ target_node_id: '99-99' }, DEFAULT_OPTIONS);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(KarakuriWorldApiError);
    expect(thrownError).toMatchObject({
      status: 400,
      code: 'out_of_bounds',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws response validation errors when a successful payload is malformed', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      fetch,
    });

    let thrownError: unknown;
    try {
      await tools.karakuri_world_conversation_start.execute!({
        target_agent_id: 'a-1',
        message: 'hi',
      }, DEFAULT_OPTIONS);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(KarakuriWorldResponseError);
    expect(thrownError).toMatchObject({
      status: 200,
      message: expect.stringContaining('Response validation failed'),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
