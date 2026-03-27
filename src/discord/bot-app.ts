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
import { AliasListItem, PublishModePreference, PublicationRecord } from "../types";
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
            commandCount: 5
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
        case "add":
          await this.handleAdd(interaction);
          return;
        case "remove":
          await this.handleRemove(interaction);
          return;
        case "list":
          await this.handleList(interaction);
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

  private async handleAdd(interaction: ChatInputCommandInteraction): Promise<void> {
    const name = interaction.options.getString("unique_name", true);
    const target = interaction.options.getString("local_url", true);
    const actor = this.actorFromInteraction(interaction);

    const result = await this.publicationManager.addAlias(name, target, actor);
    const item = await this.requireAlias(result.alias.name);
    await interaction.editReply({
      embeds: [this.buildAliasSavedEmbed(item, result.created)]
    });
  }

  private async handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
    const name = interaction.options.getString("unique_name", true);
    const actor = this.actorFromInteraction(interaction);

    const result = await this.publicationManager.removeAlias(name, actor);
    await interaction.editReply({
      embeds: [this.buildAliasRemovedEmbed(result.alias.name, result.unpublishedRecord)]
    });
  }

  private async handleList(interaction: ChatInputCommandInteraction): Promise<void> {
    const aliases = await this.publicationManager.listAliases();
    await interaction.editReply({
      embeds: [this.buildListEmbed(aliases)]
    });
  }

  private async handlePublish(interaction: ChatInputCommandInteraction): Promise<void> {
    const name = interaction.options.getString("unique_name", true);
    const mode = (interaction.options.getString("mode") ?? "auto") as PublishModePreference;
    const actor = this.actorFromInteraction(interaction);

    const result = await this.publicationManager.publishAlias(name, mode, actor);
    const item = await this.requireAlias(result.alias.name);
    await interaction.editReply({
      embeds: [this.buildPublishEmbed(item, result.record, result.alreadyPublished)]
    });
  }

  private async handleUnpublish(interaction: ChatInputCommandInteraction): Promise<void> {
    const name = interaction.options.getString("unique_name", true);
    const actor = this.actorFromInteraction(interaction);

    const result = await this.publicationManager.unpublishAlias(name, actor);
    await interaction.editReply({
      embeds: [this.buildUnpublishEmbed(result.alias.name, result.record, result.alreadyInactive)]
    });
  }

  private async requireAlias(name: string): Promise<AliasListItem> {
    const item = await this.publicationManager.getAlias(name);
    if (!item) {
      throw new Error(`Alias "${name}" could not be loaded after the operation.`);
    }

    return item;
  }

  private actorFromInteraction(interaction: ChatInputCommandInteraction) {
    return {
      discordUserId: interaction.user.id,
      discordTag: interaction.user.tag
    };
  }

  private buildListEmbed(items: AliasListItem[]): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setColor(0x4f8cff)
      .setTitle("Cloudcord Aliases")
      .setDescription(items.length === 0 ? "No aliases saved yet." : "Showing saved aliases and their current status.")
      .setTimestamp(new Date());

    if (items.length === 0) {
      return embed;
    }

    const visibleItems = items.slice(0, 15);
    for (const item of visibleItems) {
      embed.addFields({
        name: `[${item.status.toUpperCase()}] ${item.alias.name}`,
        value: [
          `**Target:** \`${item.alias.resolvedTarget}\``,
          `**Public URL:** ${item.publication ? this.formatUrl(item.publication.publicUrl) : "Not published"}`,
          `**Mode:** ${item.publication ? `\`${item.publication.mode}\`` : "Not published"}`
        ].join("\n"),
        inline: false
      });
    }

    if (items.length > visibleItems.length) {
      embed.setFooter({
        text: `${items.length - visibleItems.length} more alias(es) not shown`
      });
    }

    return embed;
  }

  private buildAliasSavedEmbed(item: AliasListItem, created: boolean): EmbedBuilder {
    return new EmbedBuilder()
      .setColor(created ? 0x22c55e : 0xf59e0b)
      .setTitle(created ? "Alias Saved" : "Alias Updated")
      .setDescription(
        created
          ? "Cloudcord saved the alias and validated the local target."
          : "Cloudcord updated the alias target and kept the saved name."
      )
      .addFields(
        {
          name: "Alias",
          value: `\`${item.alias.name}\``,
          inline: true
        },
        {
          name: "Status",
          value: item.status.toUpperCase(),
          inline: true
        },
        {
          name: "Local URL",
          value: `\`${item.alias.requestedTarget}\``,
          inline: false
        },
        {
          name: "Resolved Target",
          value: `\`${item.alias.resolvedTarget}\``,
          inline: false
        }
      )
      .setTimestamp(new Date(item.alias.updatedAt));
  }

  private buildAliasRemovedEmbed(aliasName: string, unpublishedRecord?: PublicationRecord): EmbedBuilder {
    const description = unpublishedRecord
      ? "The alias was active, so Cloudcord unpublished it before removing the saved name."
      : "The alias has been removed."

    const embed = new EmbedBuilder()
      .setColor(0xef4444)
      .setTitle("Alias Removed")
      .setDescription(description)
      .addFields({
        name: "Alias",
        value: `\`${aliasName}\``,
        inline: true
      })
      .setTimestamp(new Date());

    if (unpublishedRecord) {
      embed.addFields({
        name: "Stopped Public URL",
        value: this.formatUrl(unpublishedRecord.publicUrl),
        inline: false
      });
    }

    return embed;
  }

  private buildPublishEmbed(item: AliasListItem, record: PublicationRecord, alreadyPublished: boolean): EmbedBuilder {
    return new EmbedBuilder()
      .setColor(alreadyPublished ? 0x4f8cff : 0x22c55e)
      .setTitle(alreadyPublished ? "Alias Already Published" : "Alias Published")
      .setURL(record.publicUrl)
      .setDescription(
        alreadyPublished
          ? "Cloudcord found an existing active publication for this alias."
          : "The alias is now exposed through Cloudflare Tunnel."
      )
      .addFields(
        {
          name: "Alias",
          value: `\`${item.alias.name}\``,
          inline: true
        },
        {
          name: "Mode",
          value: `\`${record.mode}\``,
          inline: true
        },
        {
          name: "Status",
          value: item.status.toUpperCase(),
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

  private buildUnpublishEmbed(aliasName: string, record: PublicationRecord, alreadyInactive: boolean): EmbedBuilder {
    return new EmbedBuilder()
      .setColor(alreadyInactive ? 0xf59e0b : 0xef4444)
      .setTitle(alreadyInactive ? "Alias Already Inactive" : "Alias Unpublished")
      .setDescription(
        alreadyInactive
          ? "That alias was already not running, and the active link was cleared."
          : "The alias publication has been stopped."
      )
      .addFields(
        {
          name: "Alias",
          value: `\`${aliasName}\``,
          inline: true
        },
        {
          name: "Mode",
          value: `\`${record.mode}\``,
          inline: true
        },
        {
          name: "Previous Status",
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

  private formatUrl(url: string): string {
    return url;
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
