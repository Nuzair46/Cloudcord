import { randomBytes } from "node:crypto";
import { resolveTarget } from "../domain/target-policy";
import { Logger } from "../logger";
import {
  ActorContext,
  AliasListItem,
  AliasRecord,
  LoadedConfig,
  PublicationMode,
  PublicationRecord,
  PublishModePreference
} from "../types";
import { CloudflareApiError, CloudflareClient } from "./cloudflare-client";
import { CloudflaredRuntime } from "./cloudflared-runtime";
import { PublicationRepository } from "./publication-repository";

export class PublicationManager {
  constructor(
    private readonly config: LoadedConfig,
    private readonly repository: PublicationRepository,
    private readonly cloudflare: CloudflareClient,
    private readonly runtime: CloudflaredRuntime,
    private readonly logger: Logger
  ) {}

  async bootstrap(): Promise<void> {
    this.repository.initialize();
    this.repository.markActiveQuickPublicationsStale();

    if (this.hasNamedRuntimeConfig()) {
      await this.runtime.ensureNamedConnectorStarted(this.config.env.cloudflareTunnelToken!);
    }

    await this.reconcileNamedPublications();
  }

  async addAlias(nameInput: string, requestedTarget: string, actor: ActorContext): Promise<{ alias: AliasRecord; created: boolean }> {
    const name = normalizeAliasName(nameInput);
    const target = resolveTarget(requestedTarget, this.config.app.publishPolicy);
    const existing = this.repository.getAliasByName(name);

    if (existing) {
      const activePublication = existing.currentPublicationId
        ? this.repository.getPublicationById(existing.currentPublicationId)
        : null;

      if (activePublication?.status === "active" && existing.resolvedTarget !== target.resolvedTarget) {
        throw new Error(`Alias "${name}" is currently published. Unpublish it before changing the target.`);
      }

      const alias = this.repository.updateAliasTarget(name, requestedTarget, target.resolvedTarget, actor);
      return { alias, created: false };
    }

    const alias = this.repository.createAlias({
      name,
      requestedTarget,
      resolvedTarget: target.resolvedTarget,
      actor
    });

    return { alias, created: true };
  }

  async removeAlias(nameInput: string, actor: ActorContext): Promise<{ alias: AliasRecord; removed: boolean; unpublishedRecord?: PublicationRecord }> {
    const name = normalizeAliasName(nameInput);
    const alias = this.repository.getAliasByName(name);
    if (!alias) {
      throw new Error(`Unknown alias "${name}".`);
    }

    const publication = alias.currentPublicationId ? this.repository.getPublicationById(alias.currentPublicationId) : null;
    let unpublishedRecord: PublicationRecord | undefined;

    if (publication?.status === "active") {
      unpublishedRecord = (await this.unpublishAlias(name, actor)).record;
    }

    this.repository.deleteAlias(name);
    return {
      alias,
      removed: true,
      unpublishedRecord
    };
  }

  async listAliases(): Promise<AliasListItem[]> {
    await this.reconcileNamedPublications();
    return this.repository.listAliases().map((alias) => this.mapAliasListItem(alias));
  }

  async getAlias(nameInput: string): Promise<AliasListItem | null> {
    await this.reconcileNamedPublications();
    const name = normalizeAliasName(nameInput);
    const alias = this.repository.getAliasByName(name);
    return alias ? this.mapAliasListItem(alias) : null;
  }

  async publishAlias(
    nameInput: string,
    requestedMode: PublishModePreference,
    actor: ActorContext
  ): Promise<{ alias: AliasRecord; record: PublicationRecord; alreadyPublished: boolean }> {
    const name = normalizeAliasName(nameInput);
    const alias = this.repository.getAliasByName(name);
    if (!alias) {
      throw new Error(`Unknown alias "${name}".`);
    }

    const existing = alias.currentPublicationId ? this.repository.getPublicationById(alias.currentPublicationId) : null;
    if (existing?.status === "active") {
      return {
        alias,
        record: existing,
        alreadyPublished: true
      };
    }

    const mode = await this.resolvePublishMode(requestedMode);
    const record = mode === "named"
      ? await this.publishNamedTarget(alias.name, alias.resolvedTarget, alias.requestedTarget, actor)
      : await this.publishQuickTarget(alias.name, alias.resolvedTarget, alias.requestedTarget, actor);

    const nextAlias = this.repository.linkAliasToPublication(alias.name, record.record.id, actor);
    return {
      alias: nextAlias,
      record: record.record,
      alreadyPublished: record.alreadyPublished
    };
  }

  async unpublishAlias(
    nameInput: string,
    actor: ActorContext
  ): Promise<{ alias: AliasRecord; record: PublicationRecord; alreadyInactive: boolean }> {
    const name = normalizeAliasName(nameInput);
    const alias = this.repository.getAliasByName(name);
    if (!alias) {
      throw new Error(`Unknown alias "${name}".`);
    }

    if (!alias.currentPublicationId) {
      throw new Error(`Alias "${name}" is not currently published.`);
    }

    const record = this.repository.getPublicationById(alias.currentPublicationId);
    if (!record) {
      this.repository.clearAliasPublication(name, actor);
      throw new Error(`Alias "${name}" references a missing publication.`);
    }

    if (record.status !== "active") {
      const nextAlias = this.repository.clearAliasPublication(name, actor);
      return {
        alias: nextAlias,
        record,
        alreadyInactive: true
      };
    }

    if (record.mode === "named") {
      if (!record.hostname) {
        throw new CloudflareApiError(`Named publication "${record.id}" is missing its hostname.`);
      }

      await this.cloudflare.removeNamedPublication(record.hostname);
    } else {
      this.runtime.stopQuickTunnel(record.id);
    }

    const nextRecord = this.repository.markPublicationInactive(record.id, actor, "user_unpublish");
    const nextAlias = this.repository.clearAliasPublication(name, actor);
    return {
      alias: nextAlias,
      record: nextRecord,
      alreadyInactive: false
    };
  }

