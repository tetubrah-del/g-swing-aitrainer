import { GolfAnalysisResponse } from "@/app/golf/types";

const STORAGE_KEY = "golf_reports";
const MAX_REPORTS = 20;

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
    return parsed.filter(isGolfAnalysisResponse);
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
    filtered.push(record);
    const trimmed = filtered.slice(-MAX_REPORTS);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (error) {
    console.warn("[reportStorage] failed to save", error);
  }
}

export function getLatestReport(): GolfAnalysisResponse | null {
  const reports = loadStoredReports();
  if (reports.length === 0) return null;
  return reports[reports.length - 1] ?? null;
}

export function getReportById(analysisId: string): GolfAnalysisResponse | null {
  if (!analysisId) return null;
  const reports = loadStoredReports();
  return reports.find((r) => r.analysisId === analysisId) ?? null;
}

export function getMostRecentReportWithSequence(): GolfAnalysisResponse | null {
  const reports = loadStoredReports();
  if (!reports.length) return null;
  const withSeq = reports.filter((r) => r.result?.sequence?.frames?.length);
  if (withSeq.length) return withSeq[withSeq.length - 1];
  return reports[reports.length - 1] ?? null;
}
