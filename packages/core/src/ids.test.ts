import { describe, expect, it } from 'vitest';

import { ValidationError } from './errors.js';
import {
  mcpGitHubFallback,
  mcpNpmFallback,
  normalizeArxivId,
  normalizeGitHubRepo,
  normalizeHuggingFaceId,
  normalizeMcpName,
  normalizeNpmPackage,
  normalizePyPiName,
} from './ids.js';

describe('normalizeGitHubRepo (spec §5.4)', () => {
  it('lowercases owner and name', () => {
    expect(normalizeGitHubRepo('Vercel/Next.js')).toBe('vercel/next.js');
    expect(normalizeGitHubRepo('FACEBOOK/React')).toBe('facebook/react');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeGitHubRepo('  sindresorhus/ky  ')).toBe('sindresorhus/ky');
  });

  it('leaves canonical ids untouched', () => {
    expect(normalizeGitHubRepo('vercel/next.js')).toBe('vercel/next.js');
    expect(normalizeGitHubRepo('huggingface/transformers')).toBe('huggingface/transformers');
  });

  it.each(['no-slash', '/name', 'owner/', 'a/b/c', 'owner /name'])(
    'rejects "%s" with a ValidationError',
    (input) => {
      expect(() => normalizeGitHubRepo(input)).toThrow(ValidationError);
    },
  );
});

describe('normalizeNpmPackage (spec §5.4)', () => {
  it('lowercases the published name', () => {
    expect(normalizeNpmPackage('React')).toBe('react');
    expect(normalizeNpmPackage('TypeScript')).toBe('typescript');
  });

  it('keeps scoped names together, lowercased', () => {
    expect(normalizeNpmPackage('@ModelContextProtocol/SDK')).toBe('@modelcontextprotocol/sdk');
    expect(normalizeNpmPackage('@modelcontextprotocol/sdk')).toBe('@modelcontextprotocol/sdk');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeNpmPackage('  @scope/pkg  ')).toBe('@scope/pkg');
  });
});

describe('normalizePyPiName (PEP 503, spec §5.4)', () => {
  it('lowercases and collapses [-_.] runs to a single dash', () => {
    expect(normalizePyPiName('Sentence_Transformers')).toBe('sentence-transformers');
    expect(normalizePyPiName('zope.interface')).toBe('zope-interface');
    expect(normalizePyPiName('A--B..__C')).toBe('a-b-c');
    expect(normalizePyPiName('ruamel.yaml.clib')).toBe('ruamel-yaml-clib');
  });

  it('is idempotent on already-normalized names', () => {
    expect(normalizePyPiName('sentence-transformers')).toBe('sentence-transformers');
    expect(normalizePyPiName(normalizePyPiName('Django_REST.Framework'))).toBe(
      'django-rest-framework',
    );
  });
});

describe('normalizeHuggingFaceId (spec §5.4)', () => {
  it('pluralizes the kind and keeps the repo id', () => {
    expect(normalizeHuggingFaceId('model', 'google/embeddinggemma-2')).toBe(
      'models/google/embeddinggemma-2',
    );
    expect(normalizeHuggingFaceId('dataset', 'squad')).toBe('datasets/squad');
    expect(normalizeHuggingFaceId('space', 'acme/chat-demo')).toBe('spaces/acme/chat-demo');
  });
});

describe('normalizeArxivId (spec §5.4)', () => {
  it('strips the version suffix', () => {
    expect(normalizeArxivId('2610.21185v3')).toBe('2610.21185');
    expect(normalizeArxivId('2610.21185v1')).toBe('2610.21185');
    expect(normalizeArxivId('hep-th/9901001v12')).toBe('hep-th/9901001');
    expect(normalizeArxivId('2610.21185V2')).toBe('2610.21185');
  });

  it('leaves ids without a version untouched', () => {
    expect(normalizeArxivId('2610.21185')).toBe('2610.21185');
    expect(normalizeArxivId('hep-th/9901001')).toBe('hep-th/9901001');
  });

  it('does not strip digits that are part of the id', () => {
    expect(normalizeArxivId('1207.7214')).toBe('1207.7214');
  });
});

describe('MCP external ids (spec §5.4)', () => {
  it('trims the registry name', () => {
    expect(normalizeMcpName(' io.github.owner/server ')).toBe('io.github.owner/server');
  });

  it('builds github: fallbacks from a normalized repo', () => {
    expect(mcpGitHubFallback('Acme/Weather-MCP')).toBe('github:acme/weather-mcp');
  });

  it('builds npm: fallbacks from a normalized package', () => {
    expect(mcpNpmFallback('@Acme/Weather-MCP')).toBe('npm:@acme/weather-mcp');
  });
});
