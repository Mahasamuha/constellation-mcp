import { PrismaClient } from "./generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "@constellation/shared";

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });

export const prisma = new PrismaClient({ adapter });
