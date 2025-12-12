// app/api/golf/analyze/route.ts

import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import { AnalysisId, GolfAnalyzeMeta, GolfAnalysisRecord, SwingAnalysis, MOCK_GOLF_ANALYSIS_RESULT } from "@/app/golf/types";
import { askVisionAPI } from "@/app/lib/vision/askVisionAPI";
import { extractPhaseFrames, PhaseFrame, PhaseKey, PhaseFrames } from "@/app/lib/vision/extractPhaseFrames";
import { genPrompt } from "@/app/lib/vision/genPrompt";
import { parseMultiPhaseResponse } from "@/app/lib/vision/parseMultiPhaseResponse";
import { getAnalysis, saveAnalysis } from "@/app/lib/store";

const execFileAsync = promisify(execFile);

// Node.js ランタイムで動かしたい場合は明示（必須ではないが念のため）
export const runtime = "nodejs";

const phaseOrder: PhaseKey[] = ["address", "top", "downswing", "impact", "finish"];
const clientPhaseOrder: PhaseKey[] = ["address", "backswing", "top", "downswing", "impact", "finish"];
const PHASE_ORDER: PhaseKey[] = ["address", "backswing", "top", "downswing", "impact", "finish"];

const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function normalizeMime(mime?: string | null): string {
  if (!mime) return "image/jpeg";
  const lower = mime.toLowerCase();
  for (const allowed of ALLOWED_IMAGE_MIME) {
    if (lower === allowed) return allowed;
  }
  // common typo
  if (lower === "image/jpg") return "image/jpeg";
  return "image/jpeg";
}

function isValidBase64Image(str: string | undefined | null): boolean {
  if (!str || typeof str !== "string") return false;
  try {
    const cleaned = str.replace(/\s+/g, "");
    const buf = Buffer.from(cleaned, "base64");
    return buf.length > 10; // minimal bytes for a tiny image
  } catch {
    return false;
  }
}

function isRawBase64(str: string | undefined | null): boolean {
  if (!str || typeof str !== "string") return false;
  if (str.length < 50) return false;
  const sample = str.slice(0, 200);
  return /^[A-Za-z0-9+/=]+$/.test(sample);
}

async function resolveExecutablePath(binary: "ffmpeg" | "ffprobe") {
  const envPath = process.env[binary.toUpperCase() + "_PATH"];
  if (envPath && envPath.trim().length > 0) return envPath;

  const brewPath = binary === "ffmpeg" ? "/opt/homebrew/bin/ffmpeg" : "/opt/homebrew/bin/ffprobe";
  try {
    await access(brewPath);
    return brewPath;
  } catch {}

  const brewPathIntel = binary === "ffmpeg" ? "/usr/local/bin/ffmpeg" : "/usr/local/bin/ffprobe";
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

  const jsonText = stdout?.trim()?.length ? stdout : stderr?.trim()?.length ? stderr : "{}";
  const parsed = JSON.parse(jsonText) as { format?: { duration?: string | number } };
  const durationValue = parsed.format?.duration;
  const duration = typeof durationValue === "string" ? Number(durationValue) : durationValue;
  return Number.isFinite(duration) && duration ? duration : 1;
}

async function extractFrameAt(inputPath: string, outputPath: string, timeSec: number): Promise<void> {
  const safeTime = Math.max(0, timeSec);
  const ffmpeg = await getFfmpegPath();
  const scaleFilter = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  const formatFilter = "format=yuvj420p";
  await execFileAsync(ffmpeg, [
    "-y",
    "-ss",
    safeTime.toString(),
    "-i",
    inputPath,
    "-vf",
    `${scaleFilter},${formatFilter}`,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-an",
    outputPath,
  ]);
}

