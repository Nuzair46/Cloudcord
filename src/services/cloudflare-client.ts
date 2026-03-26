import {
  extractPublishedHostnames,
  findIngressRuleByHostname,
  removeIngressRule,
  upsertIngressRule
} from "../domain/tunnel-config";
import { Logger } from "../logger";
import {
  CloudflareEnvelope,
  DnsRecord,
  LoadedConfig,
  TunnelConfigPayload,
  TunnelConfigurationResult,
  TunnelConnection
} from "../types";

export class CloudflareApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export class CloudflareClient {
  private readonly apiBaseUrl = "https://api.cloudflare.com/client/v4";

  constructor(
    private readonly config: LoadedConfig,
    private readonly logger: Logger
  ) {}

  isNamedApiConfigured(): boolean {
    return Boolean(this.config.app.cloudflare?.namedTunnel && this.config.env.cloudflareApiToken);
  }

  getBaseDomain(): string {
    const namedTunnel = this.config.app.cloudflare?.namedTunnel;
    if (!namedTunnel) {
      throw new CloudflareApiError("Named tunnel base domain is not configured.");
    }

    return namedTunnel.baseDomain;
  }

  async listPublishedHostnames(): Promise<Set<string>> {
    const config = await this.getTunnelConfig();
    return extractPublishedHostnames(config);
  }

  async ensureNamedPublication(hostname: string, targetUrl: string): Promise<void> {
    const currentConfig = await this.getTunnelConfig();
    const currentRule = findIngressRuleByHostname(currentConfig, hostname);

    if (currentRule?.service !== targetUrl) {
      const nextConfig = upsertIngressRule(currentConfig, hostname, targetUrl);
      await this.updateTunnelConfig(nextConfig);
    }

    await this.ensureTunnelDnsRecord(hostname);
  }

  async removeNamedPublication(hostname: string): Promise<void> {
    const currentConfig = await this.getTunnelConfig();
    const currentRule = findIngressRuleByHostname(currentConfig, hostname);

    if (currentRule) {
      const nextConfig = removeIngressRule(currentConfig, hostname);
      await this.updateTunnelConfig(nextConfig);
    }

    await this.removeTunnelDnsRecord(hostname);
  }

  async listTunnelConnections(): Promise<TunnelConnection[]> {
    const namedTunnel = this.requireNamedTunnel();

    return this.request<TunnelConnection[]>(
      `/accounts/${namedTunnel.accountId}/cfd_tunnel/${namedTunnel.tunnelId}/connections`,
      { method: "GET" }
    );
  }

  private async getTunnelConfig(): Promise<TunnelConfigPayload> {
    const namedTunnel = this.requireNamedTunnel();
    const result = await this.request<TunnelConfigurationResult>(
      `/accounts/${namedTunnel.accountId}/cfd_tunnel/${namedTunnel.tunnelId}/configurations`,
      { method: "GET" }
    );

    return result.config ?? { ingress: [{ service: "http_status:404" }] };
  }

  private async updateTunnelConfig(config: TunnelConfigPayload): Promise<void> {
    const namedTunnel = this.requireNamedTunnel();

    await this.request<TunnelConfigurationResult>(
      `/accounts/${namedTunnel.accountId}/cfd_tunnel/${namedTunnel.tunnelId}/configurations`,
      {
        method: "PUT",
        body: JSON.stringify({
          config
        })
      }
    );
  }

  private async ensureTunnelDnsRecord(hostname: string): Promise<void> {
    const namedTunnel = this.requireNamedTunnel();
    const normalizedHostname = hostname.toLowerCase();
    const tunnelTarget = `${namedTunnel.tunnelId}.cfargotunnel.com`;
    const records = await this.listDnsRecords(normalizedHostname);
    const matchingRecord = records.find((record) => this.normalizeDnsName(record.content) === tunnelTarget);
    const conflictingRecord = records.find((record) => this.normalizeDnsName(record.content) !== tunnelTarget);

    if (conflictingRecord) {
      throw new CloudflareApiError(
        `Refusing to overwrite conflicting DNS record for ${normalizedHostname}. Existing record points to ${conflictingRecord.content}.`
      );
    }

    if (matchingRecord) {
      if (matchingRecord.proxied === true && matchingRecord.ttl === 1) {
        return;
      }

      await this.request<DnsRecord>(
        `/zones/${namedTunnel.zoneId}/dns_records/${matchingRecord.id}`,
        {
          method: "PUT",
          body: JSON.stringify({
            type: "CNAME",
            name: normalizedHostname,
            content: tunnelTarget,
            proxied: true,
            ttl: 1
          })
        }
      );

      return;
    }

    await this.request<DnsRecord>(
      `/zones/${namedTunnel.zoneId}/dns_records`,
      {
        method: "POST",
        body: JSON.stringify({
          type: "CNAME",
          name: normalizedHostname,
          content: tunnelTarget,
          proxied: true,
          ttl: 1
        })
      }
    );
  }

  private async removeTunnelDnsRecord(hostname: string): Promise<void> {
    const namedTunnel = this.requireNamedTunnel();
    const normalizedHostname = hostname.toLowerCase();
    const tunnelTarget = `${namedTunnel.tunnelId}.cfargotunnel.com`;
    const records = await this.listDnsRecords(normalizedHostname);

    for (const record of records) {
      if (this.normalizeDnsName(record.content) !== tunnelTarget) {
        this.logger.warn("Skipping DNS record removal because it does not point at this tunnel.", {
          hostname: normalizedHostname,
          recordId: record.id,
          content: record.content
        });
        continue;
      }

      await this.request<string>(
        `/zones/${namedTunnel.zoneId}/dns_records/${record.id}`,
        { method: "DELETE" }
      );
    }
  }

  private async listDnsRecords(hostname: string): Promise<DnsRecord[]> {
    const namedTunnel = this.requireNamedTunnel();
    const query = new URLSearchParams({
      type: "CNAME",
      name: hostname.toLowerCase()
    });

    return this.request<DnsRecord[]>(
      `/zones/${namedTunnel.zoneId}/dns_records?${query.toString()}`,
      { method: "GET" }
    );
  }

  private requireNamedTunnel() {
    const namedTunnel = this.config.app.cloudflare?.namedTunnel;
    if (!namedTunnel || !this.config.env.cloudflareApiToken) {
      throw new CloudflareApiError("Named Cloudflare API settings are incomplete.");
    }

    return namedTunnel;
  }

  private normalizeDnsName(value: string): string {
    return value.toLowerCase().replace(/\.$/, "");
  }

  private async request<T>(requestPath: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.apiBaseUrl}${requestPath}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.env.cloudflareApiToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers
      }
    });

    const raw = (await response.json()) as CloudflareEnvelope<T>;
    if (!response.ok || raw.success === false) {
      const message = raw.errors?.map((error) => error.message).join("; ") || `${response.status} ${response.statusText}`;
      throw new CloudflareApiError(message);
    }

    return raw.result;
  }
}
