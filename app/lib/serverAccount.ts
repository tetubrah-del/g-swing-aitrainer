import { cookies } from "next/headers";
import { auth } from "@/auth";
import { verifyEmailSession } from "@/app/lib/emailSession";
import { verifyAnonymousToken } from "@/app/lib/anonymousToken";
import { findUserByEmail, getUserById, isUserDisabled } from "@/app/lib/userStore";

export async function getServerAuthContext(): Promise<{
  accountUserId: string | null;
  email: string | null;
  anonymousUserId: string | null;
}> {
  const jar = await cookies();
  const activeAuthRaw = jar.get("active_auth")?.value ?? null;
  const activeAuth = activeAuthRaw === "google" || activeAuthRaw === "email" ? activeAuthRaw : null;

  const anonymousToken = jar.get("anonymous_token")?.value ?? null;
  const anonymousUserId = verifyAnonymousToken(anonymousToken)?.anonymousUserId ?? null;

  const emailSessionToken = jar.get("email_session")?.value ?? null;
  const emailSession = verifyEmailSession(emailSessionToken);

  // If both Google and Email sessions exist but active_auth is missing, default to email to avoid cross-account mixing.
  const effectiveActiveAuth = activeAuth ?? (emailSession ? "email" : null);

  let accountUserId: string | null = null;
  let email: string | null = null;

  if (effectiveActiveAuth !== "email") {
    const session = await auth();
    const sessionUserId = session?.user?.id ?? null;
    const sessionEmail = session?.user?.email ?? null;
    if (sessionUserId) {
      const user = await getUserById(sessionUserId);
      if (user && !isUserDisabled(user)) {
        accountUserId = user.userId;
        email = user.email ?? sessionEmail ?? null;
      } else if (sessionEmail) {
        const byEmail = await findUserByEmail(sessionEmail);
        if (byEmail && !isUserDisabled(byEmail)) {
          accountUserId = byEmail.userId;
          email = byEmail.email ?? sessionEmail;
        }
      }
    } else if (sessionEmail) {
      const byEmail = await findUserByEmail(sessionEmail);
      if (byEmail && !isUserDisabled(byEmail)) {
        accountUserId = byEmail.userId;
        email = byEmail.email ?? sessionEmail;
      }
    }
  }

  if (!accountUserId && effectiveActiveAuth !== "google" && emailSession) {
    const byId = await getUserById(emailSession.userId);
    if (byId && byId.authProvider === "email" && !isUserDisabled(byId)) {
      accountUserId = byId.userId;
      email = byId.email ?? emailSession.email;
    }
  }

  return { accountUserId, email, anonymousUserId };
}
