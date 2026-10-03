import { Request } from 'express';
import { normalizeRoute } from '../utils/route-normalizer';

describe('Route Normalization & Cardinality Invariant (Gate 6.4.4)', () => {
  it('should use Express matched route pattern instead of raw URL parameter values', () => {
    const mockReq = {
      baseUrl: '/api/v1/stories',
      route: { path: '/:id' },
      originalUrl: '/api/v1/stories/550e8400-e29b-41d4-a716-446655440000?include=chapters',
    } as unknown as Request;

    const normalized = normalizeRoute(mockReq);
    expect(normalized).toBe('/api/v1/stories/:id');
    expect(normalized).not.toContain('550e8400');
    expect(normalized).not.toContain('include=chapters');
  });

  it('should strip query strings and replace UUID with :id in fallback path', () => {
    const mockReq = {
      originalUrl: '/api/v1/stories/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11?sort=desc&limit=10',
    } as unknown as Request;

    const normalized = normalizeRoute(mockReq);
    expect(normalized).toBe('/api/v1/stories/:id');
    expect(normalized).not.toContain('a0eebc99');
    expect(normalized).not.toContain('sort=desc');
  });

  it('should replace nested UUIDs across multiple path segments', () => {
    const mockReq = {
      originalUrl: '/api/v1/stories/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/chapters/550e8400-e29b-41d4-a716-446655440000',
    } as unknown as Request;

    const normalized = normalizeRoute(mockReq);
    expect(normalized).toBe('/api/v1/stories/:id/chapters/:id');
  });

  it('should sanitize numeric IDs in path segments', () => {
    const mockReq = {
      originalUrl: '/api/v1/users/42891/profile?view=summary',
    } as unknown as Request;

    const normalized = normalizeRoute(mockReq);
    expect(normalized).toBe('/api/v1/users/:id/profile');
    expect(normalized).not.toContain('42891');
  });

  it('should normalize static endpoints cleanly', () => {
    const liveReq = {
      baseUrl: '',
      route: { path: '/health/live' },
      originalUrl: '/health/live',
    } as unknown as Request;

    expect(normalizeRoute(liveReq)).toBe('/health/live');

    const metricsReq = {
      originalUrl: '/metrics',
    } as unknown as Request;

    expect(normalizeRoute(metricsReq)).toBe('/metrics');
  });
});
