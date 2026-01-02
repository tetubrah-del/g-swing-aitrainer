import "server-only";

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { PhaseFrame } from "@/app/lib/vision/extractPhaseFrames";

const execFileAsync = promisify(execFile);

async function resolveExecutablePath(binary: "ffmpeg") {
  const envPath = process.env[`${binary.toUpperCase()}_PATH`];
  if (envPath && envPath.trim().length > 0) {
    return envPath;
  }

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

function pickExtension(contentType: string | null, fallbackUrl?: string | null) {
  if (contentType) {
    const parsed = contentType.split(";")[0]?.trim() ?? "";
    if (parsed.startsWith("video/")) {
      const ext = parsed.split("/")[1];
      if (ext) return `.${ext.replace(/[^\w.]+/g, "")}`;
    }
  }
  if (fallbackUrl) {
    try {
      const pathname = new URL(fallbackUrl).pathname;
      const ext = path.extname(pathname);
      if (ext) return ext;
    } catch {}
  }
  return ".mp4";
}

async function downloadToTemp(url: string) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to download video: ${res.status} ${res.statusText}`);
  }
  const contentType = res.headers.get("content-type");
  const ext = pickExtension(contentType, url);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "golf-video-"));
  const inputPath = path.join(tempDir, `source${ext}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(inputPath, buffer);
  return { tempDir, inputPath };
}

function isFileUrl(url: string) {
  return url.startsWith("file://");
}

async function resolveInputSource(url: string) {
  if (isFileUrl(url)) {
    const filePath = decodeURI(url.replace(/^file:\/\//, ""));
    await access(filePath);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "golf-video-"));
    return { tempDir, inputPath: filePath };
  }
  if (path.isAbsolute(url)) {
    await access(url);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "golf-video-"));
    return { tempDir, inputPath: url };
  }
  return await downloadToTemp(url);
}

function clamp(val: number, min: number, max: number) {
  return Math.min(max, Math.max(min, val));
}

export async function extractVideoWindowFrames(params: {
  url: string;
  startSec: number;
  endSec: number;
  fps?: number;
  maxFrames?: number;
  timeoutMs?: number;
}): Promise<{ frames: PhaseFrame[]; fps: number; startSec: number; endSec: number }> {
  const fps = Number.isFinite(params.fps) ? clamp(params.fps ?? 15, 5, 30) : 15;
  const maxFrames = Number.isFinite(params.maxFrames) ? Math.max(1, Math.floor(params.maxFrames ?? 20)) : 20;
  const timeoutMs = Number.isFinite(params.timeoutMs) ? Math.max(1000, Math.floor(params.timeoutMs ?? 10000)) : 10000;
  let startSec = Number.isFinite(params.startSec) ? Math.max(0, params.startSec) : 0;
  let endSec = Number.isFinite(params.endSec) ? Math.max(startSec, params.endSec) : startSec + 0.6;
  if (endSec <= startSec + 0.05) endSec = startSec + 0.25;

  const duration = Math.max(0.05, endSec - startSec);
  const targetFrames = clamp(Math.round(duration * fps) + 1, 1, maxFrames);
  const { tempDir, inputPath } = await resolveInputSource(params.url);
  const outputDir = path.join(tempDir, "frames");
  const outputPattern = path.join(outputDir, "frame-%03d.jpg");
  const ffmpeg = await getFfmpegPath();
  const scaleFilter = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  const formatFilter = "format=yuvj420p";
  const vf = `fps=${fps},${scaleFilter},${formatFilter}`;

  try {
    await fs.mkdir(outputDir, { recursive: true });
    await execFileAsync(
      ffmpeg,
      [
        "-y",
        "-ss",
        startSec.toString(),
        "-t",
        duration.toString(),
        "-i",
        inputPath,
        "-vf",
        vf,
        "-frames:v",
        targetFrames.toString(),
        "-q:v",
        "2",
        "-an",
        "-sn",
        outputPattern,
      ],
      { timeout: timeoutMs }
    );

    const files = (await fs.readdir(outputDir))
      .filter((f) => f.endsWith(".jpg"))
      .sort((a, b) => a.localeCompare(b));
    const frames: PhaseFrame[] = [];
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i]!;
      const fileBuf = await fs.readFile(path.join(outputDir, file));
      frames.push({
        base64Image: fileBuf.toString("base64"),
        mimeType: "image/jpeg",
        timestampSec: startSec + i / fps,
      });
    }
    return { frames, fps, startSec, endSec };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
