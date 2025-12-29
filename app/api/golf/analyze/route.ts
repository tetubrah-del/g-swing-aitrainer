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
import { buildPhaseComparison } from "@/app/golf/utils/phaseComparison";
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
  isUserDisabled,
  linkAnonymousIdToUser,
  updateUserLastAnalysisAt,
  upsertGoogleUser,
} from "@/app/lib/userStore";
import { canPerform } from "@/app/lib/permissions";
import { User, UserPlan } from "@/app/types/user";
import { buildSwingStyleComment, detectSwingStyle, detectSwingStyleChange, SwingStyleType } from "@/app/lib/swing/style";
import { extractSequenceFramesAroundImpact } from "@/app/lib/vision/extractSequenceFramesAroundImpact";
import { rescoreSwingAnalysis } from "@/app/golf/scoring/phaseGuardrails";
import { retrieveCoachKnowledge } from "@/app/coach/rag/retrieve";

const execFileAsync = promisify(execFile);

// Node.js ランタイムで動かしたい場合は明示（必須ではないが念のため）
export const runtime = "nodejs";

const clientPhaseOrder: PhaseKey[] = ["address", "backswing", "top", "downswing", "impact", "finish"];
const PHASE_ORDER: PhaseKey[] = ["address", "backswing", "top", "downswing", "impact", "finish"];

const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_VIDEO_DURATION_SECONDS = 15;

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
  if (account && isUserDisabled(account)) account = null;
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
  if (account && isUserDisabled(account)) account = null;

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
    if (duration > MAX_VIDEO_DURATION_SECONDS) {
      throw new Error(`Video duration exceeds limit (${MAX_VIDEO_DURATION_SECONDS} seconds)`);
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

async function extractPreviewFramesFromBuffer(params: {
  buffer: Buffer;
  mimeType: string;
  maxFrames?: number;
}): Promise<Array<PhaseFrame & { timestampSec?: number }>> {
  const { buffer, mimeType, maxFrames = 48 } = params;

  if (mimeType.startsWith("image/")) {
    return [{ base64Image: buffer.toString("base64"), mimeType, timestampSec: 0 }];
  }

  if (!mimeType.startsWith("video/")) {
    return [];
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "golf-preview-"));
  const extension = mimeType.includes("/") ? `.${mimeType.split("/")[1]}` : ".mp4";
  const inputPath = path.join(tempDir, `input${extension}`);

  try {
    await fs.writeFile(inputPath, buffer);
    const duration = await getVideoDuration(inputPath);
    if (duration > MAX_VIDEO_DURATION_SECONDS) {
      throw new Error(`Video duration exceeds limit (${MAX_VIDEO_DURATION_SECONDS} seconds)`);
    }

    const targetCount = Math.max(2, Math.min(Math.floor(maxFrames), 60));
    const safeEnd = Math.max(0, duration - 0.05);
    const step = targetCount <= 1 ? 0 : (safeEnd - 0) / Math.max(targetCount - 1, 1);

    const timestamps: number[] = [];
    for (let i = 0; i < targetCount; i += 1) {
      timestamps.push(Math.min(Math.max(0, i * step), safeEnd));
    }

    const outputs = timestamps.map((_, idx) => path.join(tempDir, `preview-${idx}.jpg`));
    const concurrency = 6;
    for (let i = 0; i < timestamps.length; i += concurrency) {
      const slice = timestamps.slice(i, i + concurrency);
      await Promise.all(slice.map((t, j) => extractFrameAt(inputPath, outputs[i + j], t)));
    }

    const jpegMime = "image/jpeg";
    const frames: Array<PhaseFrame & { timestampSec?: number }> = [];
    for (let i = 0; i < outputs.length; i += 1) {
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
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => null);
  }
}

