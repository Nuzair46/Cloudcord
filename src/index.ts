import { loadConfig } from "./config";
import { BotApp } from "./discord/bot-app";
import { Logger, normalizeLogLevel } from "./logger";
import { CloudflareClient } from "./services/cloudflare-client";
import { CloudflaredRuntime } from "./services/cloudflared-runtime";
import { PublicationManager } from "./services/publication-manager";
import { PublicationRepository } from "./services/publication-repository";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(normalizeLogLevel(config.env.logLevel));
  const repository = new PublicationRepository(config.app.storage.databasePath);
  const cloudflare = new CloudflareClient(config, logger);
  const runtime = new CloudflaredRuntime(repository, logger);
  const publicationManager = new PublicationManager(config, repository, cloudflare, runtime, logger);
  const bot = new BotApp(
    config.app.discord.guildId,
    config.app.discord.allowedChannelId,
    config.env.discordBotToken,
    publicationManager,
    logger
  );

  installShutdownHandlers(runtime, publicationManager, logger);

  await publicationManager.bootstrap();
  await bot.start();
}

function installShutdownHandlers(
  runtime: CloudflaredRuntime,
  publicationManager: PublicationManager,
  logger: Logger
): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logger.info("Shutting down Cloudcord.", { signal });

    try {
      await runtime.shutdown();
    } finally {
      publicationManager.close();
      process.exit(0);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
