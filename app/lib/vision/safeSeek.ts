// app/lib/vision/safeSeek.ts
export async function safeSeek(
  video: HTMLVideoElement,
  time: number,
  timeoutMs = 1200
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;

    const onSeeked = (): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };

    const onError = (): void => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("seek failed"));
    };

    const cleanup = (): void => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };

    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = Math.min(Math.max(time, 0), video.duration);

    setTimeout(() => {
      if (!done) {
        done = true;
        cleanup();
        resolve(); // timeout fallback
      }
    }, timeoutMs);
  });
}
