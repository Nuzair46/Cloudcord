import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Logger } from "../src/logger";
import { PublicationManager, normalizeAliasName } from "../src/services/publication-manager";
import { PublicationRepository } from "../src/services/publication-repository";
import { LoadedConfig } from "../src/types";

const actor = {
  discordUserId: "1",
  discordTag: "tester#0001"
};

function createConfig(): LoadedConfig {
  return {
    app: {
      discord: {
        guildId: "123456789012345678",
        allowedChannelId: "123456789012345679"
      },
      storage: {
        databasePath: "/tmp/cloudcord-test.sqlite"
      },
      publishPolicy: {
        allowContainerHostnames: true,
        allowedHosts: [],
        allowedPortRanges: [{ start: 1, end: 65535 }]
      },
      cloudflare: {
        namedTunnel: {
          accountId: "account-id",
          zoneId: "zone-id",
          tunnelId: "123e4567-e89b-42d3-a456-426614174000",
          baseDomain: "dev.example.com"
        }
      }
    },
    env: {
      discordBotToken: "discord-token",
      cloudflareApiToken: "api-token",
      cloudflareTunnelToken: "tunnel-token",
      logLevel: "error"
    }
  };
}

function createManager() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cloudcord-manager-"));
  const repository = new PublicationRepository(path.join(tempDir, "cloudcord.sqlite"));
  const logger = new Logger("error");
  const cloudflareCalls = {
    ensured: [] as Array<{ hostname: string; targetUrl: string }>,
    removed: [] as string[]
  };
  const runtimeCalls = {
    started: [] as Array<{ publicationId: string; targetUrl: string }>,
    stopped: [] as string[],
    ensureNamedConnectorStarted: 0
  };
  const runningQuickTunnels = new Set<string>();

  const cloudflare = {
    isNamedApiConfigured: () => true,
    getBaseDomain: () => "dev.example.com",
    listPublishedHostnames: async () => new Set(cloudflareCalls.ensured.map((entry) => entry.hostname)),
    ensureNamedPublication: async (hostname: string, targetUrl: string) => {
      cloudflareCalls.ensured.push({ hostname, targetUrl });
    },
    removeNamedPublication: async (hostname: string) => {
      cloudflareCalls.removed.push(hostname);
    }
  };

  const runtime = {
    ensureNamedConnectorStarted: async () => {
      runtimeCalls.ensureNamedConnectorStarted += 1;
    },
    startQuickTunnel: async (publicationId: string, targetUrl: string) => {
      runtimeCalls.started.push({ publicationId, targetUrl });
      runningQuickTunnels.add(publicationId);
      return `https://${publicationId}.trycloudflare.com`;
    },
    isQuickTunnelRunning: (publicationId: string) => runningQuickTunnels.has(publicationId),
    stopQuickTunnel: (publicationId: string) => {
      runtimeCalls.stopped.push(publicationId);
      runningQuickTunnels.delete(publicationId);
      return true;
    }
  };

  const manager = new PublicationManager(
    createConfig(),
    repository,
    cloudflare as never,
    runtime as never,
    logger
  );

  return { manager, repository, tempDir, cloudflareCalls, runtimeCalls };
}

test("normalizeAliasName lowercases valid aliases", () => {
  assert.equal(normalizeAliasName("My-App-01"), "my-app-01");
  assert.throws(() => normalizeAliasName("bad name"), /letters, numbers, and hyphens/);
});

test("PublicationManager adds, publishes, lists, unpublishes, and removes aliases", async () => {
  const { manager, repository, tempDir, runtimeCalls } = createManager();
  await manager.bootstrap();

  const added = await manager.addAlias("My-App", "http://localhost:3000", actor);
  assert.equal(added.created, true);
  assert.equal(added.alias.name, "my-app");

  const published = await manager.publishAlias("my-app", "quick", actor);
  assert.equal(published.alreadyPublished, false);
  assert.equal(published.record.mode, "quick");
  assert.equal(published.record.aliasName, "my-app");
  assert.equal(runtimeCalls.started.length, 1);

  const listAfterPublish = await manager.listAliases();
  assert.equal(listAfterPublish.length, 1);
  assert.equal(listAfterPublish[0]?.status, "active");
  assert.equal(listAfterPublish[0]?.publication?.aliasName, "my-app");

  await assert.rejects(
    () => manager.addAlias("my-app", "http://localhost:4000", actor),
    /currently published/
  );

  const unpublished = await manager.unpublishAlias("my-app", actor);
  assert.equal(unpublished.alreadyInactive, false);
  assert.equal(unpublished.record.status, "inactive");

  const listAfterUnpublish = await manager.listAliases();
  assert.equal(listAfterUnpublish[0]?.status, "unpublished");

  const removed = await manager.removeAlias("my-app", actor);
  assert.equal(removed.removed, true);
  assert.equal(repository.getAliasByName("my-app"), null);

  manager.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test("PublicationManager uses alias name as the named tunnel hostname", async () => {
  const { manager, tempDir, cloudflareCalls } = createManager();
  await manager.bootstrap();

  await manager.addAlias("docs-api", "http://localhost:8080", actor);
  const published = await manager.publishAlias("docs-api", "named", actor);

  assert.equal(published.record.hostname, "docs-api.dev.example.com");
  assert.equal(published.record.publicUrl, "https://docs-api.dev.example.com");
  assert.deepEqual(cloudflareCalls.ensured, [
    {
      hostname: "docs-api.dev.example.com",
      targetUrl: "http://host.docker.internal:8080"
    }
  ]);

  manager.close();
  rmSync(tempDir, { recursive: true, force: true });
});
