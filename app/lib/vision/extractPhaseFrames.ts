import "server-only";

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
// macOS development prefers brew-installed ffmpeg & ffprobe

const execFileAsync = promisify(execFile);

export type PhaseKey =
  "address" | "backswing" | "top" | "downswing" | "impact" | "finish";

export interface PhaseFrame {
  id?: string;
  base64Image: string;
  mimeType: string;
  timestampSec?: number;
}

export type PhaseFrames = Record<PhaseKey, PhaseFrame>;

async function resolveExecutablePath(binary: "ffmpeg" | "ffprobe") {
  const envPath = process.env[binary.toUpperCase() + "_PATH"];
  if (envPath && envPath.trim().length > 0) {
    return envPath;
  }

  // 1. Homebrew default on Apple Silicon
  const brewPath = binary === "ffmpeg"
    ? "/opt/homebrew/bin/ffmpeg"
    : "/opt/homebrew/bin/ffprobe";

  try {
    await access(brewPath);
    return brewPath;
  } catch {}

  // 2. Intel mac
  const brewPathIntel = binary === "ffmpeg"
    ? "/usr/local/bin/ffmpeg"
    : "/usr/local/bin/ffprobe";
  try {
    await access(brewPathIntel);
    return brewPathIntel;
  } catch {}

  return binary;
}

let cachedFfmpegPath: string | null = null;
let cachedFfprobePath: string | null = null;

async function getFfmpegPath() {
  if (!cachedFfmpegPath) cachedFfmpegPath = await resolveExecutablePath("ffmpeg");
  return cachedFfmpegPath;
}

async function getFfprobePath() {
  if (!cachedFfprobePath) cachedFfprobePath = await resolveExecutablePath("ffprobe");
  return cachedFfprobePath;
}

async function getVideoDuration(inputPath: string): Promise<number> {
  try {
    const ffprobe = await getFfprobePath();
    const { stdout, stderr } = await execFileAsync(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      inputPath,
    ]);

    const jsonText =
      stdout?.trim()?.length ? stdout :
      stderr?.trim()?.length ? stderr : "{}";
    const parsed = JSON.parse(jsonText) as {
      format?: { duration?: string | number };
    };
    const durationValue = parsed.format?.duration;
    const duration = typeof durationValue === "string" ? Number(durationValue) : durationValue;
    return Number.isFinite(duration) && duration !== undefined ? duration : 0;
  } catch (error) {
    throw new Error(`Failed to probe video duration: ${String(error)}`);
  }
}

async function extractFrameAt(inputPath: string, outputPath: string, timeSec: number): Promise<void> {
  const safeTime = Math.max(0, timeSec);
  const ffmpeg = await getFfmpegPath();
  await execFileAsync(ffmpeg, [
    "-y",
    "-ss",
    safeTime.toString(),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    outputPath,
  ]);
}

async function extractVideoPhaseFrames(inputPath: string, _mimeType: string): Promise<PhaseFrames> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "golf-phase-frames-"));
  try {
    const duration = await getVideoDuration(inputPath);
    const length = duration > 0 ? duration : 1;
    const timestamps = [0.03, 0.18, 0.42, 0.65, 0.82, 0.97].map((ratio) => ratio * length);

    const outputFiles = timestamps.map((_, idx) => path.join(tempDir, `phase-${idx}.jpg`));
    await Promise.all(timestamps.map((time, idx) => extractFrameAt(inputPath, outputFiles[idx], time)));

    const [addressFile, backswingFile, topFile, downswingFile, impactFile, finishFile] = outputFiles;
    const address = await fs.readFile(addressFile);
    const backswing = await fs.readFile(backswingFile);
    const top = await fs.readFile(topFile);
    const downswing = await fs.readFile(downswingFile);
    const impact = await fs.readFile(impactFile);
    const finish = await fs.readFile(finishFile);

    const jpegMime = "image/jpeg";

    return {
      address: { base64Image: address.toString("base64"), mimeType: jpegMime },
      backswing: { base64Image: backswing.toString("base64"), mimeType: jpegMime },
      top: { base64Image: top.toString("base64"), mimeType: jpegMime },
      downswing: { base64Image: downswing.toString("base64"), mimeType: jpegMime },
      impact: { base64Image: impact.toString("base64"), mimeType: jpegMime },
      finish: { base64Image: finish.toString("base64"), mimeType: jpegMime },
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function extractPhaseFrames(params: { buffer: Buffer; mimeType: string }): Promise<PhaseFrames> {
  const { buffer, mimeType } = params;

  if (mimeType.startsWith("image/")) {
    const base64Image = buffer.toString("base64");
    return {
      address: { base64Image, mimeType },
      backswing: { base64Image, mimeType },
      top: { base64Image, mimeType },
      downswing: { base64Image, mimeType },
      impact: { base64Image, mimeType },
      finish: { base64Image, mimeType },
    };
  }

  if (!mimeType.startsWith("video/")) {
    const base64Image = buffer.toString("base64");
    return {
      address: { base64Image, mimeType: "image/jpeg" },
      backswing: { base64Image, mimeType: "image/jpeg" },
      top: { base64Image, mimeType: "image/jpeg" },
      downswing: { base64Image, mimeType: "image/jpeg" },
      impact: { base64Image, mimeType: "image/jpeg" },
      finish: { base64Image, mimeType: "image/jpeg" },
    };
  }

  const extension = mimeType.includes("/") ? `.${mimeType.split("/")[1]}` : "";
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "golf-phase-input-"));
  const inputPath = path.join(tempDir, `input${extension || ".bin"}`);

  try {
    await fs.writeFile(inputPath, buffer);
    return await extractVideoPhaseFrames(inputPath, mimeType);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
