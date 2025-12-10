// ▼ Next.js を Edge Runtime にさせない（絶対必要）
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { NextResponse } from "next/server";

// Turbopack が dynamic import を誤爆しないよう require() を使用
let ffmpeg: any = null;
let ffmpegStatic: string | null = null;

let ffmpegLoading = false;

function loadFfmpeg() {
  if (ffmpeg || ffmpegLoading) return;
  ffmpegLoading = true;

  // require を使うと Turbopack は server-only と理解する
  const ff = require("fluent-ffmpeg");
  const ffStatic = require("ffmpeg-static");

  ffmpeg = ff;
  ffmpegStatic = ffStatic;

  if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
  }

  ffmpegLoading = false;
}

const FRAME_POSITIONS = {
  address: 0,
  backswing: 0.05,
  top: 0.45,
  downswing: 0.6,
  impact: 0.68,
  finish: 0.9,
} as const;

type FrameKey = keyof typeof FRAME_POSITIONS;

type ExtractedFrame = {
  timestamp: number;
  imageBase64: string;
};

// 並列実行（FFmpeg 用）を制限
async function pLimit<T>(tasks: (() => Promise<T>)[], limit = 2): Promise<T[]> {
  const results: T[] = [];
  let i = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = i++;
      if (idx >= tasks.length) break;
      try {
        results[idx] = await tasks[idx]();
      } catch (err) {
        throw err; // fail-fast（部分成功を許さない）
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, () => worker())
  );

  return results;
}

// Duration を ffprobe で取得
async function getVideoDuration(inputPath: string): Promise<number> {
  loadFfmpeg();
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err: any, data: any) => {
      if (err) {
        return reject(new Error(`ffprobe failed: ${err.message || err}`));
      }
      const duration = data?.format?.duration;
      if (!duration || duration <= 0) {
        return reject(new Error("Invalid or missing duration"));
      }
      resolve(duration);
    });
  });
}

// 指定時刻のフレーム抽出
async function extractFrameAtTimestamp(
  inputPath: string,
  outputPath: string,
  ts: number
): Promise<void> {
  loadFfmpeg();
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .seekInput(ts)
      .outputOptions(["-frames:v 1", "-q:v 2"])
      .save(outputPath)
      .on("end", resolve)
      .on("error", async (err: any) => {
        // エラー時も確実に削除
        await fs.rm(outputPath, { force: true });
        reject(new Error(`FFmpeg failed: ${err?.message || err}`));
      });
  });
}

// 6 フェーズ抽出
async function buildFrameResponse(
  inputPath: string
): Promise<Record<FrameKey, ExtractedFrame>> {
  const duration = await getVideoDuration(inputPath);

  const results: Partial<Record<FrameKey, ExtractedFrame>> = {};

  const tasks = (Object.entries(FRAME_POSITIONS) as [FrameKey, number][]).map(
    ([phase, ratio]) => async () => {
      const ts = Math.min(duration * ratio, duration - 0.001); // 短い動画対策
      const out = path.join("/tmp", `frame-${phase}-${crypto.randomUUID()}.jpg`);

      await extractFrameAtTimestamp(inputPath, out, ts);

      const buffer = await fs.readFile(out);
      results[phase] = {
        timestamp: ts,
        imageBase64: `data:image/jpeg;base64,${buffer.toString("base64")}`,
      };

      await fs.rm(out, { force: true });
    }
  );

  await pLimit(tasks, 2).catch((err) => {
    throw new Error(`Frame extraction aborted: ${err.message}`);
  });

  return results as Record<FrameKey, ExtractedFrame>;
}

// POST handler
export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer()); // 全量読み取り
    const ext = path.extname(file.name || "") || ".mp4";
    const inputPath = path.join("/tmp", `upload-${crypto.randomUUID()}${ext}`);

    await fs.writeFile(inputPath, buffer);

    const frames = await buildFrameResponse(inputPath);

    await fs.rm(inputPath, { force: true });

    return NextResponse.json({ frames });
  } catch (err: any) {
    console.error("[extract] Error:", err);
    return NextResponse.json(
      { error: "Failed to extract frames", detail: err?.message },
      { status: 500 }
    );
  }
}
