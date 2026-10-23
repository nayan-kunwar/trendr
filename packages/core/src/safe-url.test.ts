import { describe, expect, it } from 'vitest';

import { safeHttpUrl } from './safe-url.js';

describe('safeHttpUrl', () => {
  it('accepts absolute http and https URLs', () => {
    expect(safeHttpUrl('https://example.com/docs?q=1#top')).toBe(
      'https://example.com/docs?q=1#top',
    );
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com');
  });

  it('trims and collapses whitespace before validating', () => {
    expect(safeHttpUrl('  https://example.com/a  ')).toBe('https://example.com/a');
    expect(safeHttpUrl('https://example.com/a\n b')).toBe('https://example.com/a b');
  });

  it('rejects non-http schemes, relative values and empty input', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('JavaScript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHttpUrl('ftp://example.com/file')).toBeNull();
    expect(safeHttpUrl('//example.com')).toBeNull();
    expect(safeHttpUrl('/relative')).toBeNull();
    expect(safeHttpUrl('example.com')).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl('   ')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });
});
