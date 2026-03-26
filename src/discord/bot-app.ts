import {
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Guild,
  Interaction
} from "discord.js";
import { Logger } from "../logger";
import { PublicationManager } from "../services/publication-manager";
import { PublicationRecord, PublishModePreference } from "../types";
import { buildCommandDefinitions } from "./command-definitions";

export class BotApp {
  private readonly client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  constructor(
    private readonly guildId: string,
    private readonly allowedChannelId: string,
    private readonly discordBotToken: string,
    private readonly publicationManager: PublicationManager,
    private readonly logger: Logger
  ) {}

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      this.client.once(Events.ClientReady, async () => {
        try {
          const guild = await this.client.guilds.fetch(this.guildId);
          await this.registerCommands(guild);
          this.logger.info("Discord bot is ready.", {
            guildId: guild.id,
            commandCount: 4
          });
          settled = true;
          resolve();
        } catch (error) {
          const startupError = this.renderStartupError(error);
          this.logger.error("Discord startup failed.", {
            error: startupError.message
          });
          this.client.destroy();
          if (!settled) {
            settled = true;
            reject(startupError);
          }
        }
      });

      this.client.on(Events.InteractionCreate, async (interaction) => {
        await this.handleInteraction(interaction);
      });

      this.client.on(Events.Error, (error) => {
        this.logger.error("Discord client emitted an error.", {
          error: error.message
        });
      });

