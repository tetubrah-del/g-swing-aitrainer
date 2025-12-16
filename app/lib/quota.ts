import { User } from "@/types/user";
import { canPerform } from "./permissions";

export type AnalyzePermission =
  | { allowed: true }
  | { allowed: false; reason: "anonymous_limit" | "free_limit" };

export function canAnalyzeNow(user: User): AnalyzePermission {
  if (canPerform(user, "unlimited_analysis")) {
    return { allowed: true };
  }

  const used = user.freeAnalysisCount ?? 0;

  if (user.email === null) {
    return used < 1 ? { allowed: true } : { allowed: false, reason: "anonymous_limit" };
  }

  if (user.plan === "free") {
    return used < 3 ? { allowed: true } : { allowed: false, reason: "free_limit" };
  }

  return { allowed: true };
}
