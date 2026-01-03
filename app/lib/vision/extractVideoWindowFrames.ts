import "server-only";

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

type WindowFrame = {
  base64Image: string;
  mimeType: string;
  timestampSec?: number;
};

const execFileAsync = promisify(execFile);

async function resolveExecutablePath(binary: "ffmpeg") {
  const envPath = process.env.FFMPEG_PATH;
  if (envPath && envPath.trim().length > 0) return envPath;
  const brewPath = "/opt/homebrew/bin/ffmpeg";
  try {
    await access(brewPath);
    return brewPath;
  } catch {}
  const brewPathIntel = "/usr/local/bin/ffmpeg";
  try {
    await access(brewPathIntel);
    return brewPathIntel;
  } catch {}
  return binary;
}

let cachedFfmpegPath: string | null = null;
async function getFfmpegPath() {
  if (!cachedFfmpegPath) cachedFfmpegPath = await resolveExecutablePath("ffmpeg");
  return cachedFfmpegPath;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function buildTimestamps(params: {
  startSec: number;
  endSec: number;
  fps: number;
  maxFrames: number;
}) {
  const { startSec, endSec, fps, maxFrames } = params;
  const safeStart = Math.max(0, startSec);
  const safeEnd = Math.max(safeStart + 0.01, endSec);
  const step = 1 / Math.max(1, fps);
  const times: number[] = [];
  for (let t = safeStart; t <= safeEnd + 1e-6; t += step) {
    times.push(Number(t.toFixed(4)));
  }
  if (times.length <= maxFrames) return times;
  const sampled: number[] = [];
  const stride = (times.length - 1) / Math.max(maxFrames - 1, 1);
  for (let i = 0; i < maxFrames; i += 1) {
    const idx = Math.round(i * stride);
    sampled.push(times[Math.min(times.length - 1, idx)]);
  }
  return sampled;
}

async function resolveInputToFile(url: string, tempDir: string) {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`failed to fetch video: ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = path.extname(new URL(url).pathname) || ".mp4";
    const outPath = path.join(tempDir, `input${ext}`);
    await fs.writeFile(outPath, buffer);
    return outPath;
  }
  if (url.startsWith("file://")) {
    return url.replace("file://", "");
  }
  return url;
}

export async function extractVideoWindowFrames(params: {
  url: string;
  startSec: number;
  endSec: number;
  fps?: number;
  maxFrames?: number;
  timeoutMs?: number;
}): Promise<{ frames: WindowFrame[]; startSec: number; endSec: number; fps: number }> {
  const fps = Number.isFinite(params.fps as number) ? clamp(Number(params.fps), 5, 30) : 15;
  const maxFrames = Number.isFinite(params.maxFrames as number) ? clamp(Number(params.maxFrames), 6, 120) : 32;
  const timeoutMs = Number.isFinite(params.timeoutMs as number) ? Math.max(1000, Number(params.timeoutMs)) : 10000;
  const startSec = Math.max(0, Number(params.startSec) || 0);
  const endSec = Math.max(startSec + 0.05, Number(params.endSec) || 0);
  if (!params.url) throw new Error("video url missing");

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "golf-window-"));
  try {
    const inputPath = await resolveInputToFile(params.url, tempDir);
    const outDir = path.join(tempDir, "frames");
    await fs.mkdir(outDir, { recursive: true });

    const ffmpeg = await getFfmpegPath();
    const scaleFilter = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
    const formatFilter = "format=yuvj420p";
    const outputPattern = path.join(outDir, "frame-%04d.jpg");
    const args = [
      "-y",
      "-ss",
      startSec.toString(),
      "-to",
      endSec.toString(),
      "-i",
      inputPath,
      "-vf",
      `fps=${fps},${scaleFilter},${formatFilter}`,
      "-frames:v",
      String(maxFrames),
      "-q:v",
      "2",
      "-an",
      "-sn",
      outputPattern,
    ];
    await execFileAsync(ffmpeg, args, { timeout: timeoutMs });

    const files = (await fs.readdir(outDir))
      .filter((f) => f.startsWith("frame-") && f.endsWith(".jpg"))
      .sort();
    if (!files.length) {
      throw new Error("no frames extracted");
    }

    const timestamps = buildTimestamps({ startSec, endSec, fps, maxFrames: files.length });
    const frames: WindowFrame[] = [];
    for (let i = 0; i < files.length; i += 1) {
      const filePath = path.join(outDir, files[i]!);
      const data = await fs.readFile(filePath);
      frames.push({
        base64Image: data.toString("base64"),
        mimeType: "image/jpeg",
        timestampSec: timestamps[i],
      });
    }

    return { frames, startSec, endSec, fps };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
