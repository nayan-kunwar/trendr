import { describe, expect, it } from 'vitest';

import { McpRegistryEntrySchema, McpRegistryListSchema } from '../../src/mcp/schemas.js';
import {
  MCP_REGISTRY_BASE_V0,
  MCP_REGISTRY_BASE_V01,
  mcpServerPageUrl,
  mcpServersUrl,
} from '../../src/mcp/urls.js';
import { CONTRACT_ENABLED, contractFetch, contractJson } from './helpers.js';

const describeContract = describe.skipIf(!CONTRACT_ENABLED);

describeContract('MCP Registry upstream contract (spec §7.3.6)', () => {
  it('validates v0.1 list pagination and one active server detail', async () => {
    const list = await contractFetch(
      mcpServersUrl(MCP_REGISTRY_BASE_V01, { limit: 10, includeDeleted: true }),
    );
    const listBody = McpRegistryListSchema.parse(contractJson(list.text));
    const entries = listBody.servers ?? [];
    expect(entries.length).toBeGreaterThan(0);

    const active = entries.find(
      (entry) => entry._meta['io.modelcontextprotocol.registry/official'].status === 'active',
    );
    expect(active).toBeDefined();
    if (active === undefined) return;

    const detail = await contractFetch(mcpServerPageUrl(active.server.name));
    const detailBody = McpRegistryEntrySchema.parse(contractJson(detail.text));
    expect(detailBody.server.name).toBe(active.server.name);
  });

  it('validates the v0 fallback list endpoint', async () => {
    const response = await contractFetch(
      mcpServersUrl(MCP_REGISTRY_BASE_V0, { limit: 1, includeDeleted: true }),
    );
    const body = McpRegistryListSchema.parse(contractJson(response.text));
    expect((body.servers ?? []).length).toBeGreaterThan(0);
  });
});
