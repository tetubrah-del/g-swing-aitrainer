export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";

let ffmpeg: any = null;
let ffmpegPath: string | null = null;

function loadFfmpeg() {
  if (ffmpeg) return;
  ffmpeg = require("fluent-ffmpeg");
  try {
    ffmpegPath = execSync("which ffmpeg").toString().trim();
    ffmpeg.setFfmpegPath(ffmpegPath);
  } catch (err) {
    console.error("ffmpeg not found");
    throw err;
  }
}

// 15fps サンプリング
const FPS = 15;

export async function POST(req: Request) {
  try {
    loadFfmpeg();

    const formData = await req.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const ext = path.extname(file.name || "") || ".mp4";
    const inputPath = path.join("/tmp", `upload-${crypto.randomUUID()}${ext}`);

    await fs.writeFile(inputPath, buf);

    // 出力先
    const outDir = path.join("/tmp", `samples-${crypto.randomUUID()}`);
    await fs.mkdir(outDir, { recursive: true });

    // ffmpeg -i video.mp4 -vf fps=15 out-%04d.jpg
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([`-vf fps=${FPS}`])
        .save(path.join(outDir, "frame-%04d.jpg"))
        .on("end", resolve)
        .on("error", reject);
    });

    const files = (await fs.readdir(outDir))
      .filter((f) => f.endsWith(".jpg"))
      .sort();

    const frames = [];

    for (const f of files) {
      const full = path.join(outDir, f);
      const buffer = await fs.readFile(full);
      frames.push({
        imageBase64: `data:image/jpeg;base64,${buffer.toString("base64")}`,
      });
    }

    // cleanup
    await fs.rm(inputPath, { force: true });
    await fs.rm(outDir, { recursive: true, force: true });

    return NextResponse.json({ frames });
  } catch (err: any) {
    console.error("[sample extract]", err);
    return NextResponse.json(
      { error: "sample extraction failed", detail: err?.message },
      { status: 500 }
    );
  }
}
