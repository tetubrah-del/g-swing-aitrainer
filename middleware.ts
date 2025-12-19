import { NextRequest, NextResponse } from "next/server";

function unauthorized() {
  return new NextResponse("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Secure Area", charset="UTF-8"',
    },
  });
}

function decodeBase64(input: string) {
  if (typeof atob === "function") return atob(input);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (typeof Buffer !== "undefined") return Buffer.from(input, "base64").toString("utf8");
  return "";
}

export function middleware(req: NextRequest) {
  const enabled = (process.env.BASIC_AUTH_ENABLED ?? "true") !== "false";
  if (!enabled) return NextResponse.next();

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Basic ")) return unauthorized();

  const base64Credentials = authHeader.slice("Basic ".length).trim();
  const decoded = decodeBase64(base64Credentials);
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex < 0) return unauthorized();

  const user = decoded.slice(0, separatorIndex);
  const pass = decoded.slice(separatorIndex + 1);

  const expectedUser = process.env.BASIC_AUTH_USER ?? "";
  const expectedPass = process.env.BASIC_AUTH_PASS ?? "";
  if (!expectedUser || !expectedPass) return unauthorized();

  if (user !== expectedUser || pass !== expectedPass) return unauthorized();
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};

