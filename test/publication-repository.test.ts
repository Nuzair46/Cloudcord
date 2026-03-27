import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PublicationRepository } from "../src/services/publication-repository";

function createRepository() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cloudcord-db-"));
  const databasePath = path.join(tempDir, "cloudcord.sqlite");
  const repository = new PublicationRepository(databasePath);
  repository.initialize();
  return { repository, tempDir };
}

test("PublicationRepository creates and queries publications", () => {
  const { repository, tempDir } = createRepository();

  repository.createPublication({
    id: "abc123",
    mode: "quick",
    aliasName: "demo-app",
    requestedTarget: "http://localhost:3000",
    resolvedTarget: "http://host.docker.internal:3000",
    publicUrl: "https://example.trycloudflare.com",
    actor: {
      discordUserId: "1",
      discordTag: "user#0001"
    }
  });

  const record = repository.getPublicationById("abc123");

  assert.ok(record);
  assert.equal(record?.mode, "quick");
  assert.equal(record?.aliasName, "demo-app");
  assert.equal(record?.status, "active");

  repository.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test("PublicationRepository stores aliases and their active publication", () => {
  const { repository, tempDir } = createRepository();

  repository.createAlias({
    name: "demo-app",
    requestedTarget: "http://localhost:3000",
    resolvedTarget: "http://host.docker.internal:3000",
    actor: {
      discordUserId: "1",
      discordTag: "user#0001"
    }
  });

  repository.createPublication({
    id: "pub123",
    mode: "named",
    aliasName: "demo-app",
    requestedTarget: "http://localhost:3000",
    resolvedTarget: "http://host.docker.internal:3000",
    publicUrl: "https://demo-app.dev.example.com",
    hostname: "demo-app.dev.example.com",
    actor: {
      discordUserId: "1",
      discordTag: "user#0001"
    }
  });

  repository.linkAliasToPublication("demo-app", "pub123", {
    discordUserId: "2",
    discordTag: "user#0002"
  });

  const alias = repository.getAliasByName("demo-app");
  assert.ok(alias);
  assert.equal(alias?.currentPublicationId, "pub123");

  repository.clearAliasPublication("demo-app", {
    discordUserId: "3",
    discordTag: "user#0003"
  });

  const clearedAlias = repository.getAliasByName("demo-app");
  assert.ok(clearedAlias);
  assert.equal(clearedAlias?.currentPublicationId, undefined);

  repository.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test("PublicationRepository marks active quick tunnels stale on startup", () => {
  const { repository, tempDir } = createRepository();

  repository.createPublication({
    id: "def456",
    mode: "quick",
    aliasName: "another-app",
    requestedTarget: "http://localhost:8080",
    resolvedTarget: "http://host.docker.internal:8080",
    publicUrl: "https://another.trycloudflare.com",
    actor: {
      discordUserId: "2",
      discordTag: "user#0002"
    }
  });

  repository.markActiveQuickPublicationsStale();
  const record = repository.getPublicationById("def456");

  assert.ok(record);
  assert.equal(record?.status, "stale");
  assert.equal(record?.exitReason, "bot_restart");

  repository.close();
  rmSync(tempDir, { recursive: true, force: true });
});
