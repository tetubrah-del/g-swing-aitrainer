import type { UserUsageState } from "@/app/golf/types";

type Plan = NonNullable<UserUsageState["plan"]>;

const PLAN_LABELS: Record<Plan, string> = {
  anonymous: "体験版",
  free: "メール会員",
  pro: "PRO",
};

export function formatPlanLabel(plan: UserUsageState["plan"] | null | undefined): string {
  if (!plan) return "-";
  return PLAN_LABELS[plan] ?? String(plan);
}