      void this.client.login(this.discordBotToken).catch((error) => {
        const startupError = this.renderStartupError(error);
        this.logger.error("Discord login failed.", {
          error: startupError.message
        });
        if (!settled) {
          settled = true;
          reject(startupError);
        }
      });
    });
  }

  private async registerCommands(guild: Guild): Promise<void> {
    await guild.commands.set(buildCommandDefinitions());
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    try {
      if (interaction.guildId !== this.guildId) {
        await interaction.reply({
          embeds: [
            this.buildErrorEmbed(
              "Wrong Server",
              "This bot is only configured for a different Discord server."
            )
          ]
        });
        return;
      }

      if (interaction.channelId !== this.allowedChannelId) {
        await interaction.reply({
          embeds: [
            this.buildErrorEmbed(
              "Wrong Channel",
              "This bot only accepts commands in the configured operations channel."
            )
          ]
        });
        return;
      }

      await interaction.deferReply();

      switch (interaction.commandName) {
        case "list":
          await this.handleList(interaction);
          return;
        case "status":
          await this.handleStatus(interaction);
          return;
        case "publish":
          await this.handlePublish(interaction);
          return;
        case "unpublish":
          await this.handleUnpublish(interaction);
          return;
        default:
          await interaction.editReply({
            embeds: [this.buildErrorEmbed("Unknown Command", "That command is not supported.")]
          });
      }
    } catch (error) {
      const message = this.renderError(error);
      this.logger.error("Discord interaction failed.", {
        commandName: interaction.commandName,
        error: message
      });

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          embeds: [this.buildErrorEmbed("Operation Failed", message)]
        });
        return;
      }

      await interaction.reply({
        embeds: [this.buildErrorEmbed("Operation Failed", message)]
      });
    }
  }

  private async handleList(interaction: ChatInputCommandInteraction): Promise<void> {
    const records = await this.publicationManager.listPublications();
    await interaction.editReply({
      embeds: [this.buildListEmbed(records)]
    });
  }

  private async handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
    const id = interaction.options.getString("id");
    if (!id) {
      const records = await this.publicationManager.listPublications();
      await interaction.editReply({
        embeds: [this.buildListEmbed(records)]
      });
      return;
    }

    const record = await this.publicationManager.getPublication(id);
    if (!record) {
      await interaction.editReply({
        embeds: [
          this.buildWarningEmbed(
            "Publication Not Found",
            `No publication was found for ID \`${id}\`.`
          )
        ]
      });
      return;
    }

    await interaction.editReply({
      embeds: [this.buildStatusEmbed(record)]
    });
  }

  private async handlePublish(interaction: ChatInputCommandInteraction): Promise<void> {
    const target = interaction.options.getString("target", true);
    const mode = (interaction.options.getString("mode") ?? "auto") as PublishModePreference;
    const actor = {
      discordUserId: interaction.user.id,
      discordTag: interaction.user.tag
    };

    const result = await this.publicationManager.publishTarget(target, mode, actor);
    await interaction.editReply({
      embeds: [this.buildPublishEmbed(result.record, result.alreadyPublished)]
    });
  }

  private async handleUnpublish(interaction: ChatInputCommandInteraction): Promise<void> {
    const id = interaction.options.getString("id", true);
    const actor = {
      discordUserId: interaction.user.id,
      discordTag: interaction.user.tag
    };

    const result = await this.publicationManager.unpublish(id, actor);
    await interaction.editReply({
      embeds: [this.buildUnpublishEmbed(result.record, result.alreadyInactive)]
    });
  }

  private buildListEmbed(records: PublicationRecord[]): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setColor(0x4f8cff)
      .setTitle("Cloudcord Publications")
      .setDescription(
        records.length === 0
          ? "No active or stale publications found."
          : "Showing active and stale publications."
      )
      .setTimestamp(new Date());

    if (records.length === 0) {
      return embed;
    }

    const visibleRecords = records.slice(0, 15);
    for (const record of visibleRecords) {
      embed.addFields({
        name: `[${record.status.toUpperCase()}] ${record.id}`,
        value: [
          `**Mode:** \`${record.mode}\``,
          `**Target:** \`${record.resolvedTarget}\``,
          `**Public URL:** ${this.formatUrl(record.publicUrl)}`
        ].join("\n"),
        inline: false
      });
    }

    if (records.length > visibleRecords.length) {
      embed.setFooter({
        text: `${records.length - visibleRecords.length} more publication(s) not shown`
      });
    }

    return embed;
  }

  private buildStatusEmbed(record: PublicationRecord): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setColor(this.statusColor(record.status))
      .setTitle(`Publication ${record.id}`)
      .setURL(record.publicUrl)
      .setDescription(record.status.toUpperCase())
      .addFields(
        {
          name: "Public URL",
          value: this.formatUrl(record.publicUrl),
          inline: false
        },
        {
          name: "Resolved Target",
          value: `\`${record.resolvedTarget}\``,
          inline: false
        },
        {
          name: "Mode",
          value: `\`${record.mode}\``,
          inline: true
        },
        {
          name: "Created",
          value: this.formatTimestamp(record.createdAt),
          inline: true
        },
        {
          name: "Updated",
          value: this.formatTimestamp(record.updatedAt),
          inline: true
        }
      )
      .setTimestamp(new Date(record.updatedAt));

    if (record.requestedTarget !== record.resolvedTarget) {
      embed.addFields({
        name: "Requested Target",
        value: `\`${record.requestedTarget}\``,
        inline: false
      });
    }

    if (record.hostname) {
      embed.addFields({
        name: "Hostname",
        value: `\`${record.hostname}\``,
        inline: true
      });
    }

    if (record.stoppedAt) {
      embed.addFields({
        name: "Stopped",
        value: this.formatTimestamp(record.stoppedAt),
        inline: true
      });
    }

    if (record.actorTag) {
      embed.addFields({
        name: "Last Actor",
        value: record.actorTag,
        inline: true
      });
    }

    if (record.exitReason) {
      embed.addFields({
        name: "Exit Reason",
        value: `\`${record.exitReason}\``,
        inline: false
      });
    }

    return embed;
  }

  private buildPublishEmbed(record: PublicationRecord, alreadyPublished: boolean): EmbedBuilder {
    return new EmbedBuilder()
      .setColor(alreadyPublished ? 0x4f8cff : 0x22c55e)
      .setTitle(alreadyPublished ? "Publication Already Active" : "Publication Created")
      .setURL(record.publicUrl)
      .setDescription(
        alreadyPublished
          ? "Cloudcord found an existing active publication for this target."
          : "The target is now exposed through Cloudflare Tunnel."
      )
      .addFields(
        {
          name: "ID",
          value: `\`${record.id}\``,
          inline: true
        },
        {
          name: "Mode",
          value: `\`${record.mode}\``,
          inline: true
        },
        {
          name: "Status",
          value: record.status.toUpperCase(),
          inline: true
        },
        {
          name: "Public URL",
          value: this.formatUrl(record.publicUrl),
          inline: false
        },
        {
          name: "Target",
          value: `\`${record.resolvedTarget}\``,
          inline: false
        }
      )
      .setTimestamp(new Date(record.updatedAt));
  }

  private buildUnpublishEmbed(record: PublicationRecord, alreadyInactive: boolean): EmbedBuilder {
    return new EmbedBuilder()
      .setColor(alreadyInactive ? 0xf59e0b : 0xef4444)
      .setTitle(alreadyInactive ? "Publication Already Inactive" : "Publication Stopped")
      .setURL(record.publicUrl)
      .setDescription(
        alreadyInactive
          ? "That publication was already inactive when the command was processed."
          : "The publication has been stopped and is no longer active."
      )
      .addFields(
        {
          name: "ID",
          value: `\`${record.id}\``,
          inline: true
        },
        {
          name: "Mode",
          value: `\`${record.mode}\``,
          inline: true
        },
        {
          name: "Status",
          value: record.status.toUpperCase(),
          inline: true
        },
        {
          name: "Public URL",
          value: this.formatUrl(record.publicUrl),
          inline: false
        },
        {
          name: "Target",
          value: `\`${record.resolvedTarget}\``,
          inline: false
        }
      )
      .setTimestamp(new Date(record.updatedAt));
  }

  private buildErrorEmbed(title: string, description: string): EmbedBuilder {
    return new EmbedBuilder()
      .setColor(0xef4444)
      .setTitle(title)
      .setDescription(description)
      .setTimestamp(new Date());
  }

  private buildWarningEmbed(title: string, description: string): EmbedBuilder {
    return new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle(title)
      .setDescription(description)
      .setTimestamp(new Date());
  }

  private statusColor(status: PublicationRecord["status"]): number {
    switch (status) {
      case "active":
        return 0x22c55e;
      case "inactive":
        return 0x6b7280;
      case "stale":
        return 0xf59e0b;
      case "error":
        return 0xef4444;
    }
  }

  private formatUrl(url: string): string {
    return url;
  }

  private formatTimestamp(isoTimestamp: string): string {
    const unix = Math.floor(new Date(isoTimestamp).getTime() / 1000);
    return `<t:${unix}:f>`;
  }

  private renderError(error: unknown): string {
    if (error instanceof Error) {
      return `Operation failed: ${error.message}`;
    }

    return "Operation failed with an unknown error.";
  }

  private renderStartupError(error: unknown): Error {
    if (isDiscordApiLikeError(error) && error.code === 10004) {
      return new Error(
        `Unknown guild "${this.guildId}". Check DISCORD_GUILD_ID and make sure the bot has been invited to that Discord server.`
      );
    }

    if (isDiscordApiLikeError(error) && error.code === 50001) {
      return new Error(
        `Missing access to guild "${this.guildId}". Make sure the bot is in that Discord server and has permission to register commands.`
      );
    }

    if (error instanceof Error) {
      return error;
    }

    return new Error(String(error));
  }
}

function isDiscordApiLikeError(error: unknown): error is Error & { code?: number } {
  return error instanceof Error && "code" in error;
}
