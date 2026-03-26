import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActorContext, PublicationMode, PublicationRecord } from "../types";

interface CreatePublicationInput {
  id: string;
  mode: PublicationMode;
  requestedTarget: string;
  resolvedTarget: string;
  publicUrl: string;
  hostname?: string;
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
    `);
  }

  createPublication(input: CreatePublicationInput): PublicationRecord {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO publications (
        id,
        mode,
        requested_target,
        resolved_target,
        public_url,
        hostname,
        status,
        actor_id,
        actor_tag,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(
      input.id,
      input.mode,
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
}

function mapPublicationRow(row: Record<string, unknown>): PublicationRecord {
  return {
    id: String(row.id),
    mode: row.mode as PublicationMode,
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
