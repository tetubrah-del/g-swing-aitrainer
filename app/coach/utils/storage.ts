import { CoachCausalImpactExplanation, CoachMessage, CoachThread, ThreadSummary } from "@/app/coach/types";

const THREAD_KEY = (userId: string) => `coach_active_thread_${userId}`;
const THREAD_STORE_KEY = "coach_threads";
const MESSAGE_KEY = (threadId: string) => `coach_messages_${threadId}`;
const SUMMARY_KEY = (threadId: string) => `coach_summary_${threadId}`;
const CONTEXT_KEY = (threadId: string) => `coach_context_${threadId}`;
const BOOTSTRAP_KEY = (userId: string) => `coach_bootstrap_${userId}`;
const QUICK_REPLY_KEY = (threadId: string) => `coach_quickreply_${threadId}`;
const CONTEXT_DISABLED_KEY = (threadId: string) => `coach_context_disabled_${threadId}`;
const DETAIL_MODE_KEY = (threadId: string) => `coach_detail_mode_${threadId}`;
const VISION_MODE_KEY = (threadId: string) => `coach_vision_mode_${threadId}`;

const MAX_MESSAGES = 200;

const isCoachMessage = (value: unknown): value is CoachMessage => {
  if (!value || typeof value !== "object") return false;
  const msg = value as Partial<CoachMessage>;
  return (
    typeof msg.threadId === "string" &&
    (msg.role === "assistant" || msg.role === "user" || msg.role === "system") &&
    typeof msg.content === "string" &&
    typeof msg.createdAt === "string"
  );
};

const safeParse = <T>(value: string | null): T | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

const saveJson = (key: string, value: unknown) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
};

export const getOrCreateActiveThread = (userId: string, analysisId?: string): CoachThread | null => {
  if (!userId || typeof window === "undefined") return null;
  try {
    const activeId = window.localStorage.getItem(THREAD_KEY(userId));
    const allThreads = safeParse<Record<string, CoachThread>>(window.localStorage.getItem(THREAD_STORE_KEY)) || {};

    if (activeId && allThreads[activeId]) {
      return allThreads[activeId];
    }

    const thread: CoachThread = {
      threadId: crypto.randomUUID(),
      userId,
      status: "active",
      createdAt: new Date().toISOString(),
      lastAnalysisId: analysisId,
    };
    allThreads[thread.threadId] = thread;
    window.localStorage.setItem(THREAD_KEY(userId), thread.threadId);
    saveJson(THREAD_STORE_KEY, allThreads);
    return thread;
  } catch {
    return null;
  }
};

export const updateThreadMetadata = (thread: CoachThread | null, params: Partial<CoachThread>): CoachThread | null => {
  if (!thread || typeof window === "undefined") return thread;
  try {
    const store = safeParse<Record<string, CoachThread>>(window.localStorage.getItem(THREAD_STORE_KEY)) || {};
    const next: CoachThread = { ...thread, ...params };
    store[thread.threadId] = next;
    saveJson(THREAD_STORE_KEY, store);
    return next;
  } catch {
    return thread;
  }
};

export const loadMessages = (threadId: string | null): CoachMessage[] => {
  if (!threadId || typeof window === "undefined") return [];
  const parsed = safeParse<CoachMessage[]>(window.localStorage.getItem(MESSAGE_KEY(threadId))) || [];
  const sorted = parsed
    .filter(isCoachMessage)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  // 連続重複の除去（role + content + analysisId で判定）
  const seen = new Set<string>();
  const deduped: CoachMessage[] = [];
  sorted.forEach((msg) => {
    const key = `${msg.role}-${msg.analysisId ?? ""}-${msg.content}`;
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(msg);
  });

  if (deduped.length !== sorted.length) {
    saveJson(MESSAGE_KEY(threadId), deduped);
  }

  return deduped;
};

export const appendMessages = (threadId: string | null, messages: CoachMessage[]): CoachMessage[] => {
  if (!threadId || typeof window === "undefined") return [];
  const existing = loadMessages(threadId);
  const merged = [...existing, ...messages].slice(-MAX_MESSAGES);
  saveJson(MESSAGE_KEY(threadId), merged);
  return merged;
};

export const saveThreadSummary = (summary: ThreadSummary | null) => {
  if (!summary || typeof window === "undefined") return;
  saveJson(SUMMARY_KEY(summary.threadId), summary);
};

export const loadThreadSummary = (threadId: string | null): ThreadSummary | null => {
  if (!threadId || typeof window === "undefined") return null;
  return safeParse<ThreadSummary>(window.localStorage.getItem(SUMMARY_KEY(threadId)));
};

