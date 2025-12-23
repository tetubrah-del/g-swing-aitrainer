// app/api/golf/analyze/route.ts

import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import {
  AnalysisId,
  GolfAnalyzeMeta,
  GolfAnalysisRecord,
  SwingAnalysis,
  MOCK_GOLF_ANALYSIS_RESULT,
  UserUsageState,
} from "@/app/golf/types";
import { askVisionAPI } from "@/app/lib/vision/askVisionAPI";
import { extractPhaseFrames, PhaseFrame, PhaseKey, PhaseFrames } from "@/app/lib/vision/extractPhaseFrames";
import { detectPhases } from "@/app/lib/vision/detectPhases";
import { genPrompt } from "@/app/lib/vision/genPrompt";
import { parseMultiPhaseResponse } from "@/app/lib/vision/parseMultiPhaseResponse";
import { extractPoseKeypointsFromImages } from "@/app/lib/vision/extractPoseKeypoints";
import { auth } from "@/auth";
import { readAnonymousFromRequest, setAnonymousTokenOnResponse } from "@/app/lib/anonymousToken";
import { readEmailSessionFromRequest } from "@/app/lib/emailSession";
import { readActiveAuthFromRequest } from "@/app/lib/activeAuth";
import { canAnalyzeNow } from "@/app/lib/quota";
import { getAnalysis, saveAnalysis } from "@/app/lib/store";
import { incrementAnonymousQuotaCount, getAnonymousQuotaCount } from "@/app/lib/quotaStore";
import {
  findUserByEmail,
  getUserById,
  incrementFreeAnalysisCount,
  linkAnonymousIdToUser,
  upsertGoogleUser,
} from "@/app/lib/userStore";
import { canPerform } from "@/app/lib/permissions";
import { User, UserPlan } from "@/app/types/user";
import { buildSwingStyleComment, detectSwingStyle, detectSwingStyleChange, SwingStyleType } from "@/app/lib/swing/style";

const execFileAsync = promisify(execFile);

// Node.js ランタイムで動かしたい場合は明示（必須ではないが念のため）
export const runtime = "nodejs";

const phaseOrder: PhaseKey[] = ["address", "backswing", "top", "downswing", "impact", "finish"];
const clientPhaseOrder: PhaseKey[] = ["address", "backswing", "top", "downswing", "impact", "finish"];
const PHASE_ORDER: PhaseKey[] = ["address", "backswing", "top", "downswing", "impact", "finish"];

const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

type UserContext = {
  user: User;
  anonymousUserId: string | null;
  mintedAnonymousUserId?: string | null;
};

class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function resolveUserContext(req: NextRequest): Promise<UserContext> {
  const { anonymousUserId: tokenAnonymous } = readAnonymousFromRequest(req);
  const anonymousUserId = tokenAnonymous ?? null;
  const emailSession = readEmailSessionFromRequest(req);
  // If both Google and Email sessions exist but active_auth is missing, default to email to avoid cross-account mixing.
  const activeAuth = readActiveAuthFromRequest(req) ?? (emailSession ? "email" : null);

  let sessionUserId: string | null = null;
  let sessionEmail: string | null = null;
  if (activeAuth !== "email") {
    const session = await auth();
    sessionUserId = session?.user?.id ?? null;
    sessionEmail = session?.user?.email ?? null;
  }

  let account = sessionUserId ? await getUserById(sessionUserId) : null;
  if (!account && sessionEmail) {
    account = await findUserByEmail(sessionEmail);
  }
  if (sessionUserId && sessionEmail && !account) {
    account = await upsertGoogleUser({ googleSub: sessionUserId, email: sessionEmail, anonymousUserId });
  }
  if (!account && activeAuth !== "google" && emailSession) {
    const byId = await getUserById(emailSession.userId);
    if (
      byId &&
      byId.authProvider === "email" &&
      byId.emailVerifiedAt != null &&
      typeof byId.email === "string" &&
      byId.email.toLowerCase() === emailSession.email.toLowerCase()
    ) {
      account = byId;
    } else {
      const byEmail = await findUserByEmail(emailSession.email);
      if (byEmail && byEmail.authProvider === "email" && byEmail.emailVerifiedAt != null) {
        account = byEmail;
      }
    }
  }

