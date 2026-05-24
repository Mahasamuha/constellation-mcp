import bcrypt from "bcryptjs";
import { prisma } from "./db.js";
import { createLogger } from "@constellation/shared";

const log = createLogger("local-auth");

const BCRYPT_COST = 12;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

const loginFailures = new Map<string, number[]>();

export function checkBruteForce(ip: string): boolean {
  const now = Date.now();
  const failures = (loginFailures.get(ip) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  return failures.length < MAX_FAILURES;
}

export function recordFailure(ip: string): void {
  const now = Date.now();
  const failures = (loginFailures.get(ip) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  failures.push(now);
  loginFailures.set(ip, failures);
}

export function pruneLoginFailures(): void {
  const now = Date.now();
  for (const [ip, ts] of loginFailures) {
    const fresh = ts.filter((t) => now - t < FAILURE_WINDOW_MS);
    if (fresh.length === 0) loginFailures.delete(ip);
    else loginFailures.set(ip, fresh);
  }
}

/**
 * Creates a LocalUser + linked User row in a single transaction.
 * Throws if the username is already taken.
 */
export async function createLocalUser(username: string, password: string): Promise<string> {
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email: username },
      select: { id: true },
    });

    await tx.localUser.create({
      data: { username, passwordHash, userId: user.id },
    });

    return user.id;
  });

  log.info({ username }, "Local user created");
  return result;
}

/**
 * Validates credentials and returns the User.id on success.
 * Throws on invalid credentials or deactivated account.
 */
export async function validateLocalUser(username: string, password: string): Promise<string> {
  const localUser = await prisma.localUser.findUnique({
    where: { username },
    include: { user: { select: { id: true, deactivatedAt: true } } },
  });

  if (!localUser) {
    // Constant-time dummy compare to avoid username enumeration via timing
    await bcrypt.compare(password, "$2a$12$invalidhashpadding000000000000000000000000000000000000000");
    throw new Error("Invalid credentials");
  }

  const valid = await bcrypt.compare(password, localUser.passwordHash);
  if (!valid) throw new Error("Invalid credentials");

  if (!localUser.isActive || localUser.user.deactivatedAt !== null) {
    throw new Error("Account is deactivated");
  }

  await prisma.localUser.update({
    where: { id: localUser.id },
    data: { lastLoginAt: new Date() },
  });

  log.info({ username }, "Local user authenticated");
  return localUser.user.id;
}
