import { describe, expect, it } from 'vitest';

import { topicLabel } from '@/lib/format';

describe('topicLabel', () => {
  it('uses acronym casing and keeps multi-word slugs readable', () => {
    expect(topicLabel('mcp')).toBe('MCP');
    expect(topicLabel('llm')).toBe('LLM');
    expect(topicLabel('ai-agents')).toBe('AI Agents');
    expect(topicLabel('claude-code')).toBe('Claude Code');
    expect(topicLabel('nodejs')).toBe('Node.js');
    expect(topicLabel('openai')).toBe('OpenAI');
  });
});
