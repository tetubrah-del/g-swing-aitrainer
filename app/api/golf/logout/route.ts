import { NextResponse } from "next/server";
import { clearEmailSessionOnResponse } from "@/app/lib/emailSession";
import { clearActiveAuthOnResponse } from "@/app/lib/activeAuth";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  clearEmailSessionOnResponse(res);
  clearActiveAuthOnResponse(res);
  return res;
}
