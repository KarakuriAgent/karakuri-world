import type { ToolExecutionOptions } from '@ai-sdk/provider-utils';
import { describe, expect, it, vi } from 'vitest';

import { createMcpProxyTools } from '../../src/mcp-tools.js';

const DEFAULT_OPTIONS: ToolExecutionOptions = {
  toolCallId: 'tool-1',
  messages: [],
};

describe('MCP proxy tools', () => {
  it('defers runtime MCP loading until an MCP tool is executed', async () => {
    const getRuntimeTools = vi.fn(async () => ({
      move: {
        execute: async (input: unknown) => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify(input),
            },
          ],
        }),
      },
    }));

    const tools = createMcpProxyTools({ getRuntimeTools });
    const execute = tools.move.execute;

    expect(getRuntimeTools).not.toHaveBeenCalled();
    expect(execute).toBeDefined();

    if (!execute) {
      throw new Error('Missing move tool execute handler.');
    }

    const result = await execute({ target_node_id: '1-2' }, DEFAULT_OPTIONS);

    expect(getRuntimeTools).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ target_node_id: '1-2' }),
        },
      ],
    });
  });

  it('retries after resetting the runtime on MCP connection errors', async () => {
    const connectionError = new Error('Server not initialized');

    let callCount = 0;
    const getRuntimeTools = vi.fn(async () => ({
      move: {
        execute: async (input: unknown) => {
          callCount++;
          if (callCount === 1) {
            throw connectionError;
          }

          return { content: [{ type: 'text', text: 'ok' }] };
        },
      },
    }));
    const resetRuntime = vi.fn(async () => undefined);

    const tools = createMcpProxyTools({ getRuntimeTools, resetRuntime });
    const execute = tools.move.execute!;

    const result = await execute({ target_node_id: '1-2' }, DEFAULT_OPTIONS);

    expect(resetRuntime).toHaveBeenCalledTimes(1);
    expect(getRuntimeTools).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('throws non-connection errors without retrying', async () => {
    const appError = new Error('Agent is not idle');
    const getRuntimeTools = vi.fn(async () => ({
      move: {
        execute: async () => {
          throw appError;
        },
      },
    }));
    const resetRuntime = vi.fn(async () => undefined);

    const tools = createMcpProxyTools({ getRuntimeTools, resetRuntime });
    const execute = tools.move.execute!;

    await expect(execute({ target_node_id: '1-2' }, DEFAULT_OPTIONS)).rejects.toThrow('Agent is not idle');
    expect(resetRuntime).not.toHaveBeenCalled();
  });
});
