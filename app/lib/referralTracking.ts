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

export function getUserPaymentSummary(userId: string): {
  totalAmount: number;
  firstPaidAt: number | null;
  lastPaidAt: number | null;
  paidMonths: number;
} {
  const db = getTrackingDb();
  const row = db
    .prepare(
      "SELECT " +
        "SUM(amount) as totalAmount, " +
        "MIN(paidAt) as firstPaidAt, " +
        "MAX(paidAt) as lastPaidAt, " +
        "COUNT(DISTINCT strftime('%Y-%m', paidAt/1000, 'unixepoch')) as paidMonths " +
        "FROM Payment WHERE userId = ?",
    )
    .get(userId) as
    | { totalAmount?: number | null; firstPaidAt?: number | null; lastPaidAt?: number | null; paidMonths?: number | null }
    | undefined;

  return {
    totalAmount: Number(row?.totalAmount ?? 0) || 0,
    firstPaidAt: typeof row?.firstPaidAt === "number" ? row.firstPaidAt : null,
    lastPaidAt: typeof row?.lastPaidAt === "number" ? row.lastPaidAt : null,
    paidMonths: Number(row?.paidMonths ?? 0) || 0,
  };
}

export function getReferralCodeForUser(userId: string): string | null {
  const db = getTrackingDb();
  const row = db
    .prepare("SELECT code FROM ReferralCode WHERE userId = ? ORDER BY createdAt DESC LIMIT 1")
    .get(userId) as { code?: string } | undefined;
  const code = typeof row?.code === "string" ? row.code : null;
  return code && code.trim().length ? code : null;
}

export function getMonitorPerformance(params: { userId: string; nowMs?: number }): {
  userId: string;
  referralCode: string | null;
  sharesAll: number;
  sharesThisMonth: number;
  signupsAll: number;
  paidAll: number;
  revenueAll: number;
} {
  const db = getTrackingDb();
  const now = params.nowMs ?? Date.now();

  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const startTs = start.getTime();

  const sharesAllRow = db.prepare("SELECT COUNT(*) as c FROM ShareEvent WHERE userId = ?").get(params.userId) as { c: number };
  const sharesMonthRow = db
    .prepare("SELECT COUNT(*) as c FROM ShareEvent WHERE userId = ? AND createdAt >= ?")
    .get(params.userId, startTs) as { c: number };

  const referralCode = getReferralCodeForUser(params.userId);

  let signupsAll = 0;
  let paidAll = 0;
  let revenueAll = 0;

  if (referralCode) {
    const signupRows = db.prepare("SELECT userId FROM Registration WHERE referralCode = ?").all(referralCode) as Array<{ userId: string }>;
    signupsAll = new Set(signupRows.map((r) => r.userId)).size;

    const paymentRows = db
      .prepare("SELECT userId, amount FROM Payment WHERE referralCode = ?")
      .all(referralCode) as Array<{ userId: string; amount: number }>;
    paidAll = new Set(paymentRows.map((r) => r.userId)).size;
    revenueAll = paymentRows.reduce((sum, row) => sum + (Number.isFinite(row.amount) ? Number(row.amount) : 0), 0);
  }

  return {
    userId: params.userId,
    referralCode,
    sharesAll: Number(sharesAllRow?.c ?? 0),
    sharesThisMonth: Number(sharesMonthRow?.c ?? 0),
    signupsAll,
    paidAll,
    revenueAll,
  };
}

export type CouponGrantRow = {
  id: string;
  userId: string;
  code: string;
  note: string | null;
  expiresAt: number | null;
  createdAt: number;
  createdBy: string | null;
};

export function listCouponGrants(userId: string): CouponGrantRow[] {
  const db = getTrackingDb();
  const rows = db
    .prepare("SELECT id, userId, code, note, expiresAt, createdAt, createdBy FROM CouponGrant WHERE userId = ? ORDER BY createdAt DESC")
    .all(userId) as Array<Partial<CouponGrantRow>>;
  return rows.map((r) => ({
    id: String(r.id ?? ""),
    userId: String(r.userId ?? userId),
    code: String(r.code ?? ""),
    note: typeof r.note === "string" ? r.note : null,
    expiresAt: typeof r.expiresAt === "number" ? r.expiresAt : null,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    createdBy: typeof r.createdBy === "string" ? r.createdBy : null,
  }));
}

export function grantCoupon(params: {
  userId: string;
  code: string;
  note?: string | null;
  expiresAt?: number | null;
  createdBy?: string | null;
}): CouponGrantRow {
  const db = getTrackingDb();
  const id = generateId();
  const createdAt = nowMs();
  const note = typeof params.note === "string" && params.note.trim().length ? params.note.trim().slice(0, 200) : null;
  const expiresAt = typeof params.expiresAt === "number" && Number.isFinite(params.expiresAt) ? Math.trunc(params.expiresAt) : null;
  const createdBy =
    typeof params.createdBy === "string" && params.createdBy.trim().length ? params.createdBy.trim().slice(0, 200) : null;

  db.prepare("INSERT INTO CouponGrant (id, userId, code, note, expiresAt, createdAt, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, params.userId, params.code, note, expiresAt, createdAt, createdBy);

  return { id, userId: params.userId, code: params.code, note, expiresAt, createdAt, createdBy };
}

export function deleteReferralDataForUser(userId: string): void {
  const db = getTrackingDb();
  const codes = db
    .prepare("SELECT code FROM ReferralCode WHERE userId = ?")
    .all(userId) as Array<{ code?: string }>;
  const referralCodes = codes.map((r) => (typeof r.code === "string" ? r.code : "")).filter((v) => v.length > 0);

  db.prepare("DELETE FROM ShareEvent WHERE userId = ?").run(userId);
  db.prepare("DELETE FROM Registration WHERE userId = ?").run(userId);
  db.prepare("DELETE FROM Payment WHERE userId = ?").run(userId);
  db.prepare("DELETE FROM CouponGrant WHERE userId = ?").run(userId);
  db.prepare("DELETE FROM ReferralCode WHERE userId = ?").run(userId);

  if (referralCodes.length > 0) {
    const placeholders = referralCodes.map(() => "?").join(", ");
    db.prepare(`DELETE FROM ReferralVisit WHERE referralCode IN (${placeholders})`).run(...referralCodes);
  }
}

export function deleteSharedAnalysisData(analysisIds: string[]): void {
  if (!Array.isArray(analysisIds) || analysisIds.length === 0) return;
  const db = getTrackingDb();
  const CHUNK = 200;
  for (let i = 0; i < analysisIds.length; i += CHUNK) {
    const chunk = analysisIds.slice(i, i + CHUNK).filter((v) => typeof v === "string" && v.length > 0);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    db.prepare(`DELETE FROM SharedAnalysisSnapshot WHERE analysisId IN (${placeholders})`).run(...chunk);
    db.prepare(`DELETE FROM SharedAnalysisDetail WHERE analysisId IN (${placeholders})`).run(...chunk);
    db.prepare(`DELETE FROM ShareEvent WHERE analysisId IN (${placeholders})`).run(...chunk);
  }
}
