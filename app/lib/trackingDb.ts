import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

type TrackingDb = DatabaseSync;

declare global {
  var trackingDb: TrackingDb | undefined;
}

function resolveDbPath(): string {
  const raw = (process.env.DATABASE_URL ?? "file:./data/app.db").trim();
  const normalized = raw.startsWith("file:") ? raw.slice("file:".length) : raw;
  const withoutQuery = normalized.split("?")[0] ?? normalized;
  const dbPath = path.isAbsolute(withoutQuery) ? withoutQuery : path.join(process.cwd(), withoutQuery);
  return dbPath;
}

function openDb(): TrackingDb {
  const dbPath = resolveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  ensureSchema(db);
  return db;
}

function ensureSchema(db: TrackingDb) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ReferralCode (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      userId TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ShareEvent (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      analysisId TEXT NOT NULL,
      referralCode TEXT NOT NULL,
      snsType TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shareevent_user_createdAt ON ShareEvent(userId, createdAt);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shareevent_ref_createdAt ON ShareEvent(referralCode, createdAt);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shareevent_analysisId ON ShareEvent(analysisId);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ReferralVisit (
      id TEXT PRIMARY KEY,
      referralCode TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      visitedAt INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_refvisit_ref_visitedAt ON ReferralVisit(referralCode, visitedAt);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_refvisit_session_visitedAt ON ReferralVisit(sessionId, visitedAt);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS Registration (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      referralCode TEXT,
      registeredAt INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_registration_ref_registeredAt ON Registration(referralCode, registeredAt);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_registration_user_registeredAt ON Registration(userId, registeredAt);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS Payment (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      amount INTEGER NOT NULL,
      referralCode TEXT,
      paidAt INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_ref_paidAt ON Payment(referralCode, paidAt);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_user_paidAt ON Payment(userId, paidAt);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS SharedAnalysisSnapshot (
      analysisId TEXT PRIMARY KEY,
      totalScore INTEGER,
      createdAt INTEGER
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS SharedAnalysisDetail (
      analysisId TEXT PRIMARY KEY,
      payloadJson TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);
}

export function getTrackingDb(): TrackingDb {
  if (globalThis.trackingDb) {
    // Hot reload / long-lived process: schema may evolve; ensure idempotently.
    ensureSchema(globalThis.trackingDb);
    return globalThis.trackingDb;
  }
  const db = openDb();
  globalThis.trackingDb = db;
  return db;
}
