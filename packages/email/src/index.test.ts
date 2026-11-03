import { describe, expect, it, vi } from 'vitest';

import { LogEmailSender, createEmailSender } from './index.js';

/**
 * L-2: the `log` provider used to call `console.info`, bypassing the
 * structured logger (and its redaction). It now requires a sink and writes the
 * same fields the other providers' callers log.
 */

describe('log email provider (L-2)', () => {
  it('writes structured fields through the injected logger', async () => {
    const info = vi.fn();
    const sent = await new LogEmailSender({ info }).send({
      to: 'reader@example.test',
      subject: 'Weekly digest',
      html: '<p>hello</p>',
      text: 'hello',
    });

    expect(sent.id).toMatch(/^log-\d+$/);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'reader@example.test',
        subject: 'Weekly digest',
        id: sent.id,
      }),
      expect.stringContaining('log provider'),
    );
  });

  it('refuses to create the log provider without a logger', () => {
    expect(() => createEmailSender({ provider: 'log', from: 'Trendr <t@example.test>' })).toThrow(
      /logger is required when EMAIL_PROVIDER=log/,
    );
  });
});
