import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type VerificationRecord = {
  tokenHash: string;
  email: string;
  nickname: string | null;
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
      const nickname = typeof value.nickname === "string" ? value.nickname : null;
      records.set(tokenHash, {
        tokenHash,
        email: value.email,
        nickname,
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
  nickname: string | null;
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
    nickname: params.nickname,
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
  nickname: string | null;
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
  return { email: record.email, nickname: record.nickname ?? null, anonymousUserId: record.anonymousUserId };
}

export async function deleteEmailVerificationRecords(params: {
  email?: string | null;
  anonymousUserId?: string | null;
}): Promise<number> {
  await loadPromise;
  const email = typeof params.email === "string" ? params.email.trim().toLowerCase() : null;
  const anonymousUserId = typeof params.anonymousUserId === "string" ? params.anonymousUserId.trim() : null;
  if (!email && !anonymousUserId) return 0;

  let deleted = 0;
  for (const [tokenHash, record] of Array.from(records.entries())) {
    const matchesEmail = email && record.email.toLowerCase() === email;
    const matchesAnonymous = anonymousUserId && record.anonymousUserId === anonymousUserId;
    if (matchesEmail || matchesAnonymous) {
      records.delete(tokenHash);
      deleted += 1;
    }
  }
  if (deleted > 0) {
    await persistToDisk();
  }
  return deleted;
}
