import { PrismaClient } from "./generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });

export const prisma = new PrismaClient({ adapter });
