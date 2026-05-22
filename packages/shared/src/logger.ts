import pino from "pino";

const isDev = process.stdout.isTTY === true && process.env.NODE_ENV !== "production";

export const logger = pino(
  isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }
    : {}
);

export function createLogger(name: string) {
  return logger.child({ module: name });
}
