export type UserPlan = 'anonymous' | 'free' | 'pro';

export type UserAction =
  | 'analyze_swing'
  | 'unlimited_analysis'
  | 'view_history_list'
  | 'view_history_graph'
  | 'use_ai_coach';

export interface User {
  id: string;
  plan: UserPlan;
  email: string | null;
  isMonitor: boolean;
  monitorExpiresAt?: Date | null; // 有効期限必須（null/undefined は無効）
  freeAnalysisCount: number;
  freeAnalysisResetAt: Date;
  createdAt?: Date;
}
