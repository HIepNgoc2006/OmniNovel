import { Request } from 'express';

export const UNMATCHED_ROUTE_LABEL = '/__unmatched__';

/**
 * Normalizes HTTP route paths to protect Prometheus from cardinality explosion.
 * 
 * 1. Express Matched Route: If Express matched a registered controller/handler,
 *    returns the parameterized route template: req.baseUrl + req.route.path (e.g. /api/v1/stories/:id).
 * 
 * 2. Unmatched / 404 / Adversarial Route: If Express did not match any registered route
 *    (e.g., scanner bots, typos, random garbage URL attacks like /garbage-a8fj2ks),
 *    collapses all requests into a single strictly bounded label: '/__unmatched__'.
 *    This completely eliminates any risk of metric cardinality explosion.
 */
export function normalizeRoute(req: Request): string {
  // If Express did not match a defined route handler, collapse to bounded label
  if (!req.route || typeof req.route.path !== 'string') {
    return UNMATCHED_ROUTE_LABEL;
  }

  const baseUrl = req.baseUrl || '';
  const routePath = req.route.path;
  const combined = `${baseUrl}${routePath}`.replace(/\/+/g, '/');

  const normalized = combined.length > 1 && combined.endsWith('/') ? combined.slice(0, -1) : combined;
  return normalized || '/';
}
