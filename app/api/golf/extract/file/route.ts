export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import fs from "fs/promises";
import path from "path";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const dir = searchParams.get("dir");

  if (!id || !dir) {
    return new Response("Missing id or dir", { status: 400 });
  }

  // ▼ セキュリティ強化：ディレクトリトラバーサル防止
  const safeDir = path.basename(dir);
  const safeId = path.basename(id);

  const fullPath = path.join("/tmp", safeDir, safeId);

  try {
    const buf = await fs.readFile(fullPath);
    return new Response(buf, { headers: { "Content-Type": "image/jpeg" } });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}
