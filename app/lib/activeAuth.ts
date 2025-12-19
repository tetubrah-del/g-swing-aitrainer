import { NextRequest, NextResponse } from "next/server";

export type ActiveAuth = "google" | "email";

const COOKIE_NAME = "active_auth";

export const readActiveAuthFromRequest = (req: NextRequest): ActiveAuth | null => {
  const raw = req.cookies.get(COOKIE_NAME)?.value ?? null;
  if (raw === "google" || raw === "email") return raw;
  return null;
};

export const setActiveAuthOnResponse = (res: NextResponse, auth: ActiveAuth) => {
  res.cookies.set(COOKIE_NAME, auth, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
};

export const clearActiveAuthOnResponse = (res: NextResponse) => {
  res.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
};