function buildImpactAwareTimestamps(params: {
  previewFrames: Array<{ timestampSec?: number }>;
  impactIndex: number;
  maxFrames?: number;
}): number[] {
  const { previewFrames, impactIndex, maxFrames = 16 } = params;
  const limit = Number.isFinite(maxFrames) ? Math.max(1, Math.floor(maxFrames)) : 16;

  const impact = previewFrames[Math.min(previewFrames.length - 1, Math.max(0, Math.floor(impactIndex)))];
  const impactTime = typeof impact?.timestampSec === "number" && Number.isFinite(impact.timestampSec) ? impact.timestampSec : null;
  if (impactTime == null) return [];

  // Fine extraction window around impact (0.03s step):
  // - pre: 3 frames (-0.15, -0.10, -0.05)
  // - impact: 0
  // - post: 1 frame (+0.05)
  const offsets = [-0.15, -0.1, -0.05, 0, 0.05];
  const fineTimes = offsets.map((o) => impactTime + o);

  const key = (t: number) => Number(t.toFixed(3));
  const fineKeySet = new Set(fineTimes.map(key));

  // Avoid clustering near impact: besides the fine window, do not pick additional coarse frames
  // within a small guard band around the impact time.
  const guardStart = impactTime - 0.155;
  const guardEnd = impactTime + 0.055;

  const candidateTimes = previewFrames
    .map((f) => f.timestampSec)
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t))
    .filter((t) => t < guardStart || t > guardEnd)
    .map(key);

  const candidateUnique = Array.from(new Set(candidateTimes)).sort((a, b) => a - b);

  const merged = new Set<number>();
  fineTimes.map(key).forEach((t) => merged.add(t));
  if (candidateUnique.length) {
    merged.add(candidateUnique[0]);
    merged.add(candidateUnique[candidateUnique.length - 1]);
  }

  const remainingSlots = Math.max(0, limit - merged.size);
  if (remainingSlots > 0 && candidateUnique.length > 0) {
    const remainingCandidates = candidateUnique.filter((t) => !merged.has(t) && !fineKeySet.has(t));
    if (remainingCandidates.length > 0) {
      const stride = (remainingCandidates.length - 1) / Math.max(remainingSlots - 1, 1);
      for (let i = 0; i < remainingSlots; i += 1) {
        const idx = Math.round(i * stride);
        merged.add(remainingCandidates[Math.min(remainingCandidates.length - 1, idx)]);
      }
    }
  }

  // If we still exceed the limit due to edge cases, trim non-fine candidates while keeping edges.
  const all = Array.from(merged).sort((a, b) => a - b);
  if (all.length <= limit) return all;

  const must = all.filter((t) => fineKeySet.has(t));
  const edgeA = all[0];
  const edgeB = all[all.length - 1];
  const kept = new Set<number>([...must, edgeA, edgeB]);

  const rest = all.filter((t) => !kept.has(t));
  const slots = Math.max(0, limit - kept.size);
  if (slots > 0 && rest.length > 0) {
    const stride = (rest.length - 1) / Math.max(slots - 1, 1);
    for (let i = 0; i < slots; i += 1) {
      const idx = Math.round(i * stride);
      kept.add(rest[Math.min(rest.length - 1, idx)]);
    }
  }

  return Array.from(kept).sort((a, b) => a - b).slice(0, limit);
}

