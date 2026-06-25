export function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

export function parseEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Environment variable ${name} must be a non-negative integer, got: ${JSON.stringify(raw)}`);
  }
  return parseInt(trimmed, 10);
}