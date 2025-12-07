declare module "fluent-ffmpeg" {
  type Callback = (...args: unknown[]) => void;

  interface FfprobeFormat {
    duration?: number;
  }

  interface FfprobeData {
    format?: FfprobeFormat;
  }

  interface FfmpegCommand {
    inputOptions(options: string[]): FfmpegCommand;
    frames(count: number): FfmpegCommand;
    outputOptions(options: string[]): FfmpegCommand;
    output(path: string): FfmpegCommand;
    on(event: "end" | "error", handler: Callback): FfmpegCommand;
    run(): FfmpegCommand;
  }

  interface FfmpegStatic {
    (input: string): FfmpegCommand;
    ffprobe(input: string, cb: (err: Error | null, data: FfprobeData) => void): void;
    setFfmpegPath(path: string | null | undefined): void;
  }

  const ffmpeg: FfmpegStatic;
  export = ffmpeg;
}
