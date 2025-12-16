import { NextRequest, NextResponse } from "next/server";
import { listAnalyses } from "@/app/lib/store";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const anonymousUserId = searchParams.get("anonymousUserId") || req.headers.get("x-anonymous-id");
  const userId = searchParams.get("userId") || req.headers.get("x-user-id");

  if (!anonymousUserId && !userId) {
    return NextResponse.json({ error: "user not specified" }, { status: 400 });
  }

  const records = await listAnalyses(
    { userId: userId ?? undefined, anonymousUserId: anonymousUserId ?? undefined },
    { limit: 50, order: "desc" }
  );

  const items = records.map((record) => ({
    id: record.id,
    createdAt: record.createdAt,
    score: record.result?.totalScore ?? null,
    club: record.meta?.clubType ?? null,
    level: record.meta?.level ?? null,
  }));

  const access = userId ? "member" : "anonymous";

  return NextResponse.json({ items, access });
}
