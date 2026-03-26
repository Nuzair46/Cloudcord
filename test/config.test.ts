import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config";

test("loadConfig parses a quick-tunnel-only env config", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cloudcord-config-"));

  const previousEnv = { ...process.env };
  process.env.DISCORD_BOT_TOKEN = "discord-token";
  process.env.DISCORD_GUILD_ID = "123456789012345678";
  process.env.DISCORD_ALLOWED_CHANNEL_ID = "123456789012345679";
  process.env.SQLITE_PATH = path.join(tempDir, "cloudcord.sqlite");
  process.env.ALLOW_CONTAINER_HOSTNAMES = "true";
  process.env.ALLOWED_HOSTS = "";
  process.env.ALLOWED_PORT_RANGES = "1-65535";
  process.env.LOG_LEVEL = "debug";
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_TUNNEL_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_ZONE_ID;
  delete process.env.CLOUDFLARE_TUNNEL_ID;
  delete process.env.CLOUDFLARE_BASE_DOMAIN;

  const loaded = loadConfig();

  assert.equal(loaded.app.cloudflare?.namedTunnel, undefined);
  assert.equal(loaded.app.storage.databasePath, path.join(tempDir, "cloudcord.sqlite"));
  assert.equal(loaded.app.publishPolicy.allowContainerHostnames, true);

  process.env = previousEnv;
  rmSync(tempDir, { recursive: true, force: true });
});

test("loadConfig parses named tunnel env config", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cloudcord-config-"));

  const previousEnv = { ...process.env };
  process.env.DISCORD_BOT_TOKEN = "discord-token";
  process.env.DISCORD_GUILD_ID = "123456789012345678";
  process.env.DISCORD_ALLOWED_CHANNEL_ID = "123456789012345679";
  process.env.SQLITE_PATH = path.join(tempDir, "cloudcord.sqlite");
  process.env.ALLOW_CONTAINER_HOSTNAMES = "true";
  process.env.ALLOWED_HOSTS = "host.docker.internal,internal.local";
  process.env.ALLOWED_PORT_RANGES = "1000-9000";
  process.env.CLOUDFLARE_API_TOKEN = "cloudflare-api-token";
  process.env.CLOUDFLARE_TUNNEL_TOKEN = "cloudflare-tunnel-token";
  process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
  process.env.CLOUDFLARE_ZONE_ID = "zone-id";
  process.env.CLOUDFLARE_TUNNEL_ID = "123e4567-e89b-42d3-a456-426614174000";
  process.env.CLOUDFLARE_BASE_DOMAIN = "dev.example.com";
  process.env.LOG_LEVEL = "info";

  const loaded = loadConfig();

  assert.equal(loaded.app.cloudflare?.namedTunnel?.baseDomain, "dev.example.com");
  assert.equal(loaded.env.cloudflareApiToken, "cloudflare-api-token");
  assert.equal(loaded.env.cloudflareTunnelToken, "cloudflare-tunnel-token");
  assert.deepEqual(loaded.app.publishPolicy.allowedHosts, ["host.docker.internal", "internal.local"]);
  assert.deepEqual(loaded.app.publishPolicy.allowedPortRanges, [{ start: 1000, end: 9000 }]);

  process.env = previousEnv;
  rmSync(tempDir, { recursive: true, force: true });
});