async function extractFramesAtTimestampsFromBuffer(params: {
  buffer: Buffer;
  mimeType: string;
  timestampsSec: number[];
}): Promise<Array<PhaseFrame & { timestampSec?: number }>> {
  const { buffer, mimeType, timestampsSec } = params;

  if (mimeType.startsWith("image/")) {
    return [{ base64Image: buffer.toString("base64"), mimeType, timestampSec: 0 }];
  }

  if (!mimeType.startsWith("video/")) {
    return [];
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "golf-ts-"));
  const extension = mimeType.includes("/") ? `.${mimeType.split("/")[1]}` : ".mp4";
  const inputPath = path.join(tempDir, `input${extension}`);

  try {
    await fs.writeFile(inputPath, buffer);
    const duration = await getVideoDuration(inputPath);
    if (duration > MAX_VIDEO_DURATION_SECONDS) {
      throw new Error(`Video duration exceeds limit (${MAX_VIDEO_DURATION_SECONDS} seconds)`);
    }

    const safeEnd = Math.max(0, duration - 0.05);
    const clamped = timestampsSec
      .filter((t) => typeof t === "number" && Number.isFinite(t))
      .map((t) => Math.min(Math.max(0, t), safeEnd));

    const outputs = clamped.map((_, idx) => path.join(tempDir, `ts-${idx}.jpg`));
    const concurrency = 6;
    for (let i = 0; i < clamped.length; i += concurrency) {
      const slice = clamped.slice(i, i + concurrency);
      await Promise.all(slice.map((t, j) => extractFrameAt(inputPath, outputs[i + j], t)));
    }

    const jpegMime = "image/jpeg";
    const frames: Array<PhaseFrame & { timestampSec?: number }> = [];
    for (let i = 0; i < outputs.length; i += 1) {
      try {
        const fileBuf = await fs.readFile(outputs[i]);
        frames.push({
          base64Image: fileBuf.toString("base64"),
          mimeType: jpegMime,
          timestampSec: clamped[i],
        });
      } catch {
        // skip missing frames; continue
      }
    }

    return frames;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => null);
  }
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const file = formData.get("file");
    const handedness = formData.get("handedness");
  const clubType = formData.get("clubType");
  const level = formData.get("level");
  const mode = formData.get("mode");
    const previewOnlyRaw = formData.get("previewOnly");
    const impactIndexRaw = formData.get("impactIndex");
    const previewMaxFramesRaw = formData.get("previewMaxFrames");
    const previousAnalysisId = formData.get("previousAnalysisId");
    const previousReportJson = formData.get("previousReportJson");
    const phaseFramesJson = formData.get("phaseFramesJson");
    const inlinePhaseFrames = formData.getAll("phaseFrames[]");
    const sequenceFramesJson = formData.get("sequenceFramesJson");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    const previewOnly =
      previewOnlyRaw === "1" ||
      previewOnlyRaw === "true" ||
      previewOnlyRaw === "yes" ||
      previewOnlyRaw === "on";

    const parsedImpactIndex =
      typeof impactIndexRaw === "string" && impactIndexRaw.trim().length ? Number(impactIndexRaw) : undefined;
    const impactIndex = Number.isFinite(parsedImpactIndex) ? Math.floor(parsedImpactIndex!) : undefined;

    const parsedPreviewMaxFrames =
      typeof previewMaxFramesRaw === "string" && previewMaxFramesRaw.trim().length ? Number(previewMaxFramesRaw) : undefined;
    const previewMaxFrames = Number.isFinite(parsedPreviewMaxFrames)
      ? Math.max(20, Math.min(60, Math.floor(parsedPreviewMaxFrames!)))
      : 48;

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

    if (previewOnly) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const mimeType = file.type || "application/octet-stream";
      const previewFrames = await extractPreviewFramesFromBuffer({ buffer, mimeType, maxFrames: previewMaxFrames });
      const previewSequence: SequenceFrameInput[] = previewFrames.map((f) => ({
        url: `data:${f.mimeType};base64,${f.base64Image}`,
        timestampSec: f.timestampSec,
      }));

      const usageState = buildUsageStateFromUser(user, user.freeAnalysisCount ?? 0, anonymousUserId);
      const res = NextResponse.json({ previewFrames: previewSequence, userState: usageState });
      if (mintedAnonymousUserId) {
        setAnonymousTokenOnResponse(res, mintedAnonymousUserId);
      } else if (anonymousUserId) {
        setAnonymousTokenOnResponse(res, anonymousUserId);
      }
      return res;
    }

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
    if (typeof impactIndex === "number") {
      meta.impactIndex = impactIndex;
    }

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

    let sequenceFrames: SequenceFrameInput[] = [];
    if (typeof impactIndex === "number") {
      try {
        const previewFrames = await extractPreviewFramesFromBuffer({ buffer, mimeType, maxFrames: 60 });
        const timestampsSec = buildImpactAwareTimestamps({ previewFrames, impactIndex, maxFrames: 16 });
        if (timestampsSec.length) {
          const reExtracted = await extractFramesAtTimestampsFromBuffer({ buffer, mimeType, timestampsSec });
          sequenceFrames = reExtracted.map((f) => ({
            url: `data:${f.mimeType};base64,${f.base64Image}`,
            timestampSec: f.timestampSec,
          }));
        } else {
          const allFrames: SequenceFrameInput[] = previewFrames.map((f) => ({
            url: `data:${f.mimeType};base64,${f.base64Image}`,
            timestampSec: f.timestampSec,
          }));
          sequenceFrames = extractSequenceFramesAroundImpact(allFrames, impactIndex, 16);
        }
      } catch (error) {
        console.warn("[golf/analyze] failed to extract preview frames for impact selection", error);
      }
    } else {
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

    // Focused 2nd-pass check: downswing trajectory (outside-in) often gets missed in multi-task scoring prompts.
    let outsideInDetected: { value: boolean; confidence: "high" | "medium" | "low" | null } | null = null;
    let earlyExtensionDetected: { value: boolean; confidence: "high" | "medium" | "low" | null } | null = null;
    if (framesForVision.length >= 6) {
      try {
        const judgeFrames =
          framesForVision.length >= 12
            ? framesForVision.slice(4, 12) // around top→downswing→impact
            : framesForVision.slice(0, Math.min(8, framesForVision.length));
        const outsideInRag = retrieveCoachKnowledge(
          ["アウトサイドイン", "カット軌道", "外から下りる", "観測チェックリスト", "強制出力ルール", "Downswing"].join(" "),
          { maxChunks: 4, maxChars: 1400, minScore: 0 }
        );
        const outsideInPrompt = [
          "あなたはゴルフスイングの判定専用AIです。",
          "提供されたフレーム画像のみを根拠に、Downswing（切り返し〜下ろし）の軌道がアウトサイドインかどうかを判定してください。",
          "迷った場合は false にしてください（グレーは false）。",
          "",
          outsideInRag.contextText ? "【OutsideIn判定RAG】\n" + outsideInRag.contextText : "",
          "",
          "必ずJSONのみで返してください：",
          '{ "outsideIn": true/false, "confidence": "high"|"medium"|"low", "evidence": ["根拠1","根拠2"] }',
        ]
          .filter(Boolean)
          .join("\n");
        const judge = await askVisionAPI({ frames: judgeFrames, prompt: outsideInPrompt });
        const obj = judge && typeof judge === "object" ? (judge as Record<string, unknown>) : null;
        const raw =
          obj?.outsideIn ??
          obj?.outside_in ??
          obj?.["outside-in"] ??
          obj?.result ??
          null;
        let value: boolean | null = null;
        if (typeof raw === "boolean") value = raw;
        else if (typeof raw === "string") {
          const t = raw.trim().toLowerCase();
          if (t === "true") value = true;
          if (t === "false") value = false;
        } else if (typeof raw === "number" && Number.isFinite(raw)) {
          value = raw >= 1;
        }
        const confRaw = obj?.confidence;
        const confidence =
          confRaw === "high" || confRaw === "medium" || confRaw === "low" ? (confRaw as "high" | "medium" | "low") : null;
        if (typeof value === "boolean") {
          outsideInDetected = { value, confidence };
        }
      } catch (err) {
        console.warn("[golf/analyze] outside-in judge failed", err);
      }
    }

    // Focused 2nd-pass check: Impact early-extension (pelvis thrust / loss of posture) is easy to miss.
    if (framesForVision.length >= 6) {
      try {
        const judgeFrames =
          framesForVision.length >= 12
            ? framesForVision.slice(6, 11) // around downswing→impact→post
            : framesForVision.slice(Math.max(0, framesForVision.length - 6), framesForVision.length);
        const earlyExtRag = retrieveCoachKnowledge(
          ["早期伸展", "骨盤が前に出る", "前傾が起きる", "腰の突っ込み", "スペースが潰れる", "Impact"].join(" "),
          { maxChunks: 3, maxChars: 1200, minScore: 0 }
        );
        const earlyExtPrompt = [
          "あなたはゴルフスイングの判定専用AIです。",
          "提供されたフレーム画像のみを根拠に、Impact（インパクト）付近で「早期伸展（骨盤がボール側に前に出る／前傾が起きる／スペースが潰れる）」があるかを判定してください。",
          "迷った場合は false にしてください（グレーは false）。",
          "",
          earlyExtRag.contextText ? "【Impact早期伸展 判定RAG】\n" + earlyExtRag.contextText : "",
          "",
          "必ずJSONのみで返してください：",
          '{ "earlyExtension": true/false, "confidence": "high"|"medium"|"low", "evidence": ["根拠1","根拠2"] }',
        ]
          .filter(Boolean)
          .join("\n");
        const judge = await askVisionAPI({ frames: judgeFrames, prompt: earlyExtPrompt });
        const obj = judge && typeof judge === "object" ? (judge as Record<string, unknown>) : null;
        const raw = obj?.earlyExtension ?? obj?.early_extension ?? obj?.["early-extension"] ?? obj?.result ?? null;
        let value: boolean | null = null;
        if (typeof raw === "boolean") value = raw;
        else if (typeof raw === "string") {
          const t = raw.trim().toLowerCase();
          if (t === "true") value = true;
          if (t === "false") value = false;
        } else if (typeof raw === "number" && Number.isFinite(raw)) {
          value = raw >= 1;
        }
        const confRaw = obj?.confidence;
        const confidence =
          confRaw === "high" || confRaw === "medium" || confRaw === "low" ? (confRaw as "high" | "medium" | "low") : null;
        if (typeof value === "boolean") {
          earlyExtensionDetected = { value, confidence };
        }
      } catch (err) {
        console.warn("[golf/analyze] early-extension judge failed", err);
      }
    }

    const rescored = rescoreSwingAnalysis({
      result: {
        analysisId: "temp",
        createdAt: new Date().toISOString(),
        totalScore: 0,
        phases: parsed.phases,
        summary: parsed.summary,
        recommendedDrills: parsed.recommendedDrills ?? [],
      },
      majorNg:
        outsideInDetected?.value === true && outsideInDetected.confidence === "high"
          ? { ...(parsed.majorNg ?? {}), downswing: true }
          : outsideInDetected?.value === false
            ? parsed.majorNg
            : parsed.majorNg,
      midHighOk:
        (() => {
          const base = parsed.midHighOk ?? {};
          const withDs =
            outsideInDetected?.value === true ? { ...base, downswing: false } : outsideInDetected?.value === false ? base : base;
          if (earlyExtensionDetected?.value === true) {
            return { ...withDs, impact: false };
          }
          return withDs;
        })(),
      deriveFromText: true,
      outsideInConfirmed: outsideInDetected?.value === true && outsideInDetected.confidence === "high",
    });

    parsed.phases = rescored.phases;
    let totalScore = rescored.totalScore;

    // If early extension is detected, ensure it's explicitly mentioned (as "confirmed") and cap impact score.
    try {
      if (earlyExtensionDetected?.value === true) {
        const imp = parsed.phases.impact;
        const hasWord = (imp.issues ?? []).some((t) => /早期伸展（確定）|骨盤.*前.*出|腰.*前.*出|前傾.*起き|腰の突っ込み|スペース.*潰/.test(String(t)));
        if (!hasWord) {
          imp.issues = ["早期伸展（確定）", ...(imp.issues ?? [])].slice(0, 4);
        }
        const cap = earlyExtensionDetected.confidence === "high" ? 10 : 12;
        imp.score = Math.min(imp.score ?? 0, cap);
        // Recompute total based on adjusted phase scores.
        const sum = PHASE_ORDER.reduce((acc, key) => acc + (parsed.phases[key]?.score ?? 0), 0);
        const raw = Math.max(0, Math.min(100, Math.round((sum / (PHASE_ORDER.length * 20)) * 100)));
        totalScore = Math.min(totalScore, raw);
      }
    } catch {
      // ignore
    }

    // If the focused 2nd-pass judge says "false", avoid keeping strong penalty keywords solely from the multi-task LLM output.
    // This prevents false positives (e.g., pro swings) from being forced into low scores by a single mislabel.
    try {
      const hasTwoGoods = (items: unknown) => Array.isArray(items) && items.filter((t) => typeof t === "string" && t.trim().length > 0).length >= 2;
      const dropGenericDsAdviceWhenNoIssues = (ds: { issues?: unknown; advice?: unknown }) => {
        const issues = Array.isArray(ds.issues) ? ds.issues : [];
        if (issues.length) return;
        const advice = Array.isArray(ds.advice) ? ds.advice : [];
        ds.advice = advice.filter(
          (t) =>
            !/インサイド|内側|手元.*先行|フェース.*開|アウトサイドイン|外から|カット軌道|かぶせ|上から/.test(String(t))
        );
      };
      if (outsideInDetected?.value === false) {
        const ds = parsed.phases.downswing;
        const before = Array.isArray(ds.issues) ? ds.issues : [];
        const filtered = before.filter((t) => !/外から入りやすい傾向|アウトサイドイン（確定）|カット軌道（確定）|外から下りる（確定）|アウトサイドイン|カット軌道|外から下り/.test(String(t)));
        if (filtered.length !== before.length) {
          ds.issues = filtered;
          if ((ds.score ?? 0) < 18 && hasTwoGoods(ds.good)) ds.score = 18;
          dropGenericDsAdviceWhenNoIssues(ds);
        }
      }
      // If the judge is unavailable (null) and the only "issue" is a soft "要確認" label, treat it as non-evidence.
      // This avoids penalizing high-skill swings when the model over-applies the tendency phrase.
      if (outsideInDetected == null) {
        const ds = parsed.phases.downswing;
        const issues = Array.isArray(ds.issues) ? ds.issues : [];
        const hasOnlySoftTendency =
          issues.length === 1 && /外から入りやすい傾向（要確認）/.test(String(issues[0]));
        if (hasOnlySoftTendency && hasTwoGoods(ds.good)) {
          ds.issues = [];
          if ((ds.score ?? 0) < 18) ds.score = 18;
          dropGenericDsAdviceWhenNoIssues(ds);
        }
        // If issues are empty but score is still low, treat it as a scoring mismatch and lift it.
        const nowIssues = Array.isArray(ds.issues) ? ds.issues : [];
        if (!nowIssues.length && hasTwoGoods(ds.good) && (ds.score ?? 0) < 18) {
          ds.score = 18;
          dropGenericDsAdviceWhenNoIssues(ds);
        }
      }
      if (earlyExtensionDetected?.value === false) {
        const imp = parsed.phases.impact;
        const before = Array.isArray(imp.issues) ? imp.issues : [];
        const filtered = before.filter((t) => !/早期伸展|骨盤.*前.*出|腰.*前.*出|前傾.*起き|腰の突っ込み|スペース.*潰/.test(String(t)));
        if (filtered.length !== before.length) {
          imp.issues = filtered;
          if ((imp.score ?? 0) < 14 && hasTwoGoods(imp.good)) imp.score = 14;
        }
      }
    } catch {
      // ignore
    }

    // Absolute enforcement (defensive): Some models still miss outside-in cues even with RAG.
    // If downswing text contains strong over-the-top signals, force DS caps (confirmed vs tendency).
    try {
      const ds = parsed.phases.downswing;
      const dsText = [...(ds.good ?? []), ...(ds.issues ?? []), ...(ds.advice ?? [])].join("／");
      const hasUpperBodyIssue = /上半身/.test(dsText) && /(回転.*不足|不足|開き)/.test(dsText);
      const hasEarlyRelease = /(手首|コック|リリース)/.test(dsText) && /(早|解け|ほどけ)/.test(dsText);
      const hasElbowAway = /右肘.*体から離れ|肘.*離れすぎ|腕が体から離れ/.test(dsText);
      const hasKneeCollapse = /右膝.*内側|膝.*内側.*入りすぎ/.test(dsText);
      const hasConfirmedWord = /アウトサイドイン（確定）|カット軌道（確定）|外から下りる（確定）/.test(dsText);
      const hasTendencyWord = /外から入りやすい傾向/.test(dsText);
      const judgeConfirmed = outsideInDetected?.value === true && outsideInDetected.confidence === "high";
      const judgeTendency = outsideInDetected?.value === true && outsideInDetected.confidence !== "high";
      const canTrustText = outsideInDetected?.value !== false && outsideInDetected != null;
      const heuristicTendency =
        (hasElbowAway ? 1 : 0) +
          (hasKneeCollapse ? 1 : 0) +
          (hasUpperBodyIssue && hasEarlyRelease ? 1 : 0) +
          (hasUpperBodyIssue && hasElbowAway ? 1 : 0) >=
        2;
      const confirmed = hasConfirmedWord || judgeConfirmed;
      const tendency = judgeTendency || (canTrustText && (heuristicTendency || (hasTendencyWord && heuristicTendency)));

      if (confirmed) {
        ds.score = Math.min(ds.score ?? 0, 8);
        if (!ds.issues?.some((t) => /（確定）/.test(String(t)))) {
          ds.issues = ["アウトサイドイン（確定）", ...(ds.issues ?? [])].slice(0, 4);
        }
        const sum = PHASE_ORDER.reduce((acc, key) => acc + (parsed.phases[key]?.score ?? 0), 0);
        const raw = Math.max(0, Math.min(100, Math.round((sum / (PHASE_ORDER.length * 20)) * 100)));
        totalScore = Math.min(totalScore, raw, 58);
      } else if (tendency) {
        ds.score = Math.min(ds.score ?? 0, 12);
        if (!ds.issues?.some((t) => /外から入りやすい傾向/.test(String(t)))) {
          ds.issues = ["外から入りやすい傾向（要確認）", ...(ds.issues ?? [])].slice(0, 4);
        }
        const sum = PHASE_ORDER.reduce((acc, key) => acc + (parsed.phases[key]?.score ?? 0), 0);
        const raw = Math.max(0, Math.min(100, Math.round((sum / (PHASE_ORDER.length * 20)) * 100)));
        totalScore = Math.min(totalScore, raw);
      }
    } catch {
      // ignore enforcement failures
    }

    // Final consistency pass: recompute totalScore from the current phase scores (after postprocessing),
    // while preserving only the intended cross-phase caps.
    try {
      const sum = PHASE_ORDER.reduce((acc, key) => acc + (parsed.phases[key]?.score ?? 0), 0);
      const raw = Math.max(0, Math.min(100, Math.round((sum / (PHASE_ORDER.length * 20)) * 100)));
      let capped = raw;
      if ((parsed.phases.downswing?.score ?? 0) <= 8) capped = Math.min(capped, 65);
      if (outsideInDetected?.value === true && outsideInDetected.confidence === "high") capped = Math.min(capped, 58);
      if ((parsed.phases.address?.score ?? 0) <= 8 && (parsed.phases.finish?.score ?? 0) <= 8) capped = Math.min(capped, 60);
      totalScore = capped;
    } catch {
      // ignore
    }

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

    // Final, authoritative guardrails pass (analysis-time only).
    // This keeps stored results consistent even when upstream prompts drift.
    {
      const finalized = rescoreSwingAnalysis({
        result,
        majorNg:
          outsideInDetected?.value === true && outsideInDetected.confidence === "high"
            ? { ...(parsed.majorNg ?? {}), downswing: true }
            : outsideInDetected?.value === false
              ? parsed.majorNg
              : parsed.majorNg,
        midHighOk:
          (() => {
            const base = parsed.midHighOk ?? {};
            const withDs =
              outsideInDetected?.value === true ? { ...base, downswing: false } : outsideInDetected?.value === false ? base : base;
            if (earlyExtensionDetected?.value === true) {
              return { ...withDs, impact: false };
            }
            return withDs;
          })(),
        deriveFromText: true,
        outsideInConfirmed: outsideInDetected?.value === true && outsideInDetected.confidence === "high",
      });
      result.totalScore = finalized.totalScore;
      result.phases = finalized.phases;
      // Keep downstream logic consistent (swing style delta / hints, etc).
      totalScore = result.totalScore;
      parsed.phases = result.phases;
    }

    if (previousReport) {
      result.comparison = buildPhaseComparison(previousReport, result);
    }

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

    meta.scoringVersion = "v2025-12-28-guardrails-outside-in";

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
    // Track last diagnosis timestamp for admin views.
    if (user.plan !== "anonymous" && typeof user.id === "string") {
      await updateUserLastAnalysisAt({ userId: user.id, at: record.createdAt });
    }

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
