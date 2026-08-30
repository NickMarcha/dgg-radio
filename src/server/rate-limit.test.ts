import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { consume, limitPerAddress, resetRateLimits } from './rate-limit';

describe('the fixed window', () => {
  beforeEach(() => {
    resetRateLimits();
  });

  const start = Date.UTC(2026, 7, 30, 12, 0, 0);

  it('allows exactly the stated number of requests', () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(consume('search:user:a', 3, start).allowed).toBe(true);
    }
    expect(consume('search:user:a', 3, start).allowed).toBe(false);
  });

  it('counts each caller separately', () => {
    expect(consume('search:user:a', 1, start).allowed).toBe(true);
    expect(consume('search:user:a', 1, start).allowed).toBe(false);
    expect(consume('search:user:b', 1, start).allowed).toBe(true);
  });

  // A person searching should not be locked out of queueing a track.
  it('counts each bucket separately', () => {
    expect(consume('search:user:a', 1, start).allowed).toBe(true);
    expect(consume('search:user:a', 1, start).allowed).toBe(false);
    expect(consume('lookup:user:a', 1, start).allowed).toBe(true);
  });

  it('reports whole seconds until the window resets', () => {
    consume('search:user:a', 1, start);
    const refused = consume('search:user:a', 1, start + 12_400);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBe(48);
  });

  it('lets the caller through again once the window has passed', () => {
    expect(consume('search:user:a', 1, start).allowed).toBe(true);
    expect(consume('search:user:a', 1, start + 59_999).allowed).toBe(false);
    expect(consume('search:user:a', 1, start + 60_000).allowed).toBe(true);
  });

  // The window is fixed rather than sliding, so a refusal does not extend it.
  it('does not push the reset out when a refused caller keeps trying', () => {
    consume('search:user:a', 1, start);
    consume('search:user:a', 1, start + 30_000);
    expect(consume('search:user:a', 1, start + 60_000).allowed).toBe(true);
  });
});

describe('placing the caller', () => {
  beforeEach(() => {
    resetRateLimits();
  });

  const app = new Hono().get('/probe', limitPerAddress('probe', 2), (context) =>
    context.text('ok'),
  );
  const call = (address?: string) =>
    app.request('/probe', address ? { headers: { 'CF-Connecting-IP': address } } : undefined);

  it('gives each address its own allowance', async () => {
    expect((await call('203.0.113.1')).status).toBe(200);
    expect((await call('203.0.113.1')).status).toBe(200);
    expect((await call('203.0.113.1')).status).toBe(429);
    expect((await call('203.0.113.9')).status).toBe(200);
  });

  // The tunnel always sets the header. A caller arriving without one must still
  // be served rather than meeting the error `getConnInfo` throws on its own.
  it('serves a caller it cannot place', async () => {
    expect((await call()).status).toBe(200);
  });
});
