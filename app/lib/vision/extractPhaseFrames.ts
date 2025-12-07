import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

// fluent-ffmpeg is CJS, so call via cast
(ffmpeg as any).setFfmpegPath(ffmpegPath as string);

// Use the callable export even when transpiled ESM provides a namespace object
const ffmpegModule = (ffmpeg as any).default ?? ffmpeg;

type FfprobeData = {
  format?: {
    duration?: number;
  };
};

type FfmpegCommand = {
  inputOptions(options: string[]): FfmpegCommand;
  frames(count: number): FfmpegCommand;
  outputOptions(options: string[]): FfmpegCommand;
  output(path: string): FfmpegCommand;
  on(event: "end" | "error", handler: (...args: unknown[]) => void): FfmpegCommand;
  run(): FfmpegCommand;
};

const createFfmpegCommand = ffmpegModule as unknown as (input: string) => FfmpegCommand;

export type PhaseKey = "address" | "top" | "downswing" | "impact" | "finish";

export type PhaseFrames = Record<PhaseKey, { base64Image: string; mimeType: string }>;
export type PhaseFrame = PhaseFrames[PhaseKey];

async function getVideoDuration(inputPath: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    ffmpegModule.ffprobe(inputPath, (err: Error | null, data: FfprobeData) => {
      if (err) {
        reject(err);
        return;
      }

      const duration = data.format?.duration;
      resolve(Number.isFinite(duration) ? Number(duration) : 0);
    });
  });
}

async function extractFrameAt(inputPath: string, outputPath: string, timeSec: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    createFfmpegCommand(inputPath)
      .inputOptions(["-ss", Math.max(0, timeSec).toString()])
      .frames(1)
      .outputOptions(["-q:v", "2"])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (error: unknown) => reject(error))
      .run();
  });
}

async function extractVideoPhaseFrames(inputPath: string, mimeType: string): Promise<PhaseFrames> {
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
