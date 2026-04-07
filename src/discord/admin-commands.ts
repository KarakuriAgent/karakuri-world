import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

import type { WorldEngine } from '../engine/world-engine.js';
import { WorldError, type AdminAgentSummary } from '../types/api.js';
import type { AgentRegistration } from '../types/agent.js';
import type { DiscordBot } from './bot.js';

const MESSAGE_CHAR_LIMIT = 1900;
const AUTOCOMPLETE_LIMIT = 25;

const commands = [
  new SlashCommandBuilder()
    .setName('agent-list')
    .setDescription('登録済みエージェントを一覧表示します')
    .setDefaultMemberPermissions(null),
  new SlashCommandBuilder()
    .setName('agent-register')
    .setDescription('エージェントを登録します')
    .setDefaultMemberPermissions(null)
    .addStringOption((option) =>
      option
        .setName('discord_bot_id')
        .setDescription('エージェント Bot の Discord user ID')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('agent-delete')
    .setDescription('エージェント登録を削除します')
    .setDefaultMemberPermissions(null)
    .addStringOption((option) =>
      option
        .setName('agent_name')
        .setDescription('削除するエージェント名')
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName('fire-event')
    .setDescription('サーバーイベントを発火します')
    .setDefaultMemberPermissions(null)
    .addStringOption((option) =>
      option
        .setName('description')
        .setDescription('イベント説明')
        .setRequired(true)
        .setMaxLength(1000),
    ),
  new SlashCommandBuilder()
    .setName('login-agent')
    .setDescription('エージェントをログインさせます')
    .setDefaultMemberPermissions(null)
    .addStringOption((option) =>
      option
        .setName('agent_name')
        .setDescription('ログインするエージェント名')
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName('logout-agent')
    .setDescription('エージェントをログアウトさせます')
    .setDefaultMemberPermissions(null)
    .addStringOption((option) =>
      option
        .setName('agent_name')
        .setDescription('ログアウトするエージェント名')
        .setRequired(true)
        .setAutocomplete(true),
    ),
];

const knownCommandNames = new Set(commands.map((command) => command.name));

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function splitMessage(content: string, maxLength: number): string[] {
  const codePoints = [...content];
  if (codePoints.length <= maxLength) {
    return [content];
  }

  const chunks: string[] = [];
  for (let index = 0; index < codePoints.length; index += maxLength) {
    chunks.push(codePoints.slice(index, index + maxLength).join(''));
  }
  return chunks;
}

function escapeTableValue(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatAgentList(agents: AdminAgentSummary[]): string {
  if (agents.length === 0) {
    return '登録済みエージェントはありません。';
  }

  const lines = [
    '| agent_name | status | agent_id |',
    '| --- | --- | --- |',
    ...agents.map((agent) =>
      `| ${escapeTableValue(agent.agent_name)} | ${agent.is_logged_in ? 'logged_in' : 'logged_out'} | ${escapeTableValue(agent.agent_id)} |`,
    ),
  ];

  return ['登録済みエージェント一覧', ...lines].join('\n');
}

export class AdminCommandHandler {
  private readonly publicBaseUrl: string;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly engine: WorldEngine,
    publicBaseUrl: string,
    private readonly adminRoleId: string,
    private readonly worldAdminChannelId: string,
  ) {
    this.publicBaseUrl = trimTrailingSlash(publicBaseUrl);
  }

  async register(bot: DiscordBot): Promise<void> {
    if (this.unsubscribe) {
      return;
    }

    await bot.registerGuildCommands(commands.map((command) => command.toJSON() as RESTPostAPIChatInputApplicationCommandsJSONBody));
    this.unsubscribe = bot.registerInteractionHandler((interaction: Interaction) => {
      if (interaction.isChatInputCommand()) {
        if (!knownCommandNames.has(interaction.commandName)) {
          return;
        }
        void this.handleCommand(interaction).catch(async (error) => {
          console.error('Failed to handle admin command.', error);
          try {
            const message = '予期しないエラーが発生しました。';
            if (interaction.deferred || interaction.replied) {
              await interaction.editReply(message);
            } else {
              await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
            }
          } catch (replyError) {
            console.warn('Failed to send error reply to Discord interaction.', replyError);
          }
        });
      } else if (interaction.isAutocomplete()) {
        if (!knownCommandNames.has(interaction.commandName)) {
          return;
        }
        void this.handleAutocomplete(interaction).catch(async (error) => {
          console.error('Failed to handle autocomplete.', error);
          try {
            await interaction.respond([]);
          } catch (respondError) {
            console.warn('Failed to send empty autocomplete response.', respondError);
          }
        });
      }
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private isAllowed(interaction: ChatInputCommandInteraction | AutocompleteInteraction): { ok: true } | { ok: false; reason: string } {
    if (interaction.channelId !== this.worldAdminChannelId) {
      return { ok: false, reason: 'このコマンドは #world-admin でのみ使用できます。' };
    }

    const member = interaction.member;
    if (!member) {
      return { ok: false, reason: '権限がありません。' };
    }

    const permissions = member.permissions;
    if (permissions && typeof permissions !== 'string' && permissions.has(PermissionFlagsBits.Administrator)) {
      return { ok: true };
    }

    const roles = member.roles;
    const roleIds = Array.isArray(roles) ? roles : [...roles.cache.keys()];
    if (!roleIds.includes(this.adminRoleId)) {
      return { ok: false, reason: '権限がありません。' };
    }

    return { ok: true };
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
      console.error('Failed to defer reply.', error);
      return;
    }

    const allowed = this.isAllowed(interaction);
    if (!allowed.ok) {
      await interaction.editReply(allowed.reason);
      return;
    }

    try {
      switch (interaction.commandName) {
        case 'agent-list': {
          await this.sendReply(interaction, formatAgentList(this.engine.listAgentSummaries()));
          return;
        }
        case 'agent-register': {
          const registration = await this.engine.registerAgent({
            discord_bot_id: interaction.options.getString('discord_bot_id', true),
          });
          await this.sendReply(
            interaction,
            [
              'エージェントを登録しました。',
              `agent_id: ${registration.agent_id}`,
              `api_key: ${registration.api_key}`,
              `api_base_url: ${this.publicBaseUrl}/api`,
              `mcp_endpoint: ${this.publicBaseUrl}/mcp`,
            ].join('\n'),
          );
          return;
        }
        case 'agent-delete': {
          const agent = this.resolveAgentByName(interaction.options.getString('agent_name', true));
          const deleted = await this.engine.deleteAgent(agent.agent_id);
          if (!deleted) {
            throw new WorldError(404, 'not_found', `Agent not found: ${agent.agent_name}`);
          }

          await this.sendReply(interaction, `エージェントを削除しました: ${agent.agent_name}`);
          return;
        }
        case 'fire-event': {
          const description = interaction.options.getString('description', true).trim();
          if (!description) {
            throw new WorldError(400, 'validation_error', 'description は必須です。');
          }

          const result = this.engine.fireServerEvent(description);
          await this.sendReply(interaction, `サーバーイベントを発火しました: ${result.server_event_id}`);
          return;
        }
        case 'login-agent': {
          const agent = this.resolveAgentByName(interaction.options.getString('agent_name', true));
          const result = await this.engine.loginAgent(agent.agent_id);
          await this.sendReply(
            interaction,
            [
              `エージェントをログインしました: ${agent.agent_name}`,
              `channel_id: ${result.channel_id}`,
              `node_id: ${result.node_id}`,
            ].join('\n'),
          );
          return;
        }
        case 'logout-agent': {
          const agent = this.resolveAgentByName(interaction.options.getString('agent_name', true));
          await this.engine.logoutAgent(agent.agent_id);
          await this.sendReply(interaction, `エージェントをログアウトしました: ${agent.agent_name}`);
          return;
        }
      }
    } catch (error) {
      if (error instanceof WorldError) {
        try {
          await interaction.editReply(error.message);
        } catch (replyError) {
          console.warn('Failed to send WorldError reply.', { original: error.message, replyError });
        }
        return;
      }

      const message = error instanceof Error ? error.message : '予期しないエラーが発生しました。';
      console.error('Unexpected error in admin command.', error);
      try {
        await interaction.editReply(`エラー: ${message}`);
      } catch (replyError) {
        console.warn('Failed to send error reply to Discord interaction.', replyError);
      }
    }
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const allowed = this.isAllowed(interaction);
    if (!allowed.ok) {
      await interaction.respond([]);
      return;
    }

    const query = String(interaction.options.getFocused()).toLowerCase();
    const candidates = this.getAutocompleteCandidates(interaction.commandName)
      .filter((agent) => agent.agent_name.toLowerCase().includes(query))
      .slice(0, AUTOCOMPLETE_LIMIT)
      .map((agent) => ({ name: agent.agent_name, value: agent.agent_name }));

    await interaction.respond(candidates);
  }

  private getAutocompleteCandidates(commandName: string): AgentRegistration[] {
    const agents = this.engine.listAgents();
    switch (commandName) {
      case 'agent-delete':
        return agents;
      case 'login-agent':
        return agents.filter((agent) => !this.engine.state.isLoggedIn(agent.agent_id));
      case 'logout-agent':
        return agents.filter((agent) => this.engine.state.isLoggedIn(agent.agent_id));
      default:
        return [];
    }
  }

  private resolveAgentByName(agentName: string): AgentRegistration {
    const agent = this.engine.listAgents().find((entry) => entry.agent_name === agentName);
    if (!agent) {
      throw new WorldError(404, 'not_found', `Agent not found: ${agentName}`);
    }

    return agent;
  }

  private async sendReply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
    const chunks = splitMessage(content, MESSAGE_CHAR_LIMIT);
    await interaction.editReply(chunks[0]);
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
    }
  }
}
