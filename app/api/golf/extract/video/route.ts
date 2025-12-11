export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";

// ffmpeg 実体
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ffmpeg: any = null;
let ffmpegPath: string | null = null;

function loadFFmpeg() {
  if (ffmpeg) return;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ffmpeg = require("fluent-ffmpeg");

  ffmpegPath = execSync("which ffmpeg").toString().trim();
  if (!ffmpegPath) throw new Error("FFmpeg not found");

  ffmpeg.setFfmpegPath(ffmpegPath);
}

const FPS = 15;

export async function POST(req: Request) {
  try {
    loadFFmpeg();

    const formData = await req.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const ext = path.extname(file.name || "") || ".mp4";

    const inputPath = path.join("/tmp", `upload-${crypto.randomUUID()}${ext}`);
    await fs.writeFile(inputPath, buf);

    const outDir = path.join("/tmp", `frames-${crypto.randomUUID()}`);
    await fs.mkdir(outDir, { recursive: true });

    // ffmpeg -i input -vf fps=15 out-%04d.jpg
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([`-vf fps=${FPS}`])
        .save(path.join(outDir, "frame-%04d.jpg"))
        .on("end", resolve)
        .on("error", reject);
    });

    const jpgs = (await fs.readdir(outDir))
      .filter((f) => f.endsWith(".jpg"))
      .sort();

    const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL || new URL(req.url).origin).replace(/\/$/, "");

    const frames = jpgs.map((f) => ({
      url: `${baseUrl}/api/golf/extract/file?id=${f}&dir=${path.basename(outDir)}`,
    }));

    return NextResponse.json({ frames });
  } catch (err) {
    console.error("[video extract]", err);
    return NextResponse.json(
      { error: "frame extraction failed", detail: (err as Error)?.message },
      { status: 500 }
    );
  }
}
