import { randomBytes } from "node:crypto";
import { resolveTarget } from "../domain/target-policy";
import { Logger } from "../logger";
import {
  ActorContext,
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

  async listPublications(): Promise<PublicationRecord[]> {
    await this.reconcileNamedPublications();
    return this.repository.listPublications();
  }

  async getPublication(id: string): Promise<PublicationRecord | null> {
    await this.reconcileNamedPublications();
    return this.repository.getPublicationById(id);
  }

  async publishTarget(
    requestedTarget: string,
    requestedMode: PublishModePreference,
    actor: ActorContext
  ): Promise<{ record: PublicationRecord; alreadyPublished: boolean }> {
    const target = resolveTarget(requestedTarget, this.config.app.publishPolicy);
    const mode = await this.resolvePublishMode(requestedMode);
    const existing = this.repository.findActiveByModeAndTarget(mode, target.resolvedTarget);

    if (existing) {
      return {
        record: existing,
        alreadyPublished: true
      };
    }

    if (mode === "named") {
      return this.publishNamedTarget(target.resolvedTarget, requestedTarget, actor);
    }

    return this.publishQuickTarget(target.resolvedTarget, requestedTarget, actor);
  }

  async unpublish(id: string, actor: ActorContext): Promise<{ record: PublicationRecord; alreadyInactive: boolean }> {
    const record = this.repository.getPublicationById(id);
    if (!record) {
      throw new Error(`Unknown publication "${id}".`);
    }

    if (record.status !== "active") {
      return {
        record,
        alreadyInactive: true
      };
    }

    if (record.mode === "named") {
      if (!record.hostname) {
        throw new CloudflareApiError(`Named publication "${id}" is missing its hostname.`);
      }

      await this.cloudflare.removeNamedPublication(record.hostname);
    } else {
      this.runtime.stopQuickTunnel(record.id);
    }

    const nextRecord = this.repository.markPublicationInactive(record.id, actor, "user_unpublish");
    return {
      record: nextRecord,
      alreadyInactive: false
    };
  }

  close(): void {
    this.repository.close();
  }

  private async publishNamedTarget(
    resolvedTarget: string,
    requestedTarget: string,
    actor: ActorContext
  ): Promise<{ record: PublicationRecord; alreadyPublished: boolean }> {
    await this.ensureNamedModeReady();

    const id = this.createPublicationId();
    const hostname = this.generateHostname(resolvedTarget, id);
    const publicUrl = `https://${hostname}`;

    try {
      await this.cloudflare.ensureNamedPublication(hostname, resolvedTarget);

      const record = this.repository.createPublication({
        id,
        mode: "named",
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

  private generateHostname(resolvedTarget: string, id: string): string {
    const baseDomain = this.cloudflare.getBaseDomain();
    const url = new URL(resolvedTarget);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const suffix = id.slice(-6).toLowerCase();
    return `p${port}-${suffix}.${baseDomain}`;
  }

  private createPublicationId(): string {
    return randomBytes(6).toString("hex");
  }
}
