import { TunnelConfigPayload, TunnelIngressRule } from "../types";

export const CATCH_ALL_SERVICE = "http_status:404";

export function createDefaultTunnelConfig(): TunnelConfigPayload {
  return {
    ingress: [{ service: CATCH_ALL_SERVICE }]
  };
}

export function findIngressRuleByHostname(
  config: TunnelConfigPayload | null | undefined,
  hostname: string
): TunnelIngressRule | undefined {
  const normalized = hostname.toLowerCase();
  return (config?.ingress ?? []).find((rule) => rule.hostname?.toLowerCase() === normalized);
}

export function extractPublishedHostnames(config: TunnelConfigPayload | null | undefined): Set<string> {
  const published = new Set<string>();

  for (const rule of config?.ingress ?? []) {
    if (!rule.hostname || rule.service === CATCH_ALL_SERVICE) {
      continue;
    }

    published.add(rule.hostname.toLowerCase());
  }

  return published;
}

export function upsertIngressRule(
  current: TunnelConfigPayload | null | undefined,
  hostname: string,
  serviceUrl: string
): TunnelConfigPayload {
  const base = current ?? createDefaultTunnelConfig();
  const { rulesWithoutCatchAll, catchAllRule } = splitRules(base.ingress);
  const filteredRules = rulesWithoutCatchAll.filter((rule) => rule.hostname?.toLowerCase() !== hostname.toLowerCase());

  filteredRules.push({
    hostname,
    service: serviceUrl
  });

  return {
    ...(base.originRequest ? { originRequest: base.originRequest } : {}),
    ingress: [...filteredRules, catchAllRule]
  };
}

export function removeIngressRule(
  current: TunnelConfigPayload | null | undefined,
  hostname: string
): TunnelConfigPayload {
  const base = current ?? createDefaultTunnelConfig();
  const { rulesWithoutCatchAll, catchAllRule } = splitRules(base.ingress);
  const filteredRules = rulesWithoutCatchAll.filter((rule) => rule.hostname?.toLowerCase() !== hostname.toLowerCase());

  return {
    ...(base.originRequest ? { originRequest: base.originRequest } : {}),
    ingress: [...filteredRules, catchAllRule]
  };
}

function splitRules(rules: TunnelIngressRule[]): {
  rulesWithoutCatchAll: TunnelIngressRule[];
  catchAllRule: TunnelIngressRule;
} {
  if (rules.length === 0) {
    return {
      rulesWithoutCatchAll: [],
      catchAllRule: { service: CATCH_ALL_SERVICE }
    };
  }

  const catchAllIndex = [...rules].reverse().findIndex((rule) => !rule.hostname);

  if (catchAllIndex === -1) {
    return {
      rulesWithoutCatchAll: [...rules],
      catchAllRule: { service: CATCH_ALL_SERVICE }
    };
  }

  const normalizedIndex = rules.length - catchAllIndex - 1;
  const catchAllRule = rules[normalizedIndex];
  const rulesWithoutCatchAll = rules.filter((_, index) => index !== normalizedIndex);

  return {
    rulesWithoutCatchAll,
    catchAllRule
  };
}
