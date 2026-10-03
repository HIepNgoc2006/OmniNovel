import { Request } from 'express';

const UUID_REGEX = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const NUMERIC_REGEX = /(?<=\/)\d+(?=(\/|$))/g;
const HEX_ID_REGEX = /(?<=\/)[0-9a-fA-F]{24,64}(?=(\/|$))/g;

/**
 * Normalizes HTTP route paths to protect Prometheus from cardinality explosion.
 * 
 * 1. Prioritizes Express route template: req.baseUrl + req.route.path (e.g. /api/v1/stories/:id)
 * 2. Fallback for unmatched/404 routes: Strips query strings and replaces dynamic segments (UUID, numeric IDs, hex IDs) with :id
 */
export function normalizeRoute(req: Request): string {
  // 1. If Express matched a route definition, use its route pattern
  if (req.route && typeof req.route.path === 'string') {
    const baseUrl = req.baseUrl || '';
    const routePath = req.route.path;
    const combined = `${baseUrl}${routePath}`.replace(/\/+/g, '/');
    return combined.length > 1 && combined.endsWith('/') ? combined.slice(0, -1) : combined;
  }

  // 2. Fallback: sanitize raw URL path (strip query params, normalize dynamic UUID/numeric segments)
  const rawUrl = req.originalUrl || req.url || '/';
  const pathname = rawUrl.split('?')[0].split('#')[0];

  const sanitized = pathname
    .replace(UUID_REGEX, ':id')
    .replace(HEX_ID_REGEX, ':id')
    .replace(NUMERIC_REGEX, ':id')
    .replace(/\/+/g, '/');

  return sanitized.length > 1 && sanitized.endsWith('/') ? sanitized.slice(0, -1) : (sanitized || '/');
}
