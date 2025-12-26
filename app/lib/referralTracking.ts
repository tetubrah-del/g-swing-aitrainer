import crypto from "node:crypto";
import { getTrackingDb } from "@/app/lib/trackingDb";

export type ShareSnsType = "twitter" | "instagram" | "copy";

export function isValidReferralCode(code: string | null | undefined): code is string {
  if (!code) return false;
  return /^[A-Za-z0-9_-]{8,64}$/.test(code);
}

function nowMs() {
  return Date.now();
}

function generateId() {
  return crypto.randomUUID();
}

function generateReferralCode() {
  // URL-safe base64, trimmed for readability.
  return crypto.randomBytes(12).toString("base64url");
}

export function ensureReferralCode(userId: string): string {
  const db = getTrackingDb();
  const existing = db
    .prepare("SELECT code FROM ReferralCode WHERE userId = ? ORDER BY createdAt DESC LIMIT 1")
    .get(userId) as { code?: string } | undefined;
  if (existing?.code) return existing.code;

  while (true) {
    const code = generateReferralCode();
    try {
      db.prepare("INSERT INTO ReferralCode (id, code, userId, createdAt) VALUES (?, ?, ?, ?)")
        .run(generateId(), code, userId, nowMs());
      return code;
    } catch (e) {
      // retry only for unique constraint collisions
      if (e instanceof Error && /UNIQUE/i.test(e.message)) continue;
      throw e;
    }
  }
}

