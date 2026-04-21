import { toErrorResponse, WorldError } from '../types/api.js';

const shutdownError = new WorldError(503, 'service_unavailable', 'Server is shutting down.');

export function isRequestAllowedDuringShutdown(method: string, pathname: string): boolean {
  const normalizedMethod = method.toUpperCase();

  if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') {
    return false;
  }

  return pathname === '/health' || pathname === '/api/snapshot';
}

export function getShutdownErrorResponse() {
  return toErrorResponse(shutdownError);
}
