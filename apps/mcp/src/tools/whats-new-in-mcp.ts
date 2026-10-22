import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { ApiClient } from '../api-client.js';
import { WhatsNewOutputSchema, type WhatsNewOutput } from '../schemas.js';
import { formatNumber, formatSigned, markdownLink, truncate } from './markdown.js';
import { READ_ONLY_ANNOTATIONS } from './shared.js';

export const WhatsNewInMcpInput = z.object({
  sort: z.enum(['new', 'rising']).default('rising'),
  days: z.number().int().min(1).max(30).default(7),
  limit: z.number().int().min(1).max(50).default(15),
});

interface McpCandidate {
  id: string;
  name: string;
  description: string | null;
  url: string;
  current?: number;
  publishedAt?: string;
  delta7d?: number;
}

/** Registry page URLs encode the full server name; GitHub fallbacks do not. */
export function registryNameFromUrl(url: string): string | undefined {
  try {
    const match = /\/servers\/([^/]+)\/versions\/latest\/?$/.exec(new URL(url).pathname);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    // A malformed upstream URL simply means no registry name is available.
    return undefined;
  }
}

function renderWhatsNew(
  sort: 'new' | 'rising',
  days: number,
  items: WhatsNewOutput['items'],
): string {
  const heading =
    sort === 'new' ? `# New in MCP (last ${days} days)` : '# Fastest-rising MCP servers (7d)';
  if (items.length === 0) {
    return `${heading}\n\nNo MCP servers matched.`;
  }
  const lines = items.map((item) => {
    const meta: string[] = [];
    if (item.publishedAt) {
      meta.push(`published ${item.publishedAt.slice(0, 10)}`);
    }
    if (item.delta7d !== undefined) {
      meta.push(`Δ7d ${formatSigned(item.delta7d)}`);
    }
    if (item.current !== undefined) {
      meta.push(`${formatNumber(item.current)} current`);
    }
    if (item.registryName) {
      meta.push(`registry ${item.registryName}`);
    }
    const links = [
      item.repoUrl ? markdownLink('repo', item.repoUrl) : null,
      ...item.packages.map((pkg) => `${pkg.registryType}:${pkg.identifier}`),
    ].filter((value): value is string => value !== null);
    const details = [
      meta.join(' · '),
      item.description ? truncate(item.description) : '',
      links.join(', '),
    ]
      .filter(Boolean)
      .join(' — ');
    return `- ${markdownLink(item.name, item.url)}${details ? ` — ${details}` : ''}`;
  });
  return `${heading}\n\n${lines.join('\n')}`;
}

export function registerWhatsNewInMcp(server: McpServer, api: ApiClient): void {
  server.registerTool(
    'whats_new_in_mcp',
    {
      title: 'What is new in MCP',
      description: 'List newly published or fast-rising MCP servers / agent tools.',
      inputSchema: WhatsNewInMcpInput.shape,
      outputSchema: WhatsNewOutputSchema.shape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      const args = WhatsNewInMcpInput.parse(input);
      let candidates: McpCandidate[];
      if (args.sort === 'new') {
        const response = await api.getNewItems({ source: 'mcp', days: args.days });
        candidates = response.items.slice(0, args.limit).map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          url: item.url,
          ...(item.current === null ? {} : { current: item.current }),
          ...(item.upstreamCreatedAt === null ? {} : { publishedAt: item.upstreamCreatedAt }),
        }));
      } else {
        const response = await api.trending({
          source: 'mcp',
          window: '7d',
          kind: 'mcp_server',
          limit: args.limit,
        });
        candidates = response.data.map((entry) => ({
          id: entry.item.id,
          name: entry.item.displayName,
          description: entry.item.description,
          url: entry.item.url,
          current: entry.current,
          delta7d: entry.delta,
        }));
      }

      // Spec §18: at most 15 alias lookups per whats_new call. Keep the rest of
      // the list intact; those items simply have no repo/package enrichment.
      const aliasesById = new Map<
        string,
        Awaited<ReturnType<ApiClient['getAliases']>>['aliases']
      >();
      await Promise.all(
        candidates.slice(0, 15).map(async (candidate) => {
          try {
            const response = await api.getAliases(candidate.id);
            aliasesById.set(candidate.id, response.aliases);
          } catch {
            // Alias enrichment is best-effort; the MCP server still gets the item.
          }
        }),
      );

      const output: WhatsNewOutput = {
        items: candidates.map((candidate) => {
          const aliases = aliasesById.get(candidate.id) ?? [];
          const repo = aliases.find((alias) => alias.source === 'github' && alias.kind === 'repo');
          const packageMap = new Map<
            string,
            { registryType: 'npm' | 'pypi'; identifier: string }
          >();
          for (const alias of aliases) {
            if ((alias.source === 'npm' || alias.source === 'pypi') && alias.kind === 'package') {
              packageMap.set(`${alias.source}:${alias.externalId}`, {
                registryType: alias.source,
                identifier: alias.externalId,
              });
            }
          }
          const registryName = registryNameFromUrl(candidate.url);
          return {
            id: candidate.id,
            name: candidate.name,
            description: candidate.description,
            url: candidate.url,
            ...(candidate.current === undefined ? {} : { current: candidate.current }),
            ...(candidate.publishedAt === undefined ? {} : { publishedAt: candidate.publishedAt }),
            ...(candidate.delta7d === undefined ? {} : { delta7d: candidate.delta7d }),
            ...(repo === undefined ? {} : { repoUrl: repo.url }),
            ...(registryName === undefined ? {} : { registryName }),
            packages: [...packageMap.values()],
          };
        }),
      };
      return {
        content: [{ type: 'text', text: renderWhatsNew(args.sort, args.days, output.items) }],
        structuredContent: output,
      };
    },
  );
}
