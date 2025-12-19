import { NextRequest, NextResponse } from "next/server";
import { ActiveAuth, setActiveAuthOnResponse } from "@/app/lib/activeAuth";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { provider?: string };
  const provider = body?.provider;
  if (provider !== "google" && provider !== "email") {
    return NextResponse.json({ error: "invalid provider" }, { status: 400 });
  }
  const res = NextResponse.json({ ok: true });
  setActiveAuthOnResponse(res, provider as ActiveAuth);
  return res;
}