export function recordShareEvent(params: { userId: string; analysisId: string; snsType: ShareSnsType }): string {
  const db = getTrackingDb();
  const referralCode = ensureReferralCode(params.userId);
  db.prepare("INSERT INTO ShareEvent (id, userId, analysisId, referralCode, snsType, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
    .run(generateId(), params.userId, params.analysisId, referralCode, params.snsType, nowMs());
  return referralCode;
}

export function recordReferralVisit(params: { referralCode: string; sessionId: string }) {
  const db = getTrackingDb();
  db.prepare("INSERT INTO ReferralVisit (id, referralCode, sessionId, visitedAt) VALUES (?, ?, ?, ?)")
    .run(generateId(), params.referralCode, params.sessionId, nowMs());
}

export function recordRegistration(params: { userId: string; referralCode: string | null }) {
  const db = getTrackingDb();
  db.prepare("INSERT INTO Registration (id, userId, referralCode, registeredAt) VALUES (?, ?, ?, ?)")
    .run(generateId(), params.userId, params.referralCode, nowMs());
}

export function recordPayment(params: { userId: string; amount: number; referralCode: string | null; paidAtMs?: number }) {
  const db = getTrackingDb();
  const paidAt = typeof params.paidAtMs === "number" ? params.paidAtMs : nowMs();
  const amount = Math.trunc(params.amount);
  const already = db
    .prepare("SELECT 1 as ok FROM Payment WHERE userId = ? AND amount = ? AND paidAt = ? LIMIT 1")
    .get(params.userId, amount, paidAt) as { ok?: number } | undefined;
  if (already?.ok) return;

  db.prepare("INSERT INTO Payment (id, userId, amount, referralCode, paidAt) VALUES (?, ?, ?, ?, ?)")
    .run(generateId(), params.userId, amount, params.referralCode, paidAt);
}

export function upsertSharedAnalysisSnapshot(params: {
  analysisId: string;
  totalScore: number | null;
  createdAt: number | null;
}) {
  const db = getTrackingDb();
  const totalScore =
    typeof params.totalScore === "number" && Number.isFinite(params.totalScore) ? Math.trunc(params.totalScore) : null;
  const createdAt =
    typeof params.createdAt === "number" && Number.isFinite(params.createdAt) ? Math.trunc(params.createdAt) : null;
  db.prepare(
    "INSERT INTO SharedAnalysisSnapshot (analysisId, totalScore, createdAt) VALUES (?, ?, ?) " +
      "ON CONFLICT(analysisId) DO UPDATE SET totalScore=excluded.totalScore, createdAt=excluded.createdAt",
  ).run(params.analysisId, totalScore, createdAt);
}

export function getSharedAnalysisSnapshot(analysisId: string): { analysisId: string; totalScore: number | null; createdAt: number | null } | null {
  const db = getTrackingDb();
  const row = db
    .prepare("SELECT analysisId, totalScore, createdAt FROM SharedAnalysisSnapshot WHERE analysisId = ? LIMIT 1")
    .get(analysisId) as { analysisId?: string; totalScore?: number | null; createdAt?: number | null } | undefined;
  if (!row?.analysisId) return null;
  return {
    analysisId: row.analysisId,
    totalScore: typeof row.totalScore === "number" ? row.totalScore : null,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : null,
  };
}

export function upsertSharedAnalysisDetail(analysisId: string, payload: unknown) {
  const db = getTrackingDb();
  const payloadJson = JSON.stringify(payload ?? {});
  db.prepare(
    "INSERT INTO SharedAnalysisDetail (analysisId, payloadJson, updatedAt) VALUES (?, ?, ?) " +
      "ON CONFLICT(analysisId) DO UPDATE SET payloadJson=excluded.payloadJson, updatedAt=excluded.updatedAt",
  ).run(analysisId, payloadJson, nowMs());
}

export function getSharedAnalysisDetail<T = unknown>(analysisId: string): { analysisId: string; payload: T; updatedAt: number } | null {
  const db = getTrackingDb();
  const row = db
    .prepare("SELECT analysisId, payloadJson, updatedAt FROM SharedAnalysisDetail WHERE analysisId = ? LIMIT 1")
    .get(analysisId) as { analysisId?: string; payloadJson?: string; updatedAt?: number } | undefined;
  if (!row?.analysisId || typeof row.payloadJson !== "string") return null;
  try {
    const payload = JSON.parse(row.payloadJson) as T;
    return { analysisId: row.analysisId, payload, updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0 };
  } catch {
    return { analysisId: row.analysisId, payload: {} as T, updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0 };
  }
}

export function getReferralCodeAtRegistration(userId: string): string | null {
  const db = getTrackingDb();
  const row = db
    .prepare("SELECT referralCode FROM Registration WHERE userId = ? ORDER BY registeredAt DESC LIMIT 1")
    .get(userId) as { referralCode?: string | null } | undefined;
  if (!row) return null;
  return typeof row.referralCode === "string" && row.referralCode.trim().length ? row.referralCode : null;
}

export function getMonitorStats(params: { userId: string; nowMs?: number }): {
  shareCount: number;
  signupCount: number;
  paidCount: number;
} {
  const db = getTrackingDb();
  const now = params.nowMs ?? Date.now();

  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const startTs = start.getTime();

  const shareCountRow = db
    .prepare("SELECT COUNT(*) as c FROM ShareEvent WHERE userId = ? AND createdAt >= ?")
    .get(params.userId, startTs) as { c: number };

  const referralCode = db
    .prepare("SELECT code FROM ReferralCode WHERE userId = ? ORDER BY createdAt DESC LIMIT 1")
    .get(params.userId) as { code?: string } | undefined;

  if (!referralCode?.code) {
    return { shareCount: Number(shareCountRow?.c ?? 0), signupCount: 0, paidCount: 0 };
  }

  const signupRows = db
    .prepare("SELECT userId FROM Registration WHERE referralCode = ?")
    .all(referralCode.code) as Array<{ userId: string }>;
  const signupCount = new Set(signupRows.map((r) => r.userId)).size;

  const paidRows = db
    .prepare("SELECT userId FROM Payment WHERE referralCode = ?")
    .all(referralCode.code) as Array<{ userId: string }>;
  const paidCount = new Set(paidRows.map((r) => r.userId)).size;

  return {
    shareCount: Number(shareCountRow?.c ?? 0),
    signupCount,
    paidCount,
  };
}

export function getAdminMonitorRows(params: { userIds: string[] }): Array<{
  userId: string;
  referralCode: string | null;
  shares: number;
  signups: number;
  paid: number;
  revenue: number;
}> {
  const db = getTrackingDb();
  const rows: Array<{
    userId: string;
    referralCode: string | null;
    shares: number;
    signups: number;
    paid: number;
    revenue: number;
  }> = [];

  for (const userId of params.userIds) {
    const codeRow = db
      .prepare("SELECT code FROM ReferralCode WHERE userId = ? ORDER BY createdAt DESC LIMIT 1")
      .get(userId) as { code?: string } | undefined;
    const referralCode = codeRow?.code ?? null;

    const sharesRow = db.prepare("SELECT COUNT(*) as c FROM ShareEvent WHERE userId = ?").get(userId) as { c: number };

    let signups = 0;
    let paidUsers = 0;
    let revenue = 0;

    if (referralCode) {
      const signupRows = db.prepare("SELECT userId FROM Registration WHERE referralCode = ?").all(referralCode) as Array<{
        userId: string;
      }>;
      signups = new Set(signupRows.map((r) => r.userId)).size;

      const paymentRows = db
        .prepare("SELECT userId, amount FROM Payment WHERE referralCode = ?")
        .all(referralCode) as Array<{ userId: string; amount: number }>;
      paidUsers = new Set(paymentRows.map((r) => r.userId)).size;
      revenue = paymentRows.reduce((sum, row) => sum + (Number.isFinite(row.amount) ? Number(row.amount) : 0), 0);
    }

    rows.push({
      userId,
      referralCode,
      shares: Number(sharesRow?.c ?? 0),
      signups,
      paid: paidUsers,
      revenue,
    });
  }

  rows.sort((a, b) => b.revenue - a.revenue);
  return rows;
}