export const saveCausalContext = (threadId: string | null, context: CoachCausalImpactExplanation) => {
  if (!threadId || typeof window === "undefined") return;
  saveJson(CONTEXT_KEY(threadId), context);
};

export const loadCausalContext = (threadId: string | null): CoachCausalImpactExplanation | null => {
  if (!threadId || typeof window === "undefined") return null;
  return safeParse<CoachCausalImpactExplanation>(window.localStorage.getItem(CONTEXT_KEY(threadId)));
};

export const clearCausalContext = (threadId: string | null) => {
  if (!threadId || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CONTEXT_KEY(threadId));
  } catch {
    // ignore
  }
};

export const saveBootstrapContext = (userId: string, context: CoachCausalImpactExplanation) => {
  if (!userId || typeof window === "undefined") return;
  // Backward/forward compatible keys:
  // - Older code used raw anonymous id (e.g. "abc123").
  // - Newer code may use a prefixed identity key (e.g. "anon:abc123" / "user:xxx").
  saveJson(BOOTSTRAP_KEY(userId), context);
  if (userId.startsWith("anon:")) {
    const raw = userId.slice("anon:".length);
    if (raw) saveJson(BOOTSTRAP_KEY(raw), context);
  } else if (!userId.includes(":")) {
    saveJson(BOOTSTRAP_KEY(`anon:${userId}`), context);
  }
};

export const loadBootstrapContext = (userId: string): CoachCausalImpactExplanation | null => {
  if (!userId || typeof window === "undefined") return null;
  const direct = safeParse<CoachCausalImpactExplanation>(window.localStorage.getItem(BOOTSTRAP_KEY(userId)));
  if (direct) return direct;
  if (userId.startsWith("anon:")) {
    const raw = userId.slice("anon:".length);
    if (!raw) return null;
    return safeParse<CoachCausalImpactExplanation>(window.localStorage.getItem(BOOTSTRAP_KEY(raw)));
  }
  if (!userId.includes(":")) {
    return safeParse<CoachCausalImpactExplanation>(window.localStorage.getItem(BOOTSTRAP_KEY(`anon:${userId}`)));
  }
  return null;
};

export const clearBootstrapContext = (userId: string) => {
  if (!userId || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(BOOTSTRAP_KEY(userId));
    if (userId.startsWith("anon:")) {
      const raw = userId.slice("anon:".length);
      if (raw) window.localStorage.removeItem(BOOTSTRAP_KEY(raw));
    } else if (!userId.includes(":")) {
      window.localStorage.removeItem(BOOTSTRAP_KEY(`anon:${userId}`));
    }
  } catch {
    // ignore
  }
};

export const isContextDisabled = (threadId: string | null): boolean => {
  if (!threadId || typeof window === "undefined") return false;
  const parsed = safeParse<{ disabled?: boolean }>(window.localStorage.getItem(CONTEXT_DISABLED_KEY(threadId)));
  return !!parsed?.disabled;
};

export const setContextDisabled = (threadId: string | null, disabled: boolean) => {
  if (!threadId || typeof window === "undefined") return;
  saveJson(CONTEXT_DISABLED_KEY(threadId), { disabled });
};

export const markQuickRepliesDismissed = (threadId: string | null) => {
  if (!threadId || typeof window === "undefined") return;
  saveJson(QUICK_REPLY_KEY(threadId), { dismissed: true });
};

export const hasDismissedQuickReplies = (threadId: string | null): boolean => {
  if (!threadId || typeof window === "undefined") return false;
  const parsed = safeParse<{ dismissed?: boolean }>(window.localStorage.getItem(QUICK_REPLY_KEY(threadId)));
  return !!parsed?.dismissed;
};

export const loadDetailMode = (threadId: string | null): boolean => {
  if (!threadId || typeof window === "undefined") return false;
  const parsed = safeParse<{ enabled?: boolean }>(window.localStorage.getItem(DETAIL_MODE_KEY(threadId)));
  return !!parsed?.enabled;
};

export const saveDetailMode = (threadId: string | null, enabled: boolean) => {
  if (!threadId || typeof window === "undefined") return;
  saveJson(DETAIL_MODE_KEY(threadId), { enabled });
};

export const loadVisionMode = (threadId: string | null): boolean => {
  if (!threadId || typeof window === "undefined") return false;
  const parsed = safeParse<{ enabled?: boolean }>(window.localStorage.getItem(VISION_MODE_KEY(threadId)));
  return !!parsed?.enabled;
};

export const saveVisionMode = (threadId: string | null, enabled: boolean) => {
  if (!threadId || typeof window === "undefined") return;
  saveJson(VISION_MODE_KEY(threadId), { enabled });
};
