export type CoachConfidenceLevel = "high" | "medium" | "low";

export type CoachCausalImpactExplanation = {
  analysisId?: string;
  primaryFactor: string;
  chain: string[];
  confidence: number; // 0-1
  nextAction: string;
  summary?: string;
  swingTypeHeadline?: string | null;
  analyzedAt?: string | null;
};

export type CoachThread = {
  threadId: string;
  userId: string;
  status: "active" | "archived";
  createdAt: string;
  lastAnalysisId?: string;
};

export type CoachMessageRole = "system" | "assistant" | "user";

export type CoachMessage = {
  threadId: string;
  role: CoachMessageRole;
  content: string;
  createdAt: string;
  analysisId?: string;
};

export type ThreadSummary = {
  threadId: string;
  summaryText: string;
  updatedAt: string;
};

export type CoachQuickReply = {
  key: string;
  label: string;
  value: string;
};

export type CoachChatRequest = {
  mode?: "initial" | "chat";
  systemPersona: string;
  detailMode?: boolean;
  visionFrames?: Array<{ url: string; timestampSec?: number; label?: string; frameIndex?: number }>;
  userProfileSummary?: string;
  analysisContext?: CoachCausalImpactExplanation | null;
  summaryText?: string | null;
  recentMessages?: CoachMessage[];
  userMessage?: string;
};
