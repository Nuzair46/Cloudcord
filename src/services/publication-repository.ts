import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActorContext, AliasRecord, PublicationMode, PublicationRecord } from "../types";

interface CreatePublicationInput {
  id: string;
  mode: PublicationMode;
  requestedTarget: string;
  resolvedTarget: string;
  publicUrl: string;
  hostname?: string;
  aliasName?: string;
  actor: ActorContext;
}

interface CreateAliasInput {
  name: string;
  requestedTarget: string;
  resolvedTarget: string;
  actor: ActorContext;
}

export class PublicationRepository {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS publications (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        alias_name TEXT,
        requested_target TEXT NOT NULL,
        resolved_target TEXT NOT NULL,
        public_url TEXT NOT NULL,
        hostname TEXT,
        status TEXT NOT NULL,
        actor_id TEXT,
        actor_tag TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        stopped_at TEXT,
        exit_reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_publications_status
        ON publications (status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_publications_mode_target_status
        ON publications (mode, resolved_target, status);

      CREATE INDEX IF NOT EXISTS idx_publications_alias_name
        ON publications (alias_name, updated_at DESC);

      CREATE TABLE IF NOT EXISTS aliases (
        name TEXT PRIMARY KEY,
        requested_target TEXT NOT NULL,
        resolved_target TEXT NOT NULL,
        current_publication_id TEXT,
        actor_id TEXT,
        actor_tag TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (current_publication_id) REFERENCES publications (id)
      );

      CREATE INDEX IF NOT EXISTS idx_aliases_current_publication
        ON aliases (current_publication_id);
    `);

    this.ensureColumn("publications", "alias_name", "TEXT");
    this.ensureColumn("aliases", "current_publication_id", "TEXT");
  }

  createAlias(input: CreateAliasInput): AliasRecord {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO aliases (
        name,
        requested_target,
        resolved_target,
        current_publication_id,
        actor_id,
        actor_tag,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      input.name,
      input.requestedTarget,
      input.resolvedTarget,
      input.actor.discordUserId,
      input.actor.discordTag,
      now,
      now
    );

    return this.getAliasByName(input.name)!;
  }

  updateAliasTarget(name: string, requestedTarget: string, resolvedTarget: string, actor: ActorContext): AliasRecord {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE aliases
      SET requested_target = ?,
          resolved_target = ?,
          actor_id = ?,
          actor_tag = ?,
          updated_at = ?
      WHERE name = ?
    `).run(requestedTarget, resolvedTarget, actor.discordUserId, actor.discordTag, now, name);

    return this.getAliasByName(name)!;
  }

  deleteAlias(name: string): boolean {
    const result = this.db.prepare(`
      DELETE FROM aliases
      WHERE name = ?
    `).run(name);

    return result.changes > 0;
  }

