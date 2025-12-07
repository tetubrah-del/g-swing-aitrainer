import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

// fluent-ffmpeg is CJS, so call via cast
(ffmpeg as any).setFfmpegPath(ffmpegPath as string);

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

const createFfmpegCommand = ffmpeg as unknown as (input: string) => FfmpegCommand;

export type SwingFrame = {
  base64Image: string;
  mimeType: string;
};

async function getVideoDuration(inputPath: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err: Error | null, data: FfprobeData) => {
      if (err) {
        reject(err);
        return;
      }

      const duration = data.format?.duration;
      resolve(Number.isFinite(duration) ? Number(duration) : 0);
    });
  });
}

async function extractVideoFrames(inputPath: string, outputDir: string, frameCount: number): Promise<SwingFrame[]> {
  const duration = await getVideoDuration(inputPath);
  const fps = duration > 0 ? frameCount / duration : frameCount;

  await new Promise<void>((resolve, reject) => {
    createFfmpegCommand(inputPath)
      .outputOptions(["-vf", `fps=${fps}`])
      .output(path.join(outputDir, "frame-%02d.jpg"))
      .on("error", reject)
      .on("end", () => resolve())
      .run();
  });

  const files = (await fs.readdir(outputDir))
    .filter((file) => file.startsWith("frame-"))
    .sort();

  const frames: SwingFrame[] = [];

  for (const fileName of files) {
    const filePath = path.join(outputDir, fileName);
    const data = await fs.readFile(filePath);
    frames.push({
      base64Image: data.toString("base64"),
      mimeType: "image/jpeg",
    });
  }

  return frames.slice(0, frameCount);
}

export async function extractFrames(params: {
  buffer: Buffer;
  mimeType: string;
  maxFrames?: number;
}): Promise<SwingFrame[]> {
  const { buffer, mimeType, maxFrames = 6 } = params;

  if (mimeType.startsWith("image/")) {
    return [
      {
        base64Image: buffer.toString("base64"),
        mimeType,
      },
    ];
  }

  if (!mimeType.startsWith("video/")) {
    return [];
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "golf-frames-"));
  const extension = mimeType.includes("/") ? `.${mimeType.split("/")[1]}` : "";
  const inputPath = path.join(tempDir, `input${extension || ".bin"}`);

  try {
    await fs.writeFile(inputPath, buffer);
    const frames = await extractVideoFrames(inputPath, tempDir, Math.max(1, maxFrames));
    return frames;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
