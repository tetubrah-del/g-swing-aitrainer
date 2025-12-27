import { notFound } from "next/navigation";
import { getServerAuthContext } from "@/app/lib/serverAccount";
import { isAdminEmail } from "@/app/lib/admin";
import { getUserById } from "@/app/lib/userStore";
import { getMonitorPerformance, getReferralCodeForUser, getUserPaymentSummary, listCouponGrants } from "@/app/lib/referralTracking";
import { listAnalyses } from "@/app/lib/store";
import AdminUserDetailPageClient from "./pageClient";

export const runtime = "nodejs";

function isValidUserId(id: string | null | undefined): id is string {
  if (!id) return false;
  return /^[A-Za-z0-9_-]{6,200}$/.test(id);
}

export default async function AdminUserDetailPage(props: { params: Promise<{ userId: string }> }) {
  const ctx = await getServerAuthContext();
  if (!isAdminEmail(ctx.email)) notFound();

  const { userId } = await props.params;
  if (!isValidUserId(userId)) notFound();

  const user = await getUserById(userId);
  if (!user) notFound();

  const referralCode = getReferralCodeForUser(userId);
  const monitorPerformance = getMonitorPerformance({ userId });
  const payment = getUserPaymentSummary(userId);
  const coupons = listCouponGrants(userId);

  let inferredLastAnalysisAt: number | null = null;
  if (!user.lastAnalysisAt) {
    const latest = await listAnalyses({ userId }, { limit: 1, order: "desc" });
    inferredLastAnalysisAt = typeof latest[0]?.createdAt === "number" ? latest[0]!.createdAt : null;
  }

  return (
    <AdminUserDetailPageClient
      user={{
        ...user,
        lastAnalysisAt: user.lastAnalysisAt ?? inferredLastAnalysisAt ?? null,
      }}
      referralCode={referralCode}
      monitorPerformance={monitorPerformance}
      payment={payment}
      coupons={coupons}
    />
  );
}
