import { SwingAnalysisHistory } from "@/app/golf/types";

const STORAGE_KEY = "swing_analysis_histories";
const USER_ID_KEY = "anonymous_user_id";
const MAX_HISTORIES = 20;

const toTime = (value: string): number => {
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
};

const isSwingAnalysisHistory = (value: unknown): value is SwingAnalysisHistory => {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SwingAnalysisHistory>;
  return (
    typeof record.analysisId === "string" &&
    typeof record.userId === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.swingScore === "number" &&
    typeof record.estimatedOnCourseScore === "string" &&
    typeof record.swingType === "string" &&
    typeof record.priorityIssue === "string" &&
    typeof record.nextAction === "string"
  );
};

const loadAllHistories = (): SwingAnalysisHistory[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSwingAnalysisHistory);
  } catch (error) {
    console.warn("[historyStorage] failed to load", error);
    return [];
  }
};

export const getAnonymousUserId = (): string => {
  if (typeof window === "undefined") return "";
  try {
    let id = window.localStorage.getItem(USER_ID_KEY);
    if (!id || typeof id !== "string") {
      id = crypto.randomUUID();
      window.localStorage.setItem(USER_ID_KEY, id);
    }
    return id;
  } catch (error) {
    console.warn("[historyStorage] failed to resolve anonymous user id", error);
    return "";
  }
};

export const saveSwingHistory = (history: SwingAnalysisHistory): void => {
  if (typeof window === "undefined") return;
  try {
    const all = loadAllHistories();
    const others = all.filter((item) => item.userId !== history.userId);
    const existing = all.filter((item) => item.userId === history.userId);
    const deduped = existing.filter((item) => item.analysisId !== history.analysisId);
    const next = [history, ...deduped].slice(0, MAX_HISTORIES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next, ...others]));
  } catch (error) {
    console.warn("[historyStorage] failed to save", error);
  }
};

export const getSwingHistories = (userId: string): SwingAnalysisHistory[] => {
  if (typeof window === "undefined" || !userId) return [];
  const histories = loadAllHistories().filter((item) => item.userId === userId);
  return histories.sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt));
};
