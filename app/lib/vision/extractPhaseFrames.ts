import "server-only";

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegStaticPath from "ffmpeg-static";

const execFileAsync = promisify(execFile);

export type PhaseKey = "address" | "top" | "downswing" | "impact" | "finish";

export type PhaseFrames = Record<PhaseKey, { base64Image: string; mimeType: string }>;
export type PhaseFrame = PhaseFrames[PhaseKey];

function resolveExecutablePath(binary: "ffmpeg" | "ffprobe"): string {
  const envPath = process.env[binary.toUpperCase() + "_PATH"];
  if (envPath && envPath.trim().length > 0) {
    return envPath;
  }

  if (binary === "ffmpeg" && typeof ffmpegStaticPath === "string" && ffmpegStaticPath.length > 0) {
    return ffmpegStaticPath;
  }

  return binary;
}

const ffmpegPath = resolveExecutablePath("ffmpeg");
const ffprobePath = resolveExecutablePath("ffprobe");

async function getVideoDuration(inputPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      inputPath,
    ]);

    const parsed = JSON.parse(stdout ?? "{}") as { format?: { duration?: string | number } };
    const durationValue = parsed.format?.duration;
    const duration = typeof durationValue === "string" ? Number(durationValue) : durationValue;
    return Number.isFinite(duration) && duration !== undefined ? duration : 0;
  } catch (error) {
    throw new Error(`Failed to probe video duration: ${String(error)}`);
  }
}

async function extractFrameAt(inputPath: string, outputPath: string, timeSec: number): Promise<void> {
  const safeTime = Math.max(0, timeSec);
  await execFileAsync(ffmpegPath, [
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
    const timestamps = [0.05, 0.2, 0.45, 0.7, 0.95].map((ratio) => ratio * length);

    const outputFiles = timestamps.map((_, idx) => path.join(tempDir, `phase-${idx}.jpg`));
    await Promise.all(timestamps.map((time, idx) => extractFrameAt(inputPath, outputFiles[idx], time)));

    const [addressFile, topFile, downswingFile, impactFile, finishFile] = outputFiles;
    const address = await fs.readFile(addressFile);
    const top = await fs.readFile(topFile);
    const downswing = await fs.readFile(downswingFile);
    const impact = await fs.readFile(impactFile);
    const finish = await fs.readFile(finishFile);

    const jpegMime = "image/jpeg";

    return {
      address: { base64Image: address.toString("base64"), mimeType: jpegMime },
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
