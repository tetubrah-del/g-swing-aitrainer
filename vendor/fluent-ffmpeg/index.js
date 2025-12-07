const { spawn } = require("node:child_process");

function Ffmpeg(inputPath) {
  if (!(this instanceof Ffmpeg)) {
    return new Ffmpeg(inputPath);
  }

  this.inputPath = inputPath;
  this._outputOptions = [];
  this._outputPath = null;
  this._handlers = { end: [], error: [] };
}

Ffmpeg.prototype.outputOptions = function outputOptions(options) {
  if (Array.isArray(options)) {
    this._outputOptions.push(...options);
  }
  return this;
};

Ffmpeg.prototype.output = function output(outputPath) {
  this._outputPath = outputPath;
  return this;
};

Ffmpeg.prototype.on = function on(event, handler) {
  if (event === "end" || event === "error") {
    this._handlers[event].push(handler);
  }
  return this;
};

Ffmpeg.prototype.run = function run() {
  const args = ["-y", "-i", this.inputPath];
  if (this._outputOptions.length > 0) {
    args.push(...this._outputOptions);
  }
  if (this._outputPath) {
    args.push(this._outputPath);
  }

  const proc = spawn("ffmpeg", args);

  proc.on("error", (error) => {
    this._handlers.error.forEach((handler) => handler(error));
  });

  proc.on("close", (code) => {
    if (code === 0) {
      this._handlers.end.forEach((handler) => handler());
    } else {
      const error = new Error(`ffmpeg exited with code ${code}`);
      this._handlers.error.forEach((handler) => handler(error));
    }
  });

  return this;
};

Ffmpeg.ffprobe = function ffprobe(inputPath, callback) {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    inputPath,
  ];

  const proc = spawn("ffprobe", args);
  let output = "";
  let stderr = "";

  proc.stdout.on("data", (data) => {
    output += data.toString();
  });

  proc.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  proc.on("error", (error) => {
    callback(error);
  });

  proc.on("close", (code) => {
    if (code !== 0) {
      callback(new Error(stderr || `ffprobe exited with code ${code}`));
      return;
    }

    const duration = Number.parseFloat(output.trim());
    callback(null, {
      format: {
        duration: Number.isFinite(duration) ? duration : undefined,
      },
    });
  });
};

module.exports = Ffmpeg;
