import path from "node:path";
import { z } from "zod";
import { AppConfig, EnvironmentConfig, LoadedConfig } from "./types";

const hostnamePattern = /^(?=.{1,253}$)(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const portRangeSchema = z.object({
  start: z.number().int().min(1).max(65535),
  end: z.number().int().min(1).max(65535)
}).refine((value) => value.start <= value.end, "allowed port range start must be <= end");

const namedTunnelSchema = z.object({
  accountId: z.string().min(1, "cloudflare.namedTunnel.accountId is required"),
  zoneId: z.string().min(1, "cloudflare.namedTunnel.zoneId is required"),
  tunnelId: z.string().uuid("cloudflare.namedTunnel.tunnelId must be a UUID"),
  baseDomain: z.string().transform((value) => value.toLowerCase()).refine((value) => hostnamePattern.test(value), "cloudflare.namedTunnel.baseDomain must be a valid hostname")
}).strict();

const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
  DISCORD_GUILD_ID: z.string().regex(/^\d{17,20}$/, "DISCORD_GUILD_ID must be a Discord snowflake"),
  DISCORD_ALLOWED_CHANNEL_ID: z.string().regex(/^\d{17,20}$/, "DISCORD_ALLOWED_CHANNEL_ID must be a Discord snowflake"),
  SQLITE_PATH: z.string().default("/app/data/cloudcord.sqlite"),
  ALLOW_CONTAINER_HOSTNAMES: z.string().default("true"),
  ALLOWED_HOSTS: z.string().default(""),
  ALLOWED_PORT_RANGES: z.string().default("1-65535"),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  CLOUDFLARE_TUNNEL_TOKEN: z.string().optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_ZONE_ID: z.string().optional(),
  CLOUDFLARE_TUNNEL_ID: z.string().optional(),
  CLOUDFLARE_BASE_DOMAIN: z.string().optional(),
  LOG_LEVEL: z.string().default("info")
});

export function loadConfig(): LoadedConfig {
  const parsed = envSchema.parse(process.env);
  const env = loadEnvironment(parsed);
  const app = loadAppConfig(parsed);

  return {
    app,
    env
  };
}

function loadEnvironment(parsed: z.infer<typeof envSchema>): EnvironmentConfig {
  return {
    discordBotToken: parsed.DISCORD_BOT_TOKEN,
    cloudflareApiToken: parsed.CLOUDFLARE_API_TOKEN,
    cloudflareTunnelToken: parsed.CLOUDFLARE_TUNNEL_TOKEN,
    logLevel: parsed.LOG_LEVEL
  };
}

function loadAppConfig(parsed: z.infer<typeof envSchema>): AppConfig {
  const namedTunnel = parseNamedTunnel(parsed);
  const allowedHosts = parseAllowedHosts(parsed.ALLOWED_HOSTS);
  const allowedPortRanges = parseAllowedPortRanges(parsed.ALLOWED_PORT_RANGES);

  return {
    discord: {
      guildId: parsed.DISCORD_GUILD_ID,
      allowedChannelId: parsed.DISCORD_ALLOWED_CHANNEL_ID
    },
    storage: {
      databasePath: path.resolve(parsed.SQLITE_PATH)
    },
    publishPolicy: {
      allowContainerHostnames: parseBoolean(parsed.ALLOW_CONTAINER_HOSTNAMES, "ALLOW_CONTAINER_HOSTNAMES"),
      allowedHosts,
      allowedPortRanges
    },
    ...(namedTunnel ? { cloudflare: { namedTunnel } } : {})
  };
}

function parseNamedTunnel(parsed: z.infer<typeof envSchema>) {
  const values = [
    parsed.CLOUDFLARE_ACCOUNT_ID,
    parsed.CLOUDFLARE_ZONE_ID,
    parsed.CLOUDFLARE_TUNNEL_ID,
    parsed.CLOUDFLARE_BASE_DOMAIN
  ];

  if (values.every((value) => !value)) {
    return undefined;
  }

  if (values.some((value) => !value)) {
    return undefined;
  }

  return namedTunnelSchema.parse({
    accountId: parsed.CLOUDFLARE_ACCOUNT_ID,
    zoneId: parsed.CLOUDFLARE_ZONE_ID,
    tunnelId: parsed.CLOUDFLARE_TUNNEL_ID,
    baseDomain: parsed.CLOUDFLARE_BASE_DOMAIN
  });
}

function parseAllowedHosts(raw: string): string[] {
  if (!raw.trim()) {
    return [];
  }

  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function parseAllowedPortRanges(raw: string) {
  return raw
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const match = segment.match(/^(\d+)(?:-(\d+))?$/);
      if (!match) {
        throw new Error(`Invalid ALLOWED_PORT_RANGES segment "${segment}". Use values like 3000-3999 or 8080.`);
      }

      const start = Number(match[1]);
      const end = Number(match[2] ?? match[1]);
      return portRangeSchema.parse({ start, end });
    });
}

function parseBoolean(raw: string, envName: string): boolean {
  if (raw === "true") {
    return true;
  }

  if (raw === "false") {
    return false;
  }

  throw new Error(`${envName} must be "true" or "false".`);
}
