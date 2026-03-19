import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';

import { handleDiscordWebhook } from './bot.js';
import { config } from './config.js';
import { createLogger } from './logger.js';

export const DISCORD_WEBHOOK_PATH = '/webhooks/discord';
export const HEALTHCHECK_PATH = '/healthz';
const logger = createLogger('server');

export interface AgentServer {
  close(): Promise<void>;
  localWebhookUrl: string;
  port: number;
}

function isBodylessMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else if (value != null) {
      headers.set(key, value);
    }
  }

  const method = request.method ?? 'GET';
  const host = headers.get('host') ?? `127.0.0.1:${config.server.port}`;
  const url = new URL(request.url ?? '/', `http://${host}`);
  const body = isBodylessMethod(method) ? undefined : await readRequestBody(request);

  return new Request(url, {
    method,
    headers,
    body: body ? new Uint8Array(body) : undefined,
  });
}

async function writeWebResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  response.statusCode = webResponse.status;

  webResponse.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });

  if (webResponse.body == null) {
    response.end();
    return;
  }

  const body = Buffer.from(await webResponse.arrayBuffer());
  response.end(body);
}

function handleUnhandledTaskError(error: unknown): void {
  logger.error('Discord webhook background task failed.', error);
}

async function routeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  logger.debug('HTTP request', { method, path: url.pathname });

  if (method === 'GET' && url.pathname === HEALTHCHECK_PATH) {
    response.statusCode = 200;
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end('ok');
    return;
  }

  if (method === 'POST' && url.pathname === DISCORD_WEBHOOK_PATH) {
    const webRequest = await toWebRequest(request);
    const webResponse = await handleDiscordWebhook(webRequest, {
      waitUntil(task) {
        void task.catch(handleUnhandledTaskError);
      },
    });

    await writeWebResponse(response, webResponse);
    return;
  }

  response.statusCode = 404;
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.end('Not Found');
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function startServer(): Promise<AgentServer> {
  const server = createServer((request, response) => {
    void routeRequest(request, response).catch((error) => {
      logger.error('Failed to handle incoming HTTP request.', error);

      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader('content-type', 'text/plain; charset=utf-8');
      }

      response.end('Internal Server Error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };

    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.server.port, '0.0.0.0');
  });

  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Failed to determine HTTP server address.');
  }

  const localWebhookUrl = new URL(DISCORD_WEBHOOK_PATH, `http://127.0.0.1:${address.port}`).toString();

  return {
    async close() {
      await closeServer(server);
    },
    localWebhookUrl,
    port: address.port,
  };
}
