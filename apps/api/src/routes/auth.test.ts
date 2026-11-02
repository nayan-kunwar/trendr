import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { refreshCookieOptions, registerAuthRoutes } from './auth.js';

describe('refresh cookie configuration', () => {
  it('uses SameSite=Lax for same-site deployments by default', () => {
    expect(refreshCookieOptions('lax', true, 30)).toEqual({
      path: '/v1/auth',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60,
    });
  });

  it('supports SameSite=None for cross-site Render origins', () => {
    expect(refreshCookieOptions('none', true, 7)).toMatchObject({
      sameSite: 'none',
      secure: true,
      maxAge: 7 * 24 * 60 * 60,
    });
  });

  it('refuses SameSite=None when the cookie would not be Secure', () => {
    const app = Fastify();
    expect(() => {
      registerAuthRoutes(app, { cookieSameSite: 'none', cookieSecure: false });
    }).toThrow('requires secure cookies');
  });
});
