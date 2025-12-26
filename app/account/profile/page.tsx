import { notFound } from "next/navigation";
import AccountProfilePageClient from "./pageClient";
import { getServerAuthContext } from "@/app/lib/serverAccount";

export const runtime = "nodejs";

export default async function AccountProfilePage() {
  const ctx = await getServerAuthContext();
  if (!ctx.accountUserId) notFound();
  return <AccountProfilePageClient />;
}