  close(): void {
    this.repository.close();
  }

  private async publishNamedTarget(
    aliasName: string,
    resolvedTarget: string,
    requestedTarget: string,
    actor: ActorContext
  ): Promise<{ record: PublicationRecord; alreadyPublished: boolean }> {
    await this.ensureNamedModeReady();

    const id = this.createPublicationId();
    const hostname = this.generateHostname(aliasName);
    const publicUrl = `https://${hostname}`;

    try {
      await this.cloudflare.ensureNamedPublication(hostname, resolvedTarget);

      const record = this.repository.createPublication({
        id,
        mode: "named",
        aliasName,
        requestedTarget,
        resolvedTarget,
        publicUrl,
        hostname,
        actor
      });

      return {
        record,
        alreadyPublished: false
      };
    } catch (error) {
      try {
        await this.cloudflare.removeNamedPublication(hostname);
      } catch (cleanupError) {
        this.logger.warn("Failed to roll back named publication after an error.", {
          hostname,
          error: (cleanupError as Error).message
        });
      }

      throw error;
    }
  }

  private async publishQuickTarget(
    aliasName: string,
    resolvedTarget: string,
    requestedTarget: string,
    actor: ActorContext
  ): Promise<{ record: PublicationRecord; alreadyPublished: boolean }> {
    const id = this.createPublicationId();
    const publicUrl = await this.runtime.startQuickTunnel(id, resolvedTarget);

    try {
      const record = this.repository.createPublication({
        id,
        mode: "quick",
        aliasName,
        requestedTarget,
        resolvedTarget,
        publicUrl,
        actor
      });

      if (!this.runtime.isQuickTunnelRunning(id)) {
        return {
          record: this.repository.markPublicationStale(id, "quick_tunnel_exited_during_publish") ?? record,
          alreadyPublished: false
        };
      }

      return {
        record,
        alreadyPublished: false
      };
    } catch (error) {
      this.runtime.stopQuickTunnel(id);
      throw error;
    }
  }

  private async resolvePublishMode(requestedMode: PublishModePreference): Promise<PublicationMode> {
    if (requestedMode === "quick") {
      return "quick";
    }

    if (requestedMode === "named") {
      await this.ensureNamedModeReady();
      return "named";
    }

    if (this.hasNamedRuntimeConfig() && this.cloudflare.isNamedApiConfigured()) {
      await this.runtime.ensureNamedConnectorStarted(this.config.env.cloudflareTunnelToken!);
      return "named";
    }

    return "quick";
  }

  private async ensureNamedModeReady(): Promise<void> {
    if (!this.cloudflare.isNamedApiConfigured()) {
      throw new CloudflareApiError("Named mode requires Cloudflare named-tunnel config and CLOUDFLARE_API_TOKEN.");
    }

    if (!this.hasNamedRuntimeConfig()) {
      throw new CloudflareApiError("Named mode requires CLOUDFLARE_TUNNEL_TOKEN so the local connector can run.");
    }

    await this.runtime.ensureNamedConnectorStarted(this.config.env.cloudflareTunnelToken!);
  }

  private hasNamedRuntimeConfig(): boolean {
    return Boolean(this.config.app.cloudflare?.namedTunnel && this.config.env.cloudflareTunnelToken);
  }

  private async reconcileNamedPublications(): Promise<void> {
    if (!this.cloudflare.isNamedApiConfigured()) {
      return;
    }

    try {
      const activeHostnames = await this.cloudflare.listPublishedHostnames();
      const activeRecords = this.repository.listActiveNamedPublications();

      for (const record of activeRecords) {
        if (record.hostname && !activeHostnames.has(record.hostname.toLowerCase())) {
          this.repository.markPublicationStale(record.id, "named_route_missing");
        }
      }
    } catch (error) {
      this.logger.warn("Failed to reconcile named publications against Cloudflare.", {
        error: (error as Error).message
      });
    }
  }

  private mapAliasListItem(alias: AliasRecord): AliasListItem {
    const publication = alias.currentPublicationId
      ? this.repository.getPublicationById(alias.currentPublicationId) ?? undefined
      : undefined;

    if (!publication || publication.status === "inactive") {
      return {
        alias,
        status: "unpublished"
      };
    }

    if (publication.status === "stale") {
      return {
        alias,
        publication,
        status: "stale"
      };
    }

    return {
      alias,
      publication,
      status: "active"
    };
  }

  private generateHostname(aliasName: string): string {
    const baseDomain = this.cloudflare.getBaseDomain();
    return `${aliasName}.${baseDomain}`;
  }

  private createPublicationId(): string {
    return randomBytes(6).toString("hex");
  }
}

export function normalizeAliasName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new Error("Alias names must use lowercase letters, numbers, and hyphens only.");
  }

  return normalized;
}
