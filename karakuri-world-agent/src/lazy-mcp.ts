import type { ToolExecuteFunction } from '@ai-sdk/provider-utils';

export interface LazyMcpTool {
  execute?: ToolExecuteFunction<unknown, unknown>;
}

export interface LazyMcpClient {
  tools(): Promise<Record<string, LazyMcpTool>>;
  close(): Promise<void>;
}

export interface LazyMcpRuntimeOptions {
  createClient: () => Promise<LazyMcpClient>;
}

export interface LazyMcpRuntime {
  getTools(): Promise<Record<string, LazyMcpTool>>;
  close(): Promise<void>;
  reset(): Promise<void>;
  isLoaded(): boolean;
}

export function createLazyMcpRuntime({
  createClient,
}: LazyMcpRuntimeOptions): LazyMcpRuntime {
  let client: LazyMcpClient | undefined;
  let toolsPromise: Promise<Record<string, LazyMcpTool>> | undefined;

  return {
    async getTools(): Promise<Record<string, LazyMcpTool>> {
      if (!toolsPromise) {
        toolsPromise = (async () => {
          const activeClient = client ?? await createClient();
          client = activeClient;

          try {
            return await activeClient.tools();
          } catch (error) {
            if (client === activeClient) {
              client = undefined;
            }

            toolsPromise = undefined;
            await activeClient.close().catch(() => undefined);
            throw error;
          }
        })();
      }

      return await toolsPromise;
    },

    async close(): Promise<void> {
      toolsPromise = undefined;

      const activeClient = client;
      client = undefined;

      if (activeClient) {
        await activeClient.close();
      }
    },

    async reset(): Promise<void> {
      toolsPromise = undefined;

      const activeClient = client;
      client = undefined;

      if (activeClient) {
        await activeClient.close().catch(() => undefined);
      }
    },

    isLoaded(): boolean {
      return toolsPromise !== undefined;
    },
  };
}
