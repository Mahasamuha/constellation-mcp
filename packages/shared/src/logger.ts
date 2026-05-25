import pino from "pino";

export const logger = pino({ level: process.env["LOG_LEVEL"] ?? "warn" });

export function createLogger(name: string) {
  return logger.child({ module: name });
}
