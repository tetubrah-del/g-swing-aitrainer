import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import * as ffmpeg from "fluent-ffmpeg";

type FfmpegModule = {
  setFfmpegPath: (path: string) => void;
};

type FfmpegCommand = {
  inputOptions(options: string[]): FfmpegCommand;
  outputOptions(options: string[]): FfmpegCommand;
  output(path: string): FfmpegCommand;
  on(event: "end" | "error", handler: (...args: unknown[]) => void): FfmpegCommand;
  run(): FfmpegCommand;
  kill(signal?: string): void;
};

const resolveFfmpegPath = (): string => {
  const require = createRequire(import.meta.url);
  try {
    const mod = require("ffmpeg-static");
    const candidate = typeof mod === "string" ? mod : mod?.path;
    if (candidate && existsSync(candidate)) return candidate;
  } catch (err) {
    // Ignore missing module; fallback to env/system ffmpeg.
  }
  const envPath = process.env.FFMPEG_PATH;
  if (envPath && existsSync(envPath)) return envPath;
  return "ffmpeg";
};

const ffmpegModule = ffmpeg as unknown as FfmpegModule;
ffmpegModule.setFfmpegPath(resolveFfmpegPath());
const createFfmpegCommand = ffmpeg as unknown as (input: string) => FfmpegCommand;

export type VideoWindowFrame = {
  base64Image: string;
  mimeType: string;
  timestampSec?: number;
};

export async function extractVideoWindowFrames(params: {
  url: string;
  startSec: number;
  endSec: number;
  fps?: number;
  maxFrames?: number;
  timeoutMs?: number;
}): Promise<{ frames: VideoWindowFrame[]; startSec: number; endSec: number; fps: number }> {
  const safeStart = Math.max(0, Number(params.startSec) || 0);
  const safeEnd = Math.max(safeStart + 0.01, Number(params.endSec) || safeStart + 0.01);
  const duration = Math.max(0.01, safeEnd - safeStart);
  const maxFrames = Number.isFinite(params.maxFrames) ? Math.max(1, Math.floor(params.maxFrames as number)) : 16;
  const fps = Number.isFinite(params.fps) && (params.fps as number) > 0 ? (params.fps as number) : Math.max(1, Math.round(maxFrames / duration));

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "golf-video-window-"));
  const outputPattern = path.join(tempDir, "frame-%03d.jpg");

  try {
    await new Promise<void>((resolve, reject) => {
      const command = createFfmpegCommand(params.url)
        .inputOptions(["-ss", `${safeStart}`, "-to", `${safeEnd}`])
        .outputOptions(["-vf", `fps=${fps}`, "-vframes", `${maxFrames}`])
        .output(outputPattern)
        .on("error", (err) => reject(err))
        .on("end", () => resolve());

      let timeoutId: NodeJS.Timeout | null = null;
      if (Number.isFinite(params.timeoutMs) && (params.timeoutMs as number) > 0) {
        timeoutId = setTimeout(() => {
          command.kill("SIGKILL");
          reject(new Error(`extractVideoWindowFrames timed out after ${params.timeoutMs}ms`));
        }, params.timeoutMs);
      }

      command.on("end", () => {
        if (timeoutId) clearTimeout(timeoutId);
      });
      command.on("error", () => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      command.run();
    });

    const files = (await fs.readdir(tempDir))
      .filter((file) => file.startsWith("frame-"))
      .sort();

    const frames: VideoWindowFrame[] = [];
    for (let i = 0; i < files.length; i += 1) {
      const filePath = path.join(tempDir, files[i]);
      const data = await fs.readFile(filePath);
      frames.push({
        base64Image: data.toString("base64"),
        mimeType: "image/jpeg",
        timestampSec: safeStart + i / fps,
      });
    }

    return {
      frames: frames.slice(0, maxFrames),
      startSec: safeStart,
      endSec: safeEnd,
      fps,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
