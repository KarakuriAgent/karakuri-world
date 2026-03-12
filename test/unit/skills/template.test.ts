import { describe, expect, it } from 'vitest';

import {
  generateApiSkillTemplate,
  generateMcpClientConfig,
  generateMcpSkillGuideline,
} from '../../../src/skills/template.js';

const params = {
  worldName: 'Clockwork City',
  worldDescription: '歯車が鳴り続ける街です。\n蒸気と魔法が共存しています。',
  agentName: 'Alice',
  apiKey: 'karakuri_test_key',
  apiBaseUrl: 'https://example.com/api/',
  mcpEndpoint: 'https://example.com/mcp',
};

describe('skill templates', () => {
  it('renders the API skill template with concrete endpoints', () => {
    const template = generateApiSkillTemplate(params);

    expect(template).toContain('# Clockwork City');
    expect(template).toContain('Authorization: Bearer karakuri_test_key');
    expect(template).toContain('POST https://example.com/api/agents/move');
    expect(template).not.toContain('/agents/join');
    expect(template).not.toContain('/agents/leave');
  });

  it('renders MCP guidance and client configuration', () => {
    const guideline = generateMcpSkillGuideline(params);
    const clientConfig = JSON.parse(generateMcpClientConfig(params)) as {
      mcpServers: {
        'karakuri-world': {
          url: string;
          headers: {
            Authorization: string;
          };
        };
      };
    };

    expect(guideline).toContain('- 名前: Alice');
    expect(guideline).toContain('Discordチャンネルに届く通知を読み');
    expect(clientConfig).toEqual({
      mcpServers: {
        'karakuri-world': {
          url: 'https://example.com/mcp',
          headers: {
            Authorization: 'Bearer karakuri_test_key',
          },
        },
      },
    });
  });
});
