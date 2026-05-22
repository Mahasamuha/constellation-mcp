import pino from "pino";

export const logger = pino();

export function createLogger(name: string) {
  return logger.child({ module: name });
}
