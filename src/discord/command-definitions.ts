import { RESTPostAPIChatInputApplicationCommandsJSONBody, SlashCommandBuilder } from "discord.js";

export function buildCommandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const publishCommand = new SlashCommandBuilder()
    .setName("publish")
    .setDescription("Publish a local target through Cloudflare Tunnel.")
    .addStringOption((option) =>
      option
        .setName("target")
        .setDescription("Full local target URL, for example http://localhost:3000")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Tunnel mode")
        .setRequired(false)
        .addChoices(
          { name: "auto", value: "auto" },
          { name: "quick", value: "quick" },
          { name: "named", value: "named" }
        )
    );

  const unpublishCommand = new SlashCommandBuilder()
    .setName("unpublish")
    .setDescription("Stop a published tunnel by publication ID.")
    .addStringOption((option) =>
      option
        .setName("id")
        .setDescription("Publication ID returned by /publish")
        .setRequired(true)
    );

  const statusCommand = new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show status for one publication or all publications.")
    .addStringOption((option) =>
      option
        .setName("id")
        .setDescription("Publication ID")
        .setRequired(false)
    );

  const listCommand = new SlashCommandBuilder()
    .setName("list")
    .setDescription("List publications known to the bot.");

  return [
    listCommand.toJSON(),
    statusCommand.toJSON(),
    publishCommand.toJSON(),
    unpublishCommand.toJSON()
  ];
}
