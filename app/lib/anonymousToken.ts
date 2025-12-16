import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "anonymous_token";
const ALGO = "sha256";
const TOKEN_VERSION = "v1";
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 180; // 180 days

const getSecret = (): string => {
  const secret = process.env.ANONYMOUS_TOKEN_SECRET;
  if (!secret) {
    throw new Error("ANONYMOUS_TOKEN_SECRET is required");
  }
  return secret;
};

export type AnonymousTokenPayload = {
  anonymousUserId: string;
  exp: number;
  v: string;
};

export const signAnonymousToken = (payload: Omit<AnonymousTokenPayload, "v">): string => {
  const secret = getSecret();
  const normalized: AnonymousTokenPayload = {
    ...payload,
    v: TOKEN_VERSION,
  };
  const body = JSON.stringify(normalized);
  const hmac = crypto.createHmac(ALGO, secret).update(body).digest("hex");
  return Buffer.from(`${body}.${hmac}`).toString("base64url");
};

export const verifyAnonymousToken = (token: string | null | undefined): AnonymousTokenPayload | null => {
  if (!token) return null;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const [body, signature] = decoded.split(".");
    if (!body || !signature) return null;
    const secret = getSecret();
    const expected = crypto.createHmac(ALGO, secret).update(body).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const parsed = JSON.parse(body) as AnonymousTokenPayload;
    if (parsed.v !== TOKEN_VERSION) return null;
    if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    if (typeof parsed.anonymousUserId !== "string" || !parsed.anonymousUserId) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const issueAnonymousTokenCookie = (anonymousUserId: string, ttlMs: number = DEFAULT_TTL_MS) => {
  const exp = Date.now() + Math.max(ttlMs, 60_000);
  const token = signAnonymousToken({ anonymousUserId, exp });
  cookies().set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(ttlMs / 1000),
  });
  return token;
};

export const readAnonymousFromRequest = (req: NextRequest): { anonymousUserId: string | null; token: string | null } => {
  const cookie = req.cookies.get(COOKIE_NAME)?.value ?? null;
  const headerToken = req.headers.get("x-anonymous-token");
  const token = headerToken || cookie || null;
  const verified = verifyAnonymousToken(token);
  return { anonymousUserId: verified?.anonymousUserId ?? null, token };
};

export const setAnonymousTokenOnResponse = (res: NextResponse, anonymousUserId: string, ttlMs: number = DEFAULT_TTL_MS) => {
  const exp = Date.now() + Math.max(ttlMs, 60_000);
  const token = signAnonymousToken({ anonymousUserId, exp });
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(ttlMs / 1000),
  });
  return token;
};
