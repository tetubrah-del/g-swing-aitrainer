import { GolfAnalysisResponse } from "@/app/golf/types";

const STORAGE_KEY = "golf_reports";
const ACTIVE_KEY = "golf_active_analysis";
const MAX_REPORTS = 20;

const getCanonicalCreatedAt = (record: GolfAnalysisResponse): number => {
  const fromResult = Date.parse(record.result?.createdAt ?? "");
  if (Number.isFinite(fromResult)) return fromResult;
  const fromField = typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : 0;
  return fromField;
};

export type ActiveAnalysisPointer = { analysisId: string; createdAt: number };

export function setActiveAnalysisPointer(analysisId: string, createdAt?: number): void {
  if (typeof window === "undefined") return;
  if (!analysisId) return;
  const ts = typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : Date.now();
  try {
    window.localStorage.setItem(ACTIVE_KEY, JSON.stringify({ analysisId, createdAt: ts } satisfies ActiveAnalysisPointer));
  } catch {
    // ignore
  }
}

export function getActiveAnalysisPointer(): ActiveAnalysisPointer | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveAnalysisPointer>;
    if (!parsed || typeof parsed.analysisId !== "string" || parsed.analysisId.length < 6) return null;
    const createdAt = typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt) ? parsed.createdAt : Date.now();
    return { analysisId: parsed.analysisId, createdAt };
  } catch {
    return null;
  }
}

export function clearActiveAnalysisPointer(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // ignore
  }
}

function isGolfAnalysisResponse(value: unknown): value is GolfAnalysisResponse {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<GolfAnalysisResponse>;
  return typeof record.analysisId === "string" && !!record.result && typeof record.result === "object";
}

export function loadStoredReports(): GolfAnalysisResponse[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const reports = parsed.filter(isGolfAnalysisResponse);
    // Normalize createdAt using result.createdAt so that "saved later" doesn't become "latest".
    let changed = false;
    const normalized = reports.map((r) => {
      const canonical = getCanonicalCreatedAt(r);
      if (r.createdAt !== canonical) changed = true;
      return { ...r, createdAt: canonical };
    });
    if (changed) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized.slice(-MAX_REPORTS)));
    }
    return normalized;
  } catch (error) {
    console.warn("[reportStorage] failed to load", error);
    return [];
  }
}

export function saveReport(record: GolfAnalysisResponse): void {
  if (typeof window === "undefined") return;
  try {
    const existing = loadStoredReports();
    const filtered = existing.filter((item) => item.analysisId !== record.analysisId);
    const normalized: GolfAnalysisResponse = { ...record, createdAt: getCanonicalCreatedAt(record) };
    filtered.push(normalized);
    // Keep chronological order by createdAt so that fetching an old report later doesn't become "latest".
    filtered.sort((a, b) => {
      const at = typeof a.createdAt === "number" && Number.isFinite(a.createdAt) ? a.createdAt : 0;
      const bt = typeof b.createdAt === "number" && Number.isFinite(b.createdAt) ? b.createdAt : 0;
      if (at !== bt) return at - bt;
      return String(a.analysisId).localeCompare(String(b.analysisId));
    });
    const trimmed = filtered.slice(-MAX_REPORTS);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (error) {
    console.warn("[reportStorage] failed to save", error);
  }
}

export function getLatestReport(): GolfAnalysisResponse | null {
  const reports = loadStoredReports();
  if (reports.length === 0) return null;
  let best: GolfAnalysisResponse | null = null;
  let bestAt = -Infinity;
  for (const r of reports) {
    const t = typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : -Infinity;
    if (t >= bestAt) {
      bestAt = t;
      best = r;
    }
  }
  return best;
}

export function getReportById(analysisId: string): GolfAnalysisResponse | null {
  if (!analysisId) return null;
  const reports = loadStoredReports();
  return reports.find((r) => r.analysisId === analysisId) ?? null;
}

export function getMostRecentReportWithSequence(): GolfAnalysisResponse | null {
  const reports = loadStoredReports();
  if (!reports.length) return null;
  let bestWithSeq: GolfAnalysisResponse | null = null;
  let bestWithSeqAt = -Infinity;
  for (const r of reports) {
    if (!r.result?.sequence?.frames?.length) continue;
    const t = typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : -Infinity;
    if (t >= bestWithSeqAt) {
      bestWithSeqAt = t;
      bestWithSeq = r;
    }
  }
  return bestWithSeq ?? getLatestReport();
}