async function extractSequenceFramesFromBuffer(params: {
  buffer: Buffer;
  mimeType: string;
  maxFrames?: number;
}): Promise<Array<PhaseFrame & { timestampSec?: number }>> {
  const { buffer, mimeType, maxFrames = 16 } = params;

  if (mimeType.startsWith("image/")) {
    return [{ base64Image: buffer.toString("base64"), mimeType, timestampSec: 0 }];
  }

  if (!mimeType.startsWith("video/")) {
    return [];
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "golf-seq-"));
  const extension = mimeType.includes("/") ? `.${mimeType.split("/")[1]}` : ".mp4";
  const inputPath = path.join(tempDir, `input${extension}`);

  try {
    await fs.writeFile(inputPath, buffer);
    const duration = await getVideoDuration(inputPath);
    const count = Math.max(2, Math.min(maxFrames, 16));

    const timestamps: number[] = [];
    for (let i = 0; i < count; i++) {
      const ratio = count === 1 ? 0 : i / Math.max(count - 1, 1);
      const t = Math.min(Math.max(0, ratio * duration), Math.max(0, duration - 0.001));
      timestamps.push(t);
    }

    const outputs = timestamps.map((_, idx) => path.join(tempDir, `seq-${idx}.jpg`));
    await Promise.all(timestamps.map((t, idx) => extractFrameAt(inputPath, outputs[idx], t)));

    const jpegMime = "image/jpeg";
    const frames: Array<PhaseFrame & { timestampSec?: number }> = [];
    for (let i = 0; i < outputs.length; i++) {
      try {
        const fileBuf = await fs.readFile(outputs[i]);
        frames.push({
          base64Image: fileBuf.toString("base64"),
          mimeType: jpegMime,
          timestampSec: timestamps[i],
        });
      } catch {
        // skip missing frames; continue
      }
    }
    return frames;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parseDataUrl(input: string | null): { base64Image: string; mimeType: string } | null {
  if (!input) return null;
  const match = input.match(/^data:(.*?);base64,(.*)$/);
  if (!match) return null;
  return { base64Image: match[2], mimeType: match[1] || "image/jpeg" };
}

function mergePhaseFrames(source: Partial<PhaseFrames> | null, fallback: PhaseFrames): PhaseFrames {
  return {
    address: source?.address ?? fallback.address,
    // 修正点：
    // 1. source.backswing（クライアント抽出）を最優先
    // 2. fallback.backswing（サーバー側バックアップ）
    // 3. source.address（極限時の代替）
    // 4. fallback.address（最終保険）
    backswing:
      source?.backswing ??
      fallback.backswing ??
      source?.address ??
      fallback.address,
    top: source?.top ?? fallback.top,
    downswing: source?.downswing ?? fallback.downswing,
    impact: source?.impact ?? fallback.impact,
    finish: source?.finish ?? fallback.finish,
  } satisfies PhaseFrames;
}

type SequenceFrameInput = { url?: string; timestampSec?: number };

async function fetchPhaseFrameFromUrl(input: SequenceFrameInput): Promise<(PhaseFrame & { timestampSec?: number }) | null> {
  if (!input?.url) return null;

  const parsed = parseDataUrl(input.url);
  if (parsed) {
    return {
      base64Image: parsed.base64Image,
      mimeType: parsed.mimeType,
      timestampSec: input.timestampSec,
    };
  }

  try {
    const response = await fetch(input.url);
    if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const mimeType = response.headers.get("content-type") || "image/jpeg";
    return {
      base64Image: Buffer.from(arrayBuffer).toString("base64"),
      mimeType,
      timestampSec: input.timestampSec,
    };
  } catch (error) {
    console.warn("[golf/analyze] failed to load sequence frame", input.url, error);
    return null;
  }
}

async function normalizePhaseFrame(frame: PhaseFrame, reqUrl: string): Promise<PhaseFrame> {
  if (!frame?.base64Image) return frame;

  const parsed = parseDataUrl(frame.base64Image);
  if (parsed) {
    const mimeType = normalizeMime(parsed.mimeType);
    // guard against malformed base64 (whitespace/newlines)
    const normalizedBase64 = parsed.base64Image.replace(/\s+/g, "");
    if (!isValidBase64Image(normalizedBase64)) {
      throw new Error("invalid base64 image data");
    }
    return { ...frame, base64Image: normalizedBase64, mimeType };
  }

  if (isRawBase64(frame.base64Image)) {
    const cleaned = frame.base64Image.replace(/\s+/g, "");
    const mimeType = normalizeMime(frame.mimeType);
    return { ...frame, base64Image: cleaned, mimeType };
  }

  const looksLikeUrl = /^https?:\/\//.test(frame.base64Image) || frame.base64Image.startsWith("/");
  if (!looksLikeUrl) {
    const mimeType = normalizeMime(frame.mimeType);
    const cleaned = frame.base64Image.replace(/\s+/g, "");
    if (!isValidBase64Image(cleaned)) {
      throw new Error("invalid base64 image data");
    }
    return { ...frame, base64Image: cleaned, mimeType };
  }

  try {
    const absolute = new URL(frame.base64Image, reqUrl).toString();
    const response = await fetch(absolute);
    if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const responseMime = response.headers.get("content-type");
    const mimeType = normalizeMime(responseMime || frame.mimeType);
    return {
      ...frame,
      base64Image: Buffer.from(arrayBuffer).toString("base64"),
      mimeType,
    };
  } catch (error) {
    console.warn("[golf/analyze] normalizePhaseFrame failed", frame.base64Image, error);
    return frame;
  }
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const file = formData.get("file");
    const handedness = formData.get("handedness");
    const clubType = formData.get("clubType");
    const level = formData.get("level");
    const previousAnalysisId = formData.get("previousAnalysisId");
    const previousReportJson = formData.get("previousReportJson");
    const phaseFramesJson = formData.get("phaseFramesJson");
    const inlinePhaseFrames = formData.getAll("phaseFrames[]");
    const sequenceFramesJson = formData.get("sequenceFramesJson");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    const normalizedHandedness: GolfAnalyzeMeta["handedness"] =
      handedness === "left" ? "left" : "right";
    const normalizedClub: GolfAnalyzeMeta["clubType"] =
      clubType === "iron" || clubType === "wedge" || clubType === "driver" ? clubType : "driver";
    const normalizedLevel: GolfAnalyzeMeta["level"] =
      level === "beginner" ||
      level === "beginner_plus" ||
      level === "upper_intermediate" ||
      level === "advanced" ||
      level === "intermediate"
        ? level
        : "intermediate";

    const meta: GolfAnalyzeMeta = {
      handedness: normalizedHandedness,
      clubType: normalizedClub,
      level: normalizedLevel,
      previousAnalysisId: typeof previousAnalysisId === "string" ? (previousAnalysisId as AnalysisId) : null,
    };

    let providedFrames: Partial<PhaseFrames> | null = null;

    if (typeof phaseFramesJson === "string") {
      try {
        const parsed = JSON.parse(phaseFramesJson) as Array<
          Partial<PhaseFrame> & { phase?: PhaseKey; timestamp?: number }
        >;
        if (Array.isArray(parsed)) {
          providedFrames = parsed.reduce((acc, frame) => {
            if (!frame || typeof frame !== "object" || !frame.phase || !frame.imageBase64) return acc;
            const normalized = parseDataUrl(frame.imageBase64);
            if (!normalized) return acc;
            acc[frame.phase] = {
              base64Image: normalized.base64Image,
              mimeType: normalized.mimeType,
              timestampSec: typeof frame.timestamp === "number" ? frame.timestamp : undefined,
            } as PhaseFrame;
            return acc;
          }, {} as Partial<PhaseFrames>);
        }
      } catch (error) {
        console.warn("[golf/analyze] failed to parse phaseFramesJson", error);
      }
    }

    if (!providedFrames && inlinePhaseFrames.length) {
      const normalized = inlinePhaseFrames
        .map((entry) => (typeof entry === "string" ? parseDataUrl(entry) : null))
        .filter(Boolean) as Array<{ base64Image: string; mimeType: string }>;

      if (normalized.length) {
        providedFrames = {} as Partial<PhaseFrames>;
        normalized.forEach((value, idx) => {
          const phase = clientPhaseOrder[idx] ?? clientPhaseOrder[clientPhaseOrder.length - 1];
          providedFrames![phase] = { base64Image: value.base64Image, mimeType: value.mimeType } as PhaseFrame;
        });
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || "application/octet-stream";

    const extractedFrames = await extractPhaseFrames({ buffer, mimeType });
    const frames = mergePhaseFrames(providedFrames, extractedFrames);

    let autoSequenceFrames: SequenceFrameInput[] = [];
    try {
      const seqFrames = await extractSequenceFramesFromBuffer({ buffer, mimeType, maxFrames: 16 });
      autoSequenceFrames = seqFrames.map((f) => ({
        url: `data:${f.mimeType};base64,${f.base64Image}`,
        timestampSec: f.timestampSec,
      }));
    } catch (error) {
      console.warn("[golf/analyze] failed to auto-extract sequence frames", error);
      // fallback: use extracted phase frames as minimal sequence
      autoSequenceFrames = PHASE_ORDER.map((phase) => {
        const p = frames[phase];
        return p
          ? {
              url: `data:${p.mimeType};base64,${p.base64Image}`,
              timestampSec: p.timestampSec,
            }
          : null;
      }).filter(Boolean) as SequenceFrameInput[];
    }

    let sequenceFrames: SequenceFrameInput[] = [];
    if (typeof sequenceFramesJson === "string") {
      try {
        const parsed = JSON.parse(sequenceFramesJson) as Array<SequenceFrameInput>;
        if (Array.isArray(parsed)) {
          sequenceFrames = parsed
            .filter((f) => f && typeof f === "object" && typeof f.url === "string")
            .map((f) => ({
              url: String(f.url),
              timestampSec: typeof f.timestampSec === "number" ? f.timestampSec : undefined,
            }));
        }
      } catch (error) {
        console.warn("[golf/analyze] failed to parse sequenceFramesJson", error);
      }
    }
    if (!sequenceFrames.length && autoSequenceFrames.length) {
      sequenceFrames = autoSequenceFrames;
    }

    let previousReport: SwingAnalysis | null = null;
    if (typeof previousAnalysisId === "string") {
      previousReport = (await getAnalysis(previousAnalysisId))?.result ?? null;
    }

    if (!previousReport && typeof previousReportJson === "string") {
      try {
        const parsed = JSON.parse(previousReportJson) as SwingAnalysis;
        if (parsed && typeof parsed === "object") {
          previousReport = parsed;
        }
      } catch (error) {
        console.warn("[golf/analyze] failed to parse previousReportJson", error);
      }
    }

    const prompt = genPrompt(meta, previousReport);

    // 🚨 修正：
    // Vision に渡すフレーム順は「必ずクライアントが決めた順序」を使う。
    // fallback で独自並び替えするとフェーズがズレる原因になる。

    const PHASE_ORDER: PhaseKey[] = [
      "address",
      "backswing",
      "top",
      "downswing",
      "impact",
      "finish",
    ];

    const sequenceFrameResults = sequenceFrames.slice(0, 16).map(async (input) => {
      const loaded = await fetchPhaseFrameFromUrl(input);
      return loaded ? { loaded, meta: input } : null;
    });
    const resolvedSequence = (await Promise.all(sequenceFrameResults)).filter(
      (f): f is { loaded: PhaseFrame; meta: SequenceFrameInput } => !!f
    );

    const visionFrames: PhaseFrame[] =
      resolvedSequence.length > 0
        ? resolvedSequence.map(({ loaded }) => loaded)
        : PHASE_ORDER.map((phase) => frames[phase]).filter((f): f is PhaseFrame => !!f);

    const normalizedVisionFrames = (await Promise.all(
      visionFrames.map((frame) =>
        normalizePhaseFrame(frame, req.url).catch((err) => {
          console.warn("[golf/analyze] drop frame (normalize failed)", err);
          return null;
        })
      )
    ))
      .filter((f): f is PhaseFrame => !!f)
      .map((frame) => ({
        ...frame,
        mimeType: normalizeMime(frame.mimeType),
        base64Image: frame.base64Image?.replace(/\s+/g, ""),
      }))
      .filter(
        (frame) => frame.base64Image && ALLOWED_IMAGE_MIME.has(normalizeMime(frame.mimeType)) && isValidBase64Image(frame.base64Image)
      );

    const fallbackVisionFrames = visionFrames
      .map((frame) => ({
        ...frame,
        mimeType: normalizeMime(frame.mimeType),
        base64Image: frame.base64Image?.replace(/\s+/g, ""),
      }))
      .filter((frame) => frame.base64Image);

    const framesForVision = normalizedVisionFrames.length
      ? normalizedVisionFrames
      : fallbackVisionFrames.length
        ? fallbackVisionFrames
        : [];

    let parsed;
    let visionFailedMessage: string | null = null;
    try {
      if (!framesForVision.length) {
        throw new Error("no frames available for Vision");
      }
      const jsonText = await askVisionAPI({ frames: framesForVision, prompt });
      parsed = parseMultiPhaseResponse(jsonText);
    } catch (error) {
      visionFailedMessage = error instanceof Error ? error.message : "Vision processing failed";
      console.error("[golf/analyze] vision failed, fallback to mock", error);
      parsed = parseMultiPhaseResponse(MOCK_GOLF_ANALYSIS_RESULT);
    }

    const totalScore = Number.isFinite(parsed.totalScore)
      ? parsed.totalScore
      : phaseOrder.reduce((sum, phase) => sum + (parsed.phases[phase]?.score ?? 0), 0);

    const analysisId: AnalysisId =
      typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `golf-${Date.now()}`;

    const timestamp = Date.now();
    const result: SwingAnalysis = {
      analysisId,
      createdAt: new Date(timestamp).toISOString(),
      totalScore,
      phases: parsed.phases,
      summary: parsed.summary,
      recommendedDrills: parsed.recommendedDrills ?? [],
      comparison: parsed.comparison,
      sequence: resolvedSequence.length
        ? {
            frames: await Promise.all(
              resolvedSequence.map(async ({ loaded, meta }) => {
                const normalized = await normalizePhaseFrame(loaded, req.url).catch((err) => {
                  console.warn("[golf/analyze] drop sequence frame (normalize failed)", err);
                  return null;
                });
                if (!normalized) return null;
                const mime = normalizeMime(normalized.mimeType);
                return {
                  url: `data:${mime};base64,${normalized.base64Image}`,
                  timestampSec: meta.timestampSec ?? normalized.timestampSec,
                };
              })
            ).then((items) => items.filter((i): i is { url: string; timestampSec?: number } => !!i)),
            stages: parsed.sequenceStages,
          }
        : parsed.sequenceStages
          ? { frames: [], stages: parsed.sequenceStages }
          : undefined,
    };

    const note = visionFailedMessage ? `Vision fallback: ${visionFailedMessage}` : undefined;

    const record: GolfAnalysisRecord = {
      id: analysisId,
      result,
      meta,
      createdAt: timestamp,
    };

    await saveAnalysis(record);

    return NextResponse.json({
      analysisId,
      note,
    });
  } catch (error) {
    console.error("[golf/analyze] error:", error);
    const message = error instanceof Error ? error.message : "internal server error";
    return NextResponse.json({ error: message || "internal server error" }, { status: 500 });
  }
}
