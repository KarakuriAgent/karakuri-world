import { describe, expect, it, vi } from 'vitest';

import { createLazyMcpRuntime } from '../../src/lazy-mcp.js';

describe('lazy MCP runtime', () => {
  it('does not create an MCP client until a runtime tool set is requested', async () => {
    const close = vi.fn(async () => undefined);
    const createClient = vi.fn(async () => ({
      tools: async () => ({
        move: {
          execute: async () => ({ ok: true }),
        },
      }),
      close,
    }));

    const runtime = createLazyMcpRuntime({ createClient });

    expect(createClient).not.toHaveBeenCalled();
    expect(runtime.isLoaded()).toBe(false);

    const tools = await runtime.getTools();

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(runtime.isLoaded()).toBe(true);
    expect(tools).toMatchObject({
      move: {
        execute: expect.any(Function),
      },
    });

    await runtime.getTools();

    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('reconnects after reset', async () => {
    const close = vi.fn(async () => undefined);
    let callCount = 0;
    const createClient = vi.fn(async () => ({
      tools: async () => {
        callCount++;
        return {
          move: {
            execute: async () => ({ generation: callCount }),
          },
        };
      },
      close,
    }));

    const runtime = createLazyMcpRuntime({ createClient });

    const tools1 = await runtime.getTools();
    expect(createClient).toHaveBeenCalledTimes(1);

    await runtime.reset();
    expect(close).toHaveBeenCalledTimes(1);
    expect(runtime.isLoaded()).toBe(false);

    const tools2 = await runtime.getTools();
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(tools2).not.toBe(tools1);
  });

  it('closes the client and allows retry when loading fails', async () => {
    const close = vi.fn(async () => undefined);
    const createClient = vi
      .fn()
      .mockResolvedValueOnce({
        tools: async () => {
          throw new Error('boom');
        },
        close,
      })
      .mockResolvedValueOnce({
        tools: async () => ({
          action: {
            execute: async () => ({ ok: true }),
          },
        }),
        close,
      });

    const runtime = createLazyMcpRuntime({ createClient });

    await expect(runtime.getTools()).rejects.toThrow('boom');
    expect(close).toHaveBeenCalledTimes(1);
    expect(runtime.isLoaded()).toBe(false);

    const tools = await runtime.getTools();

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(runtime.isLoaded()).toBe(true);
    expect(tools).toMatchObject({
      action: {
        execute: expect.any(Function),
      },
    });
  });
});
