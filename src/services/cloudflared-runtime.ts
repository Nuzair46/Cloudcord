import { ChildProcessByStdio, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { Logger } from "../logger";
import { PublicationRepository } from "./publication-repository";

interface QuickTunnelProcess {
  process: CloudflaredChildProcess;
  publicUrl: string;
}

type CloudflaredChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export class CloudflaredRuntime {
  private namedConnector?: CloudflaredChildProcess;
  private readonly quickTunnels = new Map<string, QuickTunnelProcess>();

  constructor(
    private readonly repository: PublicationRepository,
    private readonly logger: Logger
  ) {}

  async ensureNamedConnectorStarted(tunnelToken: string): Promise<void> {
    if (this.namedConnector && this.namedConnector.exitCode === null && !this.namedConnector.killed) {
      return;
    }

    const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "run", "--token", tunnelToken], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.namedConnector = child;
    child.stdout.on("data", (chunk) => {
      this.logger.debug("named-cloudflared", { output: chunk.toString().trim() });
    });
    child.stderr.on("data", (chunk) => {
      this.logger.debug("named-cloudflared", { output: chunk.toString().trim() });
    });
    child.on("exit", (code, signal) => {
      this.logger.warn("Named cloudflared connector exited.", {
        code,
        signal
      });
      this.namedConnector = undefined;
    });
  }

  async startQuickTunnel(publicationId: string, targetUrl: string): Promise<string> {
    if (this.quickTunnels.has(publicationId)) {
      throw new Error(`Quick tunnel for publication "${publicationId}" is already running.`);
    }

    const child = spawn("cloudflared", ["tunnel", "--url", targetUrl], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let buffer = "";

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        child.kill("SIGTERM");
        reject(new Error("Timed out waiting for the Cloudflare quick tunnel URL."));
      }, 20000);

      const handleChunk = (chunk: Buffer): void => {
        const text = chunk.toString();
        buffer += text;
        this.logger.debug("quick-cloudflared", { publicationId, output: text.trim() });

        const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match && !settled) {
          settled = true;
          clearTimeout(timeout);
          this.quickTunnels.set(publicationId, {
            process: child,
            publicUrl: match[0]
          });
          resolve(match[0]);
        }

        if (buffer.length > 4096) {
          buffer = buffer.slice(-4096);
        }
      };

      child.stdout.on("data", handleChunk);
      child.stderr.on("data", handleChunk);
      child.on("error", (error) => {
        clearTimeout(timeout);
        this.quickTunnels.delete(publicationId);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timeout);
        this.quickTunnels.delete(publicationId);
        void this.repository.markPublicationStale(publicationId, `cloudflared_exit:${code ?? signal ?? "unknown"}`);

        if (!settled) {
          settled = true;
          reject(new Error(`Quick tunnel exited before returning a public URL (${code ?? signal ?? "unknown"}).`));
        }
      });
    });
  }

  stopQuickTunnel(publicationId: string): boolean {
    const entry = this.quickTunnels.get(publicationId);
    if (!entry) {
      return false;
    }

    this.quickTunnels.delete(publicationId);
    return entry.process.kill("SIGTERM");
  }

  isQuickTunnelRunning(publicationId: string): boolean {
    return this.quickTunnels.has(publicationId);
  }

  async shutdown(): Promise<void> {
    if (this.namedConnector && this.namedConnector.exitCode === null && !this.namedConnector.killed) {
      this.namedConnector.kill("SIGTERM");
    }

    for (const [publicationId, entry] of this.quickTunnels.entries()) {
      this.quickTunnels.delete(publicationId);
      entry.process.kill("SIGTERM");
    }
  }
}
