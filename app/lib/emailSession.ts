import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "email_session";
const TOKEN_VERSION = "v1";
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

type EmailSessionPayload = {
  v: typeof TOKEN_VERSION;
  userId: string;
  email: string;
  exp: number;
};

const getSecret = (): string => {
  const secret = process.env.EMAIL_SESSION_SECRET ?? process.env.NEXTAUTH_SECRET ?? "dev-email-session-secret";
  if (!process.env.EMAIL_SESSION_SECRET && !process.env.NEXTAUTH_SECRET) {
    console.warn("[email-session] Using fallback dev secret; set EMAIL_SESSION_SECRET in production.");
  }
  return secret;
};

const b64u = (buf: Buffer): string => buf.toString("base64url");

const sign = (body: string): string => {
  const sig = crypto.createHmac("sha256", getSecret()).update(body).digest();
  return b64u(sig);
};

export const signEmailSession = (payload: Omit<EmailSessionPayload, "v">): string => {
  const normalized: EmailSessionPayload = { ...payload, v: TOKEN_VERSION };
  const body = JSON.stringify(normalized);
  const token = `${b64u(Buffer.from(body, "utf8"))}.${sign(body)}`;
  return token;
};

export const verifyEmailSession = (token: string | null | undefined): EmailSessionPayload | null => {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const body = Buffer.from(parts[0], "base64url").toString("utf8");
    const expected = sign(body);
    const a = Buffer.from(parts[1], "base64url");
    const b = Buffer.from(expected, "base64url");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(body) as EmailSessionPayload;
    if (parsed.v !== TOKEN_VERSION) return null;
    if (typeof parsed.exp !== "number" || Date.now() > parsed.exp) return null;
    if (typeof parsed.userId !== "string" || typeof parsed.email !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
};

export const issueEmailSessionCookie = (params: { userId: string; email: string; ttlMs?: number }) => {
  const exp = Date.now() + (params.ttlMs ?? DEFAULT_TTL_MS);
  const token = signEmailSession({ userId: params.userId, email: params.email, exp });
  cookies().set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor((params.ttlMs ?? DEFAULT_TTL_MS) / 1000),
  });
  return token;
};

export const setEmailSessionOnResponse = (
  res: NextResponse,
  params: { userId: string; email: string; ttlMs?: number },
) => {
  const exp = Date.now() + (params.ttlMs ?? DEFAULT_TTL_MS);
  const token = signEmailSession({ userId: params.userId, email: params.email, exp });
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor((params.ttlMs ?? DEFAULT_TTL_MS) / 1000),
  });
  return token;
};

export const clearEmailSessionOnResponse = (res: NextResponse) => {
  res.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
};

export const readEmailSessionFromRequest = (req: NextRequest): EmailSessionPayload | null => {
  const headerToken = req.headers.get("x-email-session");
  const cookieToken = req.cookies.get(COOKIE_NAME)?.value;
  const token = headerToken || cookieToken || null;
  return verifyEmailSession(token);
};

