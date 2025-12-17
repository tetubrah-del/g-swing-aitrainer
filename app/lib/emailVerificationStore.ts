import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type VerificationRecord = {
  tokenHash: string;
  email: string;
  anonymousUserId: string | null;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
};

const records = new Map<string, VerificationRecord>();
const STORE_PATH = path.join(os.tmpdir(), "golf-email-verification.json");

async function loadFromDisk() {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, VerificationRecord>;
    Object.entries(parsed).forEach(([tokenHash, value]) => {
      if (!value || typeof value !== "object") return;
      if (typeof value.email !== "string") return;
      if (typeof value.expiresAt !== "number") return;
      records.set(tokenHash, {
        tokenHash,
        email: value.email,
        anonymousUserId: typeof value.anonymousUserId === "string" ? value.anonymousUserId : null,
        createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
        expiresAt: value.expiresAt,
        usedAt: typeof value.usedAt === "number" ? value.usedAt : null,
      });
    });
  } catch {
    // ignore
  }
}

const loadPromise = loadFromDisk();

export async function resetEmailVerificationStore() {
  await loadPromise;
  records.clear();
  await persistToDisk();
}

async function persistToDisk() {
  const obj = Object.fromEntries(records.entries());
  try {
    await fs.writeFile(STORE_PATH, JSON.stringify(obj), "utf8");
  } catch {
    // ignore
  }
}

const hashToken = (token: string): string =>
  crypto.createHash("sha256").update(token, "utf8").digest("hex");

const generateToken = (): string => crypto.randomBytes(32).toString("base64url");

export async function createEmailVerification(params: {
  email: string;
  anonymousUserId: string | null;
  ttlMs?: number;
}): Promise<{ token: string; expiresAt: number }> {
  await loadPromise;
  const now = Date.now();
  const token = generateToken();
  const expiresAt = now + (params.ttlMs ?? 1000 * 60 * 30); // 30 minutes
  const tokenHash = hashToken(token);
  records.set(tokenHash, {
    tokenHash,
    email: params.email,
    anonymousUserId: params.anonymousUserId,
    createdAt: now,
    expiresAt,
    usedAt: null,
  });
  await persistToDisk();
  return { token, expiresAt };
}

export async function consumeEmailVerification(token: string): Promise<{
  email: string;
  anonymousUserId: string | null;
}> {
  await loadPromise;
  const tokenHash = hashToken(token);
  const record = records.get(tokenHash);
  if (!record) throw new Error("invalid token");
  if (record.usedAt) throw new Error("token already used");
  if (Date.now() > record.expiresAt) throw new Error("token expired");
  record.usedAt = Date.now();
  records.set(tokenHash, record);
  await persistToDisk();
  return { email: record.email, anonymousUserId: record.anonymousUserId };
}
