type LogLevel = "debug" | "info" | "warn" | "error";

const levelWeights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class Logger {
  constructor(private readonly minLevel: LogLevel) {}

  debug(message: string, metadata?: Record<string, unknown>): void {
    this.write("debug", message, metadata);
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    this.write("info", message, metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    this.write("warn", message, metadata);
  }

  error(message: string, metadata?: Record<string, unknown>): void {
    this.write("error", message, metadata);
  }

  private write(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    if (levelWeights[level] < levelWeights[this.minLevel]) {
      return;
    }

    const payload = {
      level,
      timestamp: new Date().toISOString(),
      message,
      ...(metadata ? { metadata } : {})
    };

    const line = JSON.stringify(payload);
    if (level === "error" || level === "warn") {
      console.error(line);
      return;
    }

    console.log(line);
  }
}

export function normalizeLogLevel(value: string | undefined): LogLevel {
  if (!value) {
    return "info";
  }

  const normalized = value.toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }

  return "info";
}