  const now = Date.now();

  if (account) {
    // If a device anonymous token exists but isn't linked to this account, do not hard-fail.
    // Try to link it; if it's owned by another account, mint a fresh anonymous token to avoid cross-account mixing.
    let effectiveAnonymousUserId = anonymousUserId;
    let mintedAnonymousUserId: string | null = null;
    if (
      anonymousUserId &&
      (!Array.isArray(account.anonymousIds) || !account.anonymousIds.includes(anonymousUserId))
    ) {
      const updated = await linkAnonymousIdToUser(account.userId, anonymousUserId);
      if (updated) account = updated;
      const linkedNow = Array.isArray(account.anonymousIds) && account.anonymousIds.includes(anonymousUserId);
      if (!linkedNow) {
        mintedAnonymousUserId = crypto.randomUUID();
        effectiveAnonymousUserId = mintedAnonymousUserId;
      }
    }

    const anonymousUsed = effectiveAnonymousUserId ? await getAnonymousQuotaCount(effectiveAnonymousUserId) : 0;
    const effectiveFreeCount = Math.max(account.freeAnalysisCount ?? 0, anonymousUsed);
    const plan: UserPlan =
      account.proAccess === true && (account.proAccessExpiresAt == null || account.proAccessExpiresAt > now)
        ? "pro"
        : account.plan ?? (account.email ? "free" : "anonymous");
    const monitorExpiresAt =
      account.proAccessReason === "monitor" && account.proAccessExpiresAt ? account.proAccessExpiresAt : null;

    return {
      user: {
        id: account.userId,
        plan,
        email: account.email,
        authProvider: account.authProvider ?? null,
        isMonitor: account.proAccessReason === "monitor",
        monitorExpiresAt: monitorExpiresAt ? new Date(monitorExpiresAt) : null,
        freeAnalysisCount: effectiveFreeCount,
        freeAnalysisResetAt: account.freeAnalysisResetAt ? new Date(account.freeAnalysisResetAt) : new Date(0),
        createdAt: new Date(account.createdAt ?? now),
      },
      anonymousUserId: effectiveAnonymousUserId,
      mintedAnonymousUserId,
    };
  }

  const mintedAnonymousUserId = anonymousUserId ? null : crypto.randomUUID();
  const anonymousId = anonymousUserId ?? mintedAnonymousUserId!;
  const freeAnalysisCount = await getAnonymousQuotaCount(anonymousId);

  return {
    user: {
      id: anonymousId,
      plan: "anonymous",
      email: null,
      authProvider: null,
      isMonitor: false,
      monitorExpiresAt: null,
      freeAnalysisCount,
      freeAnalysisResetAt: new Date(0),
      createdAt: new Date(now),
    },
    anonymousUserId: anonymousId,
    mintedAnonymousUserId,
  };
}

