import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { readActiveAuthFromRequest } from "@/app/lib/activeAuth";
import { readEmailSessionFromRequest } from "@/app/lib/emailSession";
import { findUserByEmail, getUserById } from "@/app/lib/userStore";

export async function resolveBillingAccount(request: NextRequest) {
  const emailSession = readEmailSessionFromRequest(request);
  const activeAuth = readActiveAuthFromRequest(request) ?? (emailSession ? "email" : null);

  if (activeAuth !== "email") {
    const session = await auth();
    const sessionUserId = session?.user?.id ?? null;
    const sessionEmail = session?.user?.email ?? null;

    if (sessionUserId) {
      const byId = await getUserById(sessionUserId);
      if (byId) return byId;
    }
    if (sessionEmail) {
      const byEmail = await findUserByEmail(sessionEmail);
      if (byEmail) return byEmail;
    }
  }

  if (activeAuth !== "google" && emailSession) {
    const byId = await getUserById(emailSession.userId);
    if (
      byId &&
      byId.authProvider === "email" &&
      byId.emailVerifiedAt != null &&
      typeof byId.email === "string" &&
      byId.email.toLowerCase() === emailSession.email.toLowerCase()
    ) {
      return byId;
    }
    const byEmail = await findUserByEmail(emailSession.email);
    if (byEmail && byEmail.authProvider === "email" && byEmail.emailVerifiedAt != null) {
      return byEmail;
    }
  }

  return null;
}

