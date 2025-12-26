import { notFound } from "next/navigation";
import AccountMonitorPageClient from "./pageClient";
import { getServerAuthContext } from "@/app/lib/serverAccount";
import { getUserById } from "@/app/lib/userStore";
import { buildUserUsageState } from "@/app/lib/membership";

export const runtime = "nodejs";

export default async function AccountMonitorPage() {
  const ctx = await getServerAuthContext();
  if (!ctx.accountUserId) notFound();

  const account = await getUserById(ctx.accountUserId);
  const userState = await buildUserUsageState({ user: account, anonymousUserId: ctx.anonymousUserId });
  if (userState.isMonitor !== true) notFound();

  return <AccountMonitorPageClient />;
}

