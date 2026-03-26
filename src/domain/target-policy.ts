import net from "node:net";
import { PublishPolicy, TargetResolution } from "../types";

const allowedProtocols = new Set(["http:", "https:"]);
const containerHostnamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function resolveTarget(rawTarget: string, policy: PublishPolicy): TargetResolution {
  let url: URL;

  try {
    url = new URL(rawTarget);
  } catch {
    throw new Error("Target must be a full URL such as http://host.docker.internal:3000.");
  }

  if (!allowedProtocols.has(url.protocol)) {
    throw new Error("Only http and https targets are supported.");
  }

  if (!isRootPath(url.pathname) || url.search || url.hash) {
    throw new Error("Target URLs must be origin-only. Do not include a path, query string, or hash.");
  }

  const originalHostname = normalizeHostname(url.hostname);
  const resolvedHostname = rewriteLoopbackHost(originalHostname);

  if (!isAllowedHost(resolvedHostname, policy)) {
    throw new Error(
      `Target host "${originalHostname}" is not allowed. Use localhost, host.docker.internal, a private IP, or a same-network container hostname.`
    );
  }

  const port = url.port ? Number(url.port) : getDefaultPort(url.protocol as "http:" | "https:");
  if (!isAllowedPort(port, policy)) {
    throw new Error(`Target port ${port} is not allowed by the current publish policy.`);
  }

  url.hostname = resolvedHostname;
  url.pathname = "";
  url.search = "";
  url.hash = "";

  return {
    requestedTarget: rawTarget,
    resolvedTarget: url.origin,
    hostname: resolvedHostname,
    port,
    protocol: url.protocol as "http:" | "https:"
  };
}

function isRootPath(pathname: string): boolean {
  return pathname === "" || pathname === "/";
}

function rewriteLoopbackHost(hostname: string): string {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
    return "host.docker.internal";
  }

  return hostname;
}

function isAllowedHost(hostname: string, policy: PublishPolicy): boolean {
  if (hostname === "host.docker.internal") {
    return true;
  }

  if (policy.allowedHosts.includes(hostname)) {
    return true;
  }

  if (isPrivateIp(hostname)) {
    return true;
  }

  if (policy.allowContainerHostnames && isContainerHostname(hostname)) {
    return true;
  }

  return false;
}

function isAllowedPort(port: number, policy: PublishPolicy): boolean {
  return policy.allowedPortRanges.some((range) => port >= range.start && port <= range.end);
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase();
}

function isContainerHostname(hostname: string): boolean {
  return containerHostnamePattern.test(hostname) && !hostname.includes(".");
}

function getDefaultPort(protocol: "http:" | "https:"): number {
  return protocol === "https:" ? 443 : 80;
}

function isPrivateIp(hostname: string): boolean {
  const ipVersion = net.isIP(hostname);

  if (ipVersion === 4) {
    const parts = hostname.split(".").map((value) => Number(value));
    if (parts[0] === 10) {
      return true;
    }
    if (parts[0] === 127) {
      return true;
    }
    if (parts[0] === 192 && parts[1] === 168) {
      return true;
    }
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
      return true;
    }
    if (parts[0] === 169 && parts[1] === 254) {
      return true;
    }
    return false;
  }

  if (ipVersion === 6) {
    const normalized = hostname.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }

  return false;
}