  getAliasByName(name: string): AliasRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM aliases
      WHERE name = ?
      LIMIT 1
    `).get(name) as Record<string, unknown> | undefined;

    return row ? mapAliasRow(row) : null;
  }

  listAliases(): AliasRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM aliases
      ORDER BY name ASC
    `).all() as Array<Record<string, unknown>>;

    return rows.map(mapAliasRow);
  }

  linkAliasToPublication(name: string, publicationId: string, actor: ActorContext): AliasRecord {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE aliases
      SET current_publication_id = ?,
          actor_id = ?,
          actor_tag = ?,
          updated_at = ?
      WHERE name = ?
    `).run(publicationId, actor.discordUserId, actor.discordTag, now, name);

    return this.getAliasByName(name)!;
  }

  clearAliasPublication(name: string, actor: ActorContext): AliasRecord {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE aliases
      SET current_publication_id = NULL,
          actor_id = ?,
          actor_tag = ?,
          updated_at = ?
      WHERE name = ?
    `).run(actor.discordUserId, actor.discordTag, now, name);

    return this.getAliasByName(name)!;
  }

  createPublication(input: CreatePublicationInput): PublicationRecord {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO publications (
        id,
        mode,
        alias_name,
        requested_target,
        resolved_target,
        public_url,
        hostname,
        status,
        actor_id,
        actor_tag,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(
      input.id,
      input.mode,
      input.aliasName ?? null,
      input.requestedTarget,
      input.resolvedTarget,
      input.publicUrl,
      input.hostname ?? null,
      input.actor.discordUserId,
      input.actor.discordTag,
      now,
      now
    );

    return this.getPublicationById(input.id)!;
  }

  findActiveByAliasName(name: string): PublicationRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM publications
      WHERE alias_name = ? AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(name) as Record<string, unknown> | undefined;

    return row ? mapPublicationRow(row) : null;
  }

  findActiveByModeAndTarget(mode: PublicationMode, resolvedTarget: string): PublicationRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM publications
      WHERE mode = ? AND resolved_target = ? AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(mode, resolvedTarget) as Record<string, unknown> | undefined;

    return row ? mapPublicationRow(row) : null;
  }

  getPublicationById(id: string): PublicationRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM publications
      WHERE id = ?
      LIMIT 1
    `).get(id) as Record<string, unknown> | undefined;

    return row ? mapPublicationRow(row) : null;
  }

  listPublications(): PublicationRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM publications
      WHERE status != 'inactive'
      ORDER BY
        CASE status
          WHEN 'active' THEN 0
          WHEN 'stale' THEN 1
          ELSE 2
        END,
        updated_at DESC
    `).all() as Array<Record<string, unknown>>;

    return rows.map(mapPublicationRow);
  }

  listActiveNamedPublications(): PublicationRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM publications
      WHERE mode = 'named' AND status = 'active'
      ORDER BY created_at DESC
    `).all() as Array<Record<string, unknown>>;

    return rows.map(mapPublicationRow);
  }

  markActiveQuickPublicationsStale(): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE publications
      SET status = 'stale',
          updated_at = ?,
          stopped_at = COALESCE(stopped_at, ?),
          exit_reason = 'bot_restart'
      WHERE mode = 'quick' AND status = 'active'
    `).run(now, now);
  }

  markPublicationInactive(id: string, actor: ActorContext, reason: string): PublicationRecord {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE publications
      SET status = 'inactive',
          actor_id = ?,
          actor_tag = ?,
          updated_at = ?,
          stopped_at = ?,
          exit_reason = ?
      WHERE id = ?
    `).run(actor.discordUserId, actor.discordTag, now, now, reason, id);

    return this.getPublicationById(id)!;
  }

  markPublicationStale(id: string, reason: string): PublicationRecord | null {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE publications
      SET status = 'stale',
          updated_at = ?,
          stopped_at = COALESCE(stopped_at, ?),
          exit_reason = ?
      WHERE id = ? AND status = 'active'
    `).run(now, now, reason, id);

    if (result.changes === 0) {
      return this.getPublicationById(id);
    }

    return this.getPublicationById(id);
  }

  close(): void {
    this.db.close();
  }

  private ensureColumn(tableName: string, columnName: string, columnDefinition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<Record<string, unknown>>;
    const hasColumn = rows.some((row) => String(row.name) === columnName);

    if (!hasColumn) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`);
    }
  }
}

function mapPublicationRow(row: Record<string, unknown>): PublicationRecord {
  return {
    id: String(row.id),
    mode: row.mode as PublicationMode,
    aliasName: row.alias_name ? String(row.alias_name) : undefined,
    requestedTarget: String(row.requested_target),
    resolvedTarget: String(row.resolved_target),
    publicUrl: String(row.public_url),
    hostname: row.hostname ? String(row.hostname) : undefined,
    status: row.status as PublicationRecord["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    stoppedAt: row.stopped_at ? String(row.stopped_at) : undefined,
    actorId: row.actor_id ? String(row.actor_id) : undefined,
    actorTag: row.actor_tag ? String(row.actor_tag) : undefined,
    exitReason: row.exit_reason ? String(row.exit_reason) : undefined
  };
}

function mapAliasRow(row: Record<string, unknown>): AliasRecord {
  return {
    name: String(row.name),
    requestedTarget: String(row.requested_target),
    resolvedTarget: String(row.resolved_target),
    currentPublicationId: row.current_publication_id ? String(row.current_publication_id) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    actorId: row.actor_id ? String(row.actor_id) : undefined,
    actorTag: row.actor_tag ? String(row.actor_tag) : undefined
  };
}
