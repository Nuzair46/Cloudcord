export interface TunnelOriginRequest {
  noTLSVerify?: boolean;
  httpHostHeader?: string;
  originServerName?: string;
  disableChunkedEncoding?: boolean;
}

export interface NamedTunnelConfig {
  accountId: string;
  zoneId: string;
  tunnelId: string;
  baseDomain: string;
}

export interface PublishPolicy {
  allowContainerHostnames: boolean;
  allowedHosts: string[];
  allowedPortRanges: Array<{
    start: number;
    end: number;
  }>;
}

export interface AppConfig {
  discord: {
    guildId: string;
    allowedChannelId: string;
  };
  storage: {
    databasePath: string;
  };
  publishPolicy: PublishPolicy;
  cloudflare?: {
    namedTunnel?: NamedTunnelConfig;
  };
}

export interface EnvironmentConfig {
  discordBotToken: string;
  cloudflareApiToken?: string;
  cloudflareTunnelToken?: string;
  logLevel: string;
}

export interface LoadedConfig {
  app: AppConfig;
  env: EnvironmentConfig;
}

export interface ActorContext {
  discordUserId: string;
  discordTag: string;
}

export type PublicationMode = "quick" | "named";
export type PublishModePreference = "auto" | "quick" | "named";
export type PublicationStatus = "active" | "inactive" | "stale" | "error";
export type AliasStatus = "active" | "stale" | "unpublished";

export interface PublicationRecord {
  id: string;
  mode: PublicationMode;
  aliasName?: string;
  requestedTarget: string;
  resolvedTarget: string;
  publicUrl: string;
  hostname?: string;
  status: PublicationStatus;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string;
  actorId?: string;
  actorTag?: string;
  exitReason?: string;
}

export interface AliasRecord {
  name: string;
  requestedTarget: string;
  resolvedTarget: string;
  currentPublicationId?: string;
  createdAt: string;
  updatedAt: string;
  actorId?: string;
  actorTag?: string;
}

export interface AliasListItem {
  alias: AliasRecord;
  publication?: PublicationRecord;
  status: AliasStatus;
}

export interface TargetResolution {
  requestedTarget: string;
  resolvedTarget: string;
  hostname: string;
  port: number;
  protocol: "http:" | "https:";
}

export interface TunnelIngressRule {
  hostname?: string;
  service: string;
  path?: string;
  originRequest?: TunnelOriginRequest;
}

export interface TunnelConfigPayload {
  ingress: TunnelIngressRule[];
  originRequest?: TunnelOriginRequest;
}

export interface TunnelConnection {
  id?: string;
  client_id?: string;
  colo_name?: string;
  is_pending_reconnect?: boolean;
  opened_at?: string;
}

export interface CloudflareEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result: T;
}

export interface TunnelConfigurationResult {
  account_tag?: string;
  config?: TunnelConfigPayload;
  version?: number;
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
}
