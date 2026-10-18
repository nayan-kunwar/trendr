import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { CACHE_CONTROL, ifNoneMatchMatches, registerEtag, weakEtag } from './etag.js';

describe('weakEtag (spec §9.4)', () => {
  it('is the sha1 of the body, weak-tagged', () => {
    expect(weakEtag('hello')).toBe('W/"aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d"');
  });

  it('hashes buffers byte-for-byte', () => {
    expect(weakEtag(Buffer.from('hello'))).toBe(weakEtag('hello'));
  });
});

describe('ifNoneMatchMatches (RFC 9110 §13.1.2)', () => {
  it('matches *', () => {
    expect(ifNoneMatchMatches('*', 'W/"x"')).toBe(true);
  });

  it('compares with the weak algorithm', () => {
    expect(ifNoneMatchMatches('W/"abc"', 'W/"abc"')).toBe(true);
    expect(ifNoneMatchMatches('"abc"', 'W/"abc"')).toBe(true);
    expect(ifNoneMatchMatches('W/"abc"', '"abc"')).toBe(true);
  });

  it('matches any member of a list', () => {
    expect(ifNoneMatchMatches('"other", W/"abc"', 'W/"abc"')).toBe(true);
  });

  it('does not match different tags or a missing header', () => {
    expect(ifNoneMatchMatches('W/"abc"', 'W/"def"')).toBe(false);
    expect(ifNoneMatchMatches(undefined, 'W/"abc"')).toBe(false);
  });
});

async function withApp(register: (app: FastifyInstance) => void): Promise<FastifyInstance> {
  const app = Fastify();
  registerEtag(app);
  register(app);
  await app.ready();
  return app;
}

describe('etag plugin', () => {
  it('sets a weak body-hash ETag and answers a matching request with 304', async () => {
    const app = await withApp((instance) => {
      instance.get('/doc', () => ({ hello: 'world' }));
    });
    try {
      const first = await app.inject({ method: 'GET', url: '/doc' });
      expect(first.statusCode).toBe(200);
      const etag = first.headers.etag;
      expect(etag).toBe(weakEtag(first.body));

      const second = await app.inject({
        method: 'GET',
        url: '/doc',
        headers: { 'if-none-match': etag ?? '' },
      });
      expect(second.statusCode).toBe(304);
      expect(second.body).toBe('');
      expect(second.headers.etag).toBe(etag);

      const mismatch = await app.inject({
        method: 'GET',
        url: '/doc',
        headers: { 'if-none-match': 'W/"other"' },
      });
      expect(mismatch.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('keeps a route-supplied ETag and applies the route Cache-Control on 200 and 304', async () => {
    const app = await withApp((instance) => {
      instance.get(
        '/board',
        { config: { cacheControl: CACHE_CONTROL.publicLong } },
        async (_request, reply) => {
          reply.header('etag', 'W/"lb-all-24h-2-deadbeef"');
          return { board: true };
        },
      );
    });
    try {
      const first = await app.inject({ method: 'GET', url: '/board' });
      expect(first.headers.etag).toBe('W/"lb-all-24h-2-deadbeef"');
      expect(first.headers['cache-control']).toBe(CACHE_CONTROL.publicLong);

      const second = await app.inject({
        method: 'GET',
        url: '/board',
        headers: { 'if-none-match': 'W/"lb-all-24h-2-deadbeef"' },
      });
      expect(second.statusCode).toBe(304);
      expect(second.headers['cache-control']).toBe(CACHE_CONTROL.publicLong);
    } finally {
      await app.close();
    }
  });

  it('ignores non-GET methods and non-200 responses', async () => {
    const app = await withApp((instance) => {
      instance.post('/doc', () => ({ created: true }));
      instance.get('/missing', (_request, reply) => reply.code(404).send({}));
    });
    try {
      const posted = await app.inject({ method: 'POST', url: '/doc' });
      expect(posted.headers.etag).toBeUndefined();

      const missing = await app.inject({ method: 'GET', url: '/missing' });
      expect(missing.headers.etag).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
