import type { IncomingMessage, ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { WorldEngine } from '../engine/world-engine.js';
import type { AgentRegistration } from '../types/agent.js';
import { WorldError, toErrorResponse } from '../types/api.js';
import { createMcpToolDefinitions } from './tools.js';

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

function writeJsonResponse(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) {
    return;
  }

  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (status === 401) {
    res.setHeader('www-authenticate', 'Bearer');
  }
  res.end(JSON.stringify(payload));
}

export function authenticateMcpRequest(engine: WorldEngine, authorizationHeader?: string): AgentRegistration {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    throw new WorldError(401, 'unauthorized', 'Missing bearer token.');
  }

  const apiKey = authorizationHeader.slice('Bearer '.length);
  const registration = engine.getAgentByApiKey(apiKey);
  if (!registration) {
    throw new WorldError(401, 'unauthorized', 'Invalid bearer token.');
  }

  return registration;
}

export function createMcpServer(engine: WorldEngine, agentId: string): McpServer {
  const server = new McpServer({
    name: 'karakuri-world',
    version: '0.1.0',
  });

  for (const tool of createMcpToolDefinitions(engine, agentId)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (arguments_) => tool.execute(arguments_),
    );
  }

  return server;
}

export class McpServerManager {
  private readonly sessions = new Map<string, Promise<McpSession>>();

  constructor(private readonly engine: WorldEngine) {}

  async handleRequest(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> {
    try {
      const registration = authenticateMcpRequest(this.engine, req.headers.authorization);
      const session = await this.getSession(registration.agent_id);
      await session.transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      if (error instanceof WorldError) {
        writeJsonResponse(res, error.status, toErrorResponse(error));
        return;
      }

      console.error(error);
      writeJsonResponse(res, 500, toErrorResponse(new WorldError(500, 'state_conflict', 'Internal server error.')));
    }
  }

  async close(): Promise<void> {
    const sessions = await Promise.all([...this.sessions.values()]);
    this.sessions.clear();

    await Promise.allSettled(
      sessions.flatMap((session) => [session.server.close(), session.transport.close()]),
    );
  }

  private getSession(agentId: string): Promise<McpSession> {
    let session = this.sessions.get(agentId);
    if (!session) {
      session = this.createSession(agentId).catch((error) => {
        this.sessions.delete(agentId);
        throw error;
      });
      this.sessions.set(agentId, session);
    }

    return session;
  }

  private async createSession(agentId: string): Promise<McpSession> {
    const server = createMcpServer(this.engine, agentId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    return { server, transport };
  }
}
