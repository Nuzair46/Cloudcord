import { RESTPostAPIChatInputApplicationCommandsJSONBody, SlashCommandBuilder } from "discord.js";

export function buildCommandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const addCommand = new SlashCommandBuilder()
    .setName("add")
    .setDescription("Save a local target URL under a reusable alias.")
    .addStringOption((option) =>
      option
        .setName("unique_name")
        .setDescription("Alias name, for example my-app")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("local_url")
        .setDescription("Full local target URL, for example http://localhost:3000")
        .setRequired(true)
    );

  const removeCommand = new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Delete a saved alias and stop it first if it is active.")
    .addStringOption((option) =>
      option
        .setName("unique_name")
        .setDescription("Alias name")
        .setRequired(true)
    );

  const publishCommand = new SlashCommandBuilder()
    .setName("publish")
    .setDescription("Publish a saved alias through Cloudflare Tunnel.")
    .addStringOption((option) =>
      option
        .setName("unique_name")
        .setDescription("Alias name")
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
    .setDescription("Stop a published alias.")
    .addStringOption((option) =>
      option
        .setName("unique_name")
        .setDescription("Alias name")
        .setRequired(true)
    );

  const listCommand = new SlashCommandBuilder()
    .setName("list")
    .setDescription("List saved aliases and their current status.");

  return [
    addCommand.toJSON(),
    removeCommand.toJSON(),
    listCommand.toJSON(),
    publishCommand.toJSON(),
    unpublishCommand.toJSON()
  ];
}
