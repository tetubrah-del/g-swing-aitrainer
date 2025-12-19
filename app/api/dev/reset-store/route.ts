import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { resetAnalysisStore } from "@/app/lib/store";
import { resetUserStore } from "@/app/lib/userStore";
import { resetEmailVerificationStore } from "@/app/lib/emailVerificationStore";
import { resetAnonymousQuotaStore } from "@/app/lib/quotaStore";

const safeUnlink = async (p: string) => {
  try {
    await fs.unlink(p);
  } catch {
    // ignore
  }
};

export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const dir = os.tmpdir();
  await Promise.all([
    safeUnlink(path.join(dir, "golf-users.json")),
    safeUnlink(path.join(dir, "golf-analyses.json")),
    safeUnlink(path.join(dir, "golf-email-verification.json")),
    safeUnlink(path.join(dir, "golf-anonymous-quota.json")),
  ]);

  // Also clear in-memory stores so a server restart isn't required.
  await Promise.all([resetUserStore(), resetAnalysisStore(), resetEmailVerificationStore(), resetAnonymousQuotaStore()]);

  return NextResponse.json({ ok: true });
}
