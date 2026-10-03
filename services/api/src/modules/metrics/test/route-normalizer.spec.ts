import { Request } from 'express';
import { normalizeRoute, UNMATCHED_ROUTE_LABEL } from '../utils/route-normalizer';

describe('Route Normalization & Cardinality Invariant (Gate 6.4.4)', () => {
  describe('Express Matched Routes (Parameterized Templates)', () => {
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

    it('should normalize static registered endpoints cleanly', () => {
      const liveReq = {
        baseUrl: '',
        route: { path: '/health/live' },
        originalUrl: '/health/live',
      } as unknown as Request;

      expect(normalizeRoute(liveReq)).toBe('/health/live');

      const authLoginReq = {
        baseUrl: '/auth',
        route: { path: '/login' },
        originalUrl: '/auth/login',
      } as unknown as Request;

      expect(normalizeRoute(authLoginReq)).toBe('/auth/login');
    });

    it('should strip trailing slashes consistently', () => {
      const mockReq = {
        baseUrl: '/api/v1/stories',
        route: { path: '/:storyId/chapters/' },
      } as unknown as Request;

      expect(normalizeRoute(mockReq)).toBe('/api/v1/stories/:storyId/chapters');
    });
  });

  describe('Unmatched Routes & Adversarial Cardinality Defense (P0.3)', () => {
    it('should collapse unmatched 404 routes without req.route into /__unmatched__', () => {
      const unmatchedReq = {
        originalUrl: '/api/v1/non-existent-endpoint',
      } as unknown as Request;

      expect(normalizeRoute(unmatchedReq)).toBe(UNMATCHED_ROUTE_LABEL);
    });

    it('should collapse arbitrary scanner/garbage paths into /__unmatched__', () => {
      const garbagePaths = [
        '/garbage-a8fj2ks',
        '/garbage-j28skq1',
        '/garbage-729ajdm',
        '/wp-login.php',
        '/phpmyadmin/index.php',
        '/.env',
        '/.git/config',
        '/random/nested/subpath/not/found',
      ];

      for (const path of garbagePaths) {
        const req = { originalUrl: path } as unknown as Request;
        expect(normalizeRoute(req)).toBe(UNMATCHED_ROUTE_LABEL);
      }
    });

    it('should strictly bound cardinality under heavy adversarial fuzzing attack (500 random URLs)', () => {
      const randomRoutes: string[] = [];
      const distinctNormalizedLabels = new Set<string>();

      // Generate 500 pseudo-random scanner/fuzzing URLs
      for (let i = 0; i < 500; i++) {
        const randomSegment1 = Math.random().toString(36).substring(2, 10);
        const randomSegment2 = Math.random().toString(36).substring(2, 8);
        const randomQuery = Math.random().toString(36).substring(2, 6);
        const url = `/${randomSegment1}/${randomSegment2}?param=${randomQuery}`;
        randomRoutes.push(url);

        const mockReq = { originalUrl: url } as unknown as Request;
        const normalized = normalizeRoute(mockReq);
        distinctNormalizedLabels.add(normalized);
      }

      // Assert that 500 distinct adversary URLs produced EXACTLY 1 unique label
      expect(randomRoutes.length).toBe(500);
      expect(distinctNormalizedLabels.size).toBe(1);
      expect(distinctNormalizedLabels.has(UNMATCHED_ROUTE_LABEL)).toBe(true);
      expect(Array.from(distinctNormalizedLabels)).toEqual([UNMATCHED_ROUTE_LABEL]);
    });
  });
});
