import fs from 'fs/promises';
import path from 'path';
import { NextResponse } from 'next/server';
import crypto from 'crypto';

// ▼ dynamic import → Next.js が client にバンドルしないようにする
let ffmpeg: any = null;
let ffmpegStatic: string | null = null;

async function loadFfmpeg() {
  if (!ffmpeg) {
    const ff = await import('fluent-ffmpeg');
    const ffStatic = await import('ffmpeg-static');

    ffmpeg = ff.default || ff;
    ffmpegStatic = (ffStatic as any).default || ffStatic || null;
    if (ffmpegStatic) {
      ffmpeg.setFfmpegPath(ffmpegStatic);
    }
  }
}

export const runtime = 'nodejs';

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

// ffmpeg path は loadFfmpeg() でのみ設定するため廃止

// 並列実行を 2 本に制限
async function pLimit<T>(tasks: (() => Promise<T>)[], limit = 2): Promise<T[]> {
  const results: T[] = [];
  let i = 0;

  async function run() {
    while (i < tasks.length) {
      const cur = i++;
      results[cur] = await tasks[cur]();
    }
  }

  const runners = Array.from({ length: Math.min(limit, tasks.length) }, run);
  await Promise.all(runners);
  return results;
}

// FFprobe を使い duration を安全に取得する
async function getVideoDuration(inputPath: string): Promise<number> {
  await loadFfmpeg();
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err: any, data: any) => {
      if (err) return reject(err);
      const duration = data?.format?.duration;
      if (!duration) return reject(new Error('Unable to read duration'));
      resolve(duration);
    });
  });
}

async function extractFrameAtTimestamp(
  inputPath: string,
  outputPath: string,
  timestamp: number,
): Promise<void> {
  await loadFfmpeg();
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .seekInput(timestamp)
      .outputOptions(['-frames:v 1', '-q:v 2'])
      .save(outputPath)
      .on('end', resolve)
      .on('error', (err) =>
        reject(new Error(`FFmpeg frame extraction failed: ${err?.message || err}`)),
      );
  });
}

async function buildFrameResponse(inputPath: string): Promise<Record<FrameKey, ExtractedFrame>> {
  const duration = await getVideoDuration(inputPath);
  const results: Partial<Record<FrameKey, ExtractedFrame>> = {};

  const tasks = (Object.entries(FRAME_POSITIONS) as [FrameKey, number][]).map(
    ([key, ratio]) => async () => {
      const timestamp = duration * ratio;
      const outputPath = path.join('/tmp', `frame-${key}-${crypto.randomUUID()}.jpg`);

      await extractFrameAtTimestamp(inputPath, outputPath, timestamp);

      const buffer = await fs.readFile(outputPath);
      const base64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
      results[key] = { timestamp, imageBase64: base64 };

      await fs.rm(outputPath, { force: true });
    },
  );

  // 並列 2 件で FFmpeg 爆走を防ぐ
  await pLimit(tasks, 2);

  return results as Record<FrameKey, ExtractedFrame>;
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file');

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const ext = path.extname(file.name || '') || '.mp4';
    const inputPath = path.join('/tmp', `upload-${Date.now()}${ext}`);

    await fs.writeFile(inputPath, buffer);

    const frames = await buildFrameResponse(inputPath);

    await fs.rm(inputPath, { force: true });

    return NextResponse.json({ frames });
  } catch (error) {
    console.error('[extract] failed to process video', error);
    return NextResponse.json({ error: 'Failed to extract frames' }, { status: 500 });
  }
}