function buildUsageStateFromUser(user: User, usedOverride?: number, anonymousId?: string | null): UserUsageState {
  const used = usedOverride ?? user.freeAnalysisCount ?? 0;
  const hasPro = canPerform(user, "unlimited_analysis");
  const isAnonymous = user.plan === "anonymous";
  const isFree = user.plan === "free";
  const baseProfile = {
    plan: user.plan,
    email: user.email,
    userId: isAnonymous ? null : user.id,
    anonymousUserId: anonymousId ?? (isAnonymous ? user.id : null),
    freeAnalysisCount: used,
    authProvider: user.authProvider ?? null,
  };

  if (hasPro) {
    return {
      isAuthenticated: !isAnonymous,
      hasProAccess: true,
      isMonitor: user.isMonitor,
      ...baseProfile,
      monthlyAnalysis: { used, limit: null, remaining: null },
    };
  }

  if (isAnonymous) {
    return {
      isAuthenticated: false,
      hasProAccess: false,
      isMonitor: false,
      ...baseProfile,
      monthlyAnalysis: { used, limit: 1, remaining: Math.max(0, 1 - used) },
    };
  }

  if (isFree) {
    const remaining = Math.max(0, 3 - used);
    return {
      isAuthenticated: true,
      hasProAccess: false,
      isMonitor: user.isMonitor,
      ...baseProfile,
      monthlyAnalysis: { used, limit: 3, remaining },
    };
  }

  return {
    isAuthenticated: true,
    hasProAccess: false,
    isMonitor: user.isMonitor,
    ...baseProfile,
    monthlyAnalysis: { used, limit: null, remaining: null },
  };
}

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
  mode?: "default" | "beta";
}): Promise<Array<PhaseFrame & { timestampSec?: number }>> {
  const { buffer, mimeType, maxFrames = 16, mode = "default" } = params;

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
    if (duration > 7) {
      throw new Error("Video duration exceeds limit (7 seconds)");
    }
    const targetCount = Math.max(2, Math.min(maxFrames, 16));
    const timeCount = mode === "beta" ? Math.min(20, targetCount + 6) : targetCount;

    // --------------------------------------------
    // 抽出モード切替
    // - default: 0.1s 刻みで先頭から終端まで埋める（端固定なし）
    // - beta:    動画長に応じた可変刻み（0.06〜0.14s）で全域を均等配置
    // --------------------------------------------
    const safeEnd = Math.max(0, duration - 0.05);
    const start = 0;
    const end = safeEnd;

    const timestamps: number[] = [];

    if (mode === "beta") {
      // ベータ: 全域均等ステップ + ダウン/インパクト寄りアンカーを優先、フィニッシュは1枚に抑制
      const step = Math.max(0.05, (end - start) / Math.max(timeCount - 1, 1));
      let t = start;
      while (timestamps.length < timeCount && t <= end + 1e-6) {
        timestamps.push(Math.min(Math.max(0, t), safeEnd));
        t += step;
      }

      // 動画尺に応じてアンカーをスケーリング
      const isLong = duration >= 4.0;
      const anchorRatios = isLong
        ? [0.34, 0.36, 0.40, 0.44, 0.48, 0.52, 0.56] // 長尺は前倒し
        : [0.42, 0.44, 0.46, 0.48, 0.50, 0.52, 0.54, 0.58, 0.62, 0.66];
      const anchors = anchorRatios.map((r) => Math.min(Math.max(0, r * duration), safeEnd));
      anchors.forEach((v) => timestamps.push(v));

      const unique = Array.from(new Set(timestamps.map((v) => Number(v.toFixed(4))))).sort((a, b) => a - b);

      // フィニッシュ抑制: 終盤枠は1枚だけ
      const finishThreshold = duration * 0.82;
      const late = unique.filter((v) => v >= finishThreshold);
      const latePick = late.length ? late[late.length - 1] : Math.min(safeEnd, duration);

      const anchorSet = new Set(anchors.map((v) => Number(v.toFixed(4))));
      const priority = Array.from(new Set([unique[0], ...unique.filter((v) => anchorSet.has(v)), latePick])).sort(
        (a, b) => a - b
      );

      const remaining = unique.filter((v) => !priority.includes(v) && v < finishThreshold);
      const slots = Math.max(timeCount - priority.length, 0);
      const chosen: number[] = [];
      if (slots > 0 && remaining.length > 0) {
        const stride = (remaining.length - 1) / Math.max(slots - 1, 1);
        for (let i = 0; i < slots; i += 1) {
          const idx = Math.round(i * stride);
          chosen.push(remaining[Math.min(remaining.length - 1, idx)]);
        }
      }

      const merged = Array.from(new Set([...priority, ...chosen])).sort((a, b) => a - b);
      const result =
        merged.length > targetCount
          ? (() => {
              const res: number[] = [];
              const stride = (merged.length - 1) / Math.max(targetCount - 1, 1);
              for (let i = 0; i < targetCount; i += 1) {
                const idx = Math.round(i * stride);
                res.push(merged[Math.min(merged.length - 1, idx)]);
              }
              return res;
            })()
          : merged;

      timestamps.length = 0;
      timestamps.push(...result);
    } else {
      // default も beta と同じ: 均等ステップ + アンカー（動画尺で前倒し） + フィニッシュ1枚
      const step = Math.max(0.05, (end - start) / Math.max(timeCount - 1, 1));
      let t = start;
      while (timestamps.length < timeCount && t <= end + 1e-6) {
        timestamps.push(Math.min(Math.max(0, t), safeEnd));
        t += step;
      }

      const isLong = duration >= 4.0;
      const anchorRatios = isLong
        ? [0.34, 0.36, 0.40, 0.44, 0.48, 0.52, 0.56]
        : [0.42, 0.44, 0.46, 0.48, 0.50, 0.52, 0.54, 0.58, 0.62, 0.66];
      const anchors = anchorRatios.map((r) => Math.min(Math.max(0, r * duration), safeEnd));
      anchors.forEach((v) => timestamps.push(v));

      const unique = Array.from(new Set(timestamps.map((v) => Number(v.toFixed(4))))).sort((a, b) => a - b);

      const finishThreshold = duration * 0.82;
      const late = unique.filter((v) => v >= finishThreshold);
      const latePick = late.length ? late[late.length - 1] : Math.min(safeEnd, duration);

      const anchorSet = new Set(anchors.map((v) => Number(v.toFixed(4))));
      const priority = Array.from(new Set([unique[0], ...unique.filter((v) => anchorSet.has(v)), latePick])).sort(
        (a, b) => a - b
      );

      const remaining = unique.filter((v) => !priority.includes(v) && v < finishThreshold);
      const slots = Math.max(timeCount - priority.length, 0);
      const chosen: number[] = [];
      if (slots > 0 && remaining.length > 0) {
        const stride = (remaining.length - 1) / Math.max(slots - 1, 1);
        for (let i = 0; i < slots; i += 1) {
          const idx = Math.round(i * stride);
          chosen.push(remaining[Math.min(remaining.length - 1, idx)]);
        }
      }

      const merged = Array.from(new Set([...priority, ...chosen])).sort((a, b) => a - b);
      const result =
        merged.length > targetCount
          ? (() => {
              const res: number[] = [];
              const stride = (merged.length - 1) / Math.max(targetCount - 1, 1);
              for (let i = 0; i < targetCount; i += 1) {
                const idx = Math.round(i * stride);
                res.push(merged[Math.min(merged.length - 1, idx)]);
              }
              return res;
            })()
          : merged;

      timestamps.length = 0;
      timestamps.push(...result);
    }

    const outputs = timestamps.map((_, idx) => path.join(tempDir, `seq-${idx}.jpg`));
    await Promise.all(timestamps.map((t, idx) => extractFrameAt(inputPath, outputs[idx], t)));

    const jpegMime = "image/jpeg";
    let frames: Array<PhaseFrame & { timestampSec?: number }> = [];
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

    // beta: 2段階抽出 - エナジーピークとアンカーで targetCount に絞り込む
    if (mode === "beta" && frames.length > targetCount) {
      const energy: number[] = [];
      for (let i = 1; i < frames.length; i += 1) {
        const a = Buffer.from(frames[i - 1].base64Image, "base64");
        const b = Buffer.from(frames[i].base64Image, "base64");
        const len = Math.min(a.length, b.length);
        let diff = 0;
        const stride = 24;
        for (let j = 0; j < len; j += stride) {
          diff += Math.abs(a[j] - b[j]);
        }
        energy.push(diff / Math.max(1, len / stride));
      }

      const pick = new Set<number>();
      pick.add(0);
      pick.add(frames.length - 1);

      const addNearest = (ratio: number) => {
        const t = ratio * duration;
        let best = 0;
        let bestDiff = Infinity;
        frames.forEach((f, idx) => {
          const d = Math.abs((f.timestampSec ?? 0) - t);
          if (d < bestDiff) {
            bestDiff = d;
            best = idx;
          }
        });
        pick.add(best);
      };

      [0.44, 0.5, 0.6].forEach(addNearest); // トップ〜インパクト近辺

      // エナジーピーク（中盤優先）
      const midStart = Math.floor(energy.length * 0.2);
      const midEnd = Math.ceil(energy.length * 0.85);
      const peakCandidates = energy
        .map((e, i) => ({ e, idx: i + 1 })) // energy[i]は i->i+1 間
        .filter(({ idx }) => idx >= midStart && idx <= midEnd)
        .sort((a, b) => b.e - a.e)
        .slice(0, 3);
      peakCandidates.forEach(({ idx }) => pick.add(idx));

      // 均等補完
      const missing = targetCount - pick.size;
      if (missing > 0) {
        const stride = (frames.length - 1) / Math.max(missing + 1, 1);
        for (let i = 1; i <= missing; i += 1) {
          const idx = Math.round(i * stride);
          pick.add(Math.min(frames.length - 1, idx));
        }
      }

      const finalIdx = Array.from(pick).sort((a, b) => a - b).slice(0, targetCount);
      frames = finalIdx.map((idx) => frames[idx]);
    }

    return frames;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const computeMotionEnergy = (frames: Array<PhaseFrame>): number[] => {
  if (!frames.length) return [];
  const energies: number[] = [0];
  for (let i = 1; i < frames.length; i += 1) {
    try {
      const a = Buffer.from(frames[i - 1].base64Image, "base64");
      const b = Buffer.from(frames[i].base64Image, "base64");
      const len = Math.min(a.length, b.length);
      if (!len) {
        energies.push(0);
        continue;
      }
      let diff = 0;
      const stride = 32; // 粗いサンプリングで高速化
      for (let j = 0; j < len; j += stride) {
        diff += Math.abs(a[j] - b[j]);
      }
      energies.push(diff / Math.max(1, len / stride));
    } catch {
      energies.push(0);
    }
  }
  return energies;
};

const detectMotionPhases = (
  frames: Array<PhaseFrame>
): { address: number; top: number; downswing: number; impact: number; finish: number } | null => {
  if (!frames || frames.length < 4) return null;
  const energy = computeMotionEnergy(frames);
  if (!energy.length) return null;

  // 独自ルール: インパクト = 最大エネルギー, トップ = インパクト前で最小エネルギー,
  // ダウンスイング = トップ以降〜インパクト直前でエネルギー最大（なければ impact-1, さらに fallback で detectPhases）
  try {
    const impact = energy.indexOf(Math.max(...energy));
    const topRange = energy.slice(0, Math.max(impact, 1));
    const top = topRange.length ? topRange.indexOf(Math.min(...topRange)) : 0;

    let downswing = Math.max(top + 1, impact - 1);
    let maxDsEnergy = -Infinity;
    for (let i = top + 1; i < impact; i += 1) {
      if (energy[i] > maxDsEnergy) {
        maxDsEnergy = energy[i];
        downswing = i;
      }
    }

    const finish = energy.length - 1;
    return { address: 0, top, downswing, impact, finish };
  } catch (err) {
    console.warn("[analyze] custom detectMotionPhases failed; fallback to detectPhases", err);
    try {
      return detectPhases(energy);
    } catch (err2) {
      console.warn("[analyze] detectPhases failed", err2);
      return null;
    }
  }
};

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

function toPosePoint(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { x?: unknown; y?: unknown };
  const x = Number(v.x);
  const y = Number(v.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function computeShoulderAngleRad(pose?: Record<string, unknown> | null): number | null {
  const ls = toPosePoint(pose?.leftShoulder);
  const rs = toPosePoint(pose?.rightShoulder);
  if (!ls || !rs) return null;
  return Math.atan2(rs.y - ls.y, rs.x - ls.x);
}

function computeShoulderCenterAndWidth(pose?: Record<string, unknown> | null): { center: { x: number; y: number }; width: number } | null {
  const ls = toPosePoint(pose?.leftShoulder);
  const rs = toPosePoint(pose?.rightShoulder);
  if (!ls || !rs) return null;
  const center = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const width = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  return { center, width };
}

function computeHandPosition(pose?: Record<string, unknown> | null): { x: number; y: number } | null {
  const lw = toPosePoint(pose?.leftWrist);
  const rw = toPosePoint(pose?.rightWrist);
  if (lw && rw) return { x: (lw.x + rw.x) / 2, y: (lw.y + rw.y) / 2 };
  return lw || rw || null;
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const file = formData.get("file");
    const handedness = formData.get("handedness");
  const clubType = formData.get("clubType");
  const level = formData.get("level");
  const mode = formData.get("mode");
    const previousAnalysisId = formData.get("previousAnalysisId");
    const previousReportJson = formData.get("previousReportJson");
    const phaseFramesJson = formData.get("phaseFramesJson");
    const inlinePhaseFrames = formData.getAll("phaseFrames[]");
    const sequenceFramesJson = formData.get("sequenceFramesJson");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    let userCtx: UserContext;
    try {
      userCtx = await resolveUserContext(req);
    } catch (error) {
      if (error instanceof HttpError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
    const { user, anonymousUserId, mintedAnonymousUserId } = userCtx;
    const permission = canAnalyzeNow(user);
    // Quota tests: anonymous 1st OK, 2nd -> 429 anonymous_limit; free 3rd OK, 4th -> 429 free_limit; pro always OK.
    if (!permission.allowed) {
      const usageState = buildUsageStateFromUser(user, user.freeAnalysisCount ?? 0, anonymousUserId);
      const res = NextResponse.json({ error: permission.reason, userState: usageState }, { status: 429 });
      if (mintedAnonymousUserId) {
        setAnonymousTokenOnResponse(res, mintedAnonymousUserId);
      } else if (anonymousUserId) {
        setAnonymousTokenOnResponse(res, anonymousUserId);
      }
      return res;
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
        const parsed = JSON.parse(phaseFramesJson) as Array<{
          phase?: PhaseKey;
          timestamp?: number;
          imageBase64?: string;
        }>;
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
    const seqFrames = await extractSequenceFramesFromBuffer({
      buffer,
      mimeType,
      maxFrames: 16,
      mode: mode === "beta" ? "beta" : "default",
    });
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
    const normalizedSequenceFrames: Array<(PhaseFrame & { timestampSec?: number }) | null> = resolvedSequence.length
      ? await Promise.all(
          resolvedSequence.map(async ({ loaded, meta }) => {
            const normalized = await normalizePhaseFrame(loaded, req.url).catch((err) => {
              console.warn("[golf/analyze] drop sequence frame (normalize failed)", err);
              return null;
            });
            if (!normalized) return null;
            return { ...normalized, timestampSec: meta.timestampSec ?? normalized.timestampSec };
          })
        )
      : [];

    const motionPhases = detectMotionPhases(
      normalizedSequenceFrames.filter((f): f is PhaseFrame => !!f && !!f.base64Image)
    );

    const resolvedSequenceFrames: Array<{ url: string; timestampSec?: number } | null> = normalizedSequenceFrames.map(
      (frame) => {
        if (!frame) return null;
        const mime = normalizeMime(frame.mimeType);
        return {
          url: `data:${mime};base64,${frame.base64Image}`,
          timestampSec: frame.timestampSec,
        };
      }
    );

    const cleanedSequenceFrames = resolvedSequenceFrames.filter(
      (i): i is { url: string; timestampSec?: number } => !!i
    );
    const phaseIndex1Based =
      motionPhases && typeof motionPhases.address === "number" && typeof motionPhases.impact === "number"
        ? {
            address: motionPhases.address + 1,
            top: motionPhases.top + 1,
            downswing: motionPhases.downswing + 1,
            impact: motionPhases.impact + 1,
            finish: motionPhases.finish + 1,
          }
        : null;

    const overrideStageIndex = (stage: string): number | null => {
      if (!phaseIndex1Based) return null;
      switch (stage) {
        case "address":
        case "address_to_backswing":
          return phaseIndex1Based.address;
        case "backswing_to_top":
          return phaseIndex1Based.top;
        case "top_to_downswing":
          return phaseIndex1Based.downswing;
        case "downswing_to_impact":
        case "impact":
          return phaseIndex1Based.impact;
        case "finish":
          return phaseIndex1Based.finish;
        default:
          return null;
      }
    };

    const stagesWithMotion =
      parsed.sequenceStages?.map((stage) => {
        const idx = overrideStageIndex(stage.stage);
        if (!idx) return stage;
        return { ...stage, keyFrameIndices: [idx] };
      }) ?? undefined;

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
            frames: cleanedSequenceFrames,
            stages: stagesWithMotion ?? parsed.sequenceStages,
          }
        : parsed.sequenceStages
          ? { frames: [], stages: stagesWithMotion ?? parsed.sequenceStages }
          : undefined,
    };

    // -------------------------------
    // P1/P2: swing style detection (torso/arm/mixed) without altering scores
    // - Use existing Top/Downswing/Impact frames only
    // - Extract pose with gpt-4o-mini (small) when available
    // -------------------------------
    try {
      const topFrame = frames.top;
      const downswingFrame = frames.downswing;
      const impactFrame = frames.impact;

      const poseFrames = await extractPoseKeypointsFromImages({
        frames: [
          { base64Image: topFrame.base64Image, mimeType: normalizeMime(topFrame.mimeType) },
          { base64Image: downswingFrame.base64Image, mimeType: normalizeMime(downswingFrame.mimeType) },
          { base64Image: impactFrame.base64Image, mimeType: normalizeMime(impactFrame.mimeType) },
        ],
      }).catch((err) => {
        console.warn("[golf/analyze] swingStyle pose extract failed", err);
        return [];
      });

      const byIdx = new Map<number, Record<string, unknown>>();
      poseFrames.forEach((f) => {
        if (f && typeof f === "object") {
          byIdx.set(f.idx, (f.pose as unknown as Record<string, unknown>) ?? {});
        }
      });

      const poseTop = byIdx.get(0) ?? null;
      const poseDs = byIdx.get(1) ?? null;
      const poseImp = byIdx.get(2) ?? null;

      const topAngle = computeShoulderAngleRad(poseTop);
      const dsAngle = computeShoulderAngleRad(poseDs);
      const impAngle = computeShoulderAngleRad(poseImp);
      const topHand = computeHandPosition(poseTop);
      const dsHand = computeHandPosition(poseDs);
      const impHand = computeHandPosition(poseImp);
      const dsShoulders = computeShoulderCenterAndWidth(poseDs);
      const topShoulders = computeShoulderCenterAndWidth(poseTop);
      const impShoulders = computeShoulderCenterAndWidth(poseImp);

      const faceUnstableHint =
        parsed.phases?.impact?.issues?.some((t) => /フェース|開き|face/i.test(String(t))) ?? false;

      if (
        typeof topAngle === "number" &&
        typeof dsAngle === "number" &&
        typeof impAngle === "number" &&
        topHand &&
        dsHand &&
        impHand
      ) {
        const assessment = detectSwingStyle({
          frames: {
            top: {
              shoulder_angle: topAngle,
              hand_position: topHand,
              shoulder_center: topShoulders?.center,
              shoulder_width: topShoulders?.width,
            },
            downswing: {
              shoulder_angle: dsAngle,
              hand_position: dsHand,
              shoulder_center: dsShoulders?.center,
              shoulder_width: dsShoulders?.width,
            },
            impact: {
              shoulder_angle: impAngle,
              hand_position: impHand,
              face_angle: null,
              shoulder_center: impShoulders?.center,
              shoulder_width: impShoulders?.width,
            },
          },
          faceUnstableHint,
        });

        const previousType: SwingStyleType | null =
          (previousReport?.swingStyle?.type as SwingStyleType | undefined) ?? null;
        const change = detectSwingStyleChange({ previous: previousType, current: assessment });
        const scoreDelta =
          typeof previousReport?.totalScore === "number" && Number.isFinite(previousReport.totalScore)
            ? totalScore - previousReport.totalScore
            : null;
        const comment = buildSwingStyleComment({ assessment, change, scoreDelta });

        result.swingStyle = assessment;
        result.swingStyleChange = change;
        result.swingStyleComment = comment;
      } else {
        // If pose signals are incomplete, still emit a safe default to support UX.
        const assessment = { type: "mixed", confidence: "low", evidence: ["判定に必要な情報が不足"] } as const;
        result.swingStyle = assessment;
        const previousType: SwingStyleType | null =
          (previousReport?.swingStyle?.type as SwingStyleType | undefined) ?? null;
        result.swingStyleChange = detectSwingStyleChange({ previous: previousType, current: assessment });
        result.swingStyleComment = buildSwingStyleComment({
          assessment,
          change: result.swingStyleChange,
          scoreDelta: null,
        });
      }
    } catch (err) {
      console.warn("[golf/analyze] swingStyle detection failed", err);
    }

    const note = visionFailedMessage ? `Vision fallback: ${visionFailedMessage}` : undefined;

    const record: GolfAnalysisRecord = {
      id: analysisId,
      result,
      meta,
      createdAt: timestamp,
      userId: user.plan === "anonymous" ? null : user.id,
      // Prevent cross-account leakage via shared device anonymous token:
      // authenticated analyses are always owned by the account only.
      anonymousUserId: user.plan === "anonymous" ? (anonymousUserId ?? user.id) : null,
    };

    await saveAnalysis(record);

    const anonymousUsage = anonymousUserId ? await getAnonymousQuotaCount(anonymousUserId) : 0;
    let usedCount = Math.max(user.freeAnalysisCount ?? 0, anonymousUsage);
    if (!canPerform(user, "unlimited_analysis")) {
      if (user.plan === "anonymous" && anonymousUserId) {
        await incrementAnonymousQuotaCount(anonymousUserId);
        usedCount += 1;
      } else if (user.plan === "free") {
        await incrementFreeAnalysisCount({ userId: user.id });
        usedCount += 1;
      }
    }

    const usageState = buildUsageStateFromUser(user, usedCount, anonymousUserId);
    const res = NextResponse.json({
      analysisId,
      note,
      userState: usageState,
    });

    if (mintedAnonymousUserId) {
      setAnonymousTokenOnResponse(res, mintedAnonymousUserId);
    } else if (anonymousUserId) {
      setAnonymousTokenOnResponse(res, anonymousUserId);
    }

    return res;
  } catch (error) {
    console.error("[golf/analyze] error:", error);
    const message = error instanceof Error ? error.message : "internal server error";
    return NextResponse.json({ error: message || "internal server error" }, { status: 500 });
  }
}
