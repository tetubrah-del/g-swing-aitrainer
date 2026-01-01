// app/api/golf/reanalyze-phases/route.ts

import { NextRequest, NextResponse } from "next/server";
import { AnalysisId, GolfAnalysisResponse, SwingAnalysis } from "@/app/golf/types";
import { buildPhaseComparison } from "@/app/golf/utils/phaseComparison";
import { getAnalysis, saveAnalysis } from "@/app/lib/store";
import { readAnonymousFromRequest } from "@/app/lib/anonymousToken";
import { readEmailSessionFromRequest } from "@/app/lib/emailSession";
import { readActiveAuthFromRequest, setActiveAuthOnResponse } from "@/app/lib/activeAuth";
import { auth } from "@/auth";
import { findUserByEmail, getUserById } from "@/app/lib/userStore";
import type { PhaseFrame } from "@/app/lib/vision/extractPhaseFrames";
import { askVisionAPI } from "@/app/lib/vision/askVisionAPI";
import { rescoreSwingAnalysis } from "@/app/golf/scoring/phaseGuardrails";
import { extractPoseKeypointsFromImages } from "@/app/lib/vision/extractPoseKeypoints";
import OpenAI from "openai";
import sharp from "sharp";

export const runtime = "nodejs";

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

function buildLineThroughUnitBox(params: {
  anchor: { x: number; y: number };
  dir: { x: number; y: number };
}): { x1: number; y1: number; x2: number; y2: number } | null {
  const { anchor, dir } = params;
  if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || !Number.isFinite(dir.x) || !Number.isFinite(dir.y)) return null;
  const len = Math.hypot(dir.x, dir.y);
  if (len < 1e-6) return null;
  const ux = dir.x / len;
  const uy = dir.y / len;

  const points: Array<{ x: number; y: number }> = [];
  const pushIfIn = (x: number, y: number) => {
    if (x < -1e-6 || x > 1 + 1e-6 || y < -1e-6 || y > 1 + 1e-6) return;
    points.push({ x: clamp(x, 0, 1), y: clamp(y, 0, 1) });
  };

  if (Math.abs(ux) > 1e-6) {
    const t0 = (0 - anchor.x) / ux;
    pushIfIn(0, anchor.y + t0 * uy);
    const t1 = (1 - anchor.x) / ux;
    pushIfIn(1, anchor.y + t1 * uy);
  }
  if (Math.abs(uy) > 1e-6) {
    const t0 = (0 - anchor.y) / uy;
    pushIfIn(anchor.x + t0 * ux, 0);
    const t1 = (1 - anchor.y) / uy;
    pushIfIn(anchor.x + t1 * ux, 1);
  }

  const uniq: Array<{ x: number; y: number }> = [];
  for (const p of points) {
    if (!uniq.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.02)) uniq.push(p);
  }
  if (uniq.length < 2) return null;

  let best: { a: { x: number; y: number }; b: { x: number; y: number }; d: number } | null = null;
  for (let i = 0; i < uniq.length; i += 1) {
    for (let j = i + 1; j < uniq.length; j += 1) {
      const d = Math.hypot(uniq[i]!.x - uniq[j]!.x, uniq[i]!.y - uniq[j]!.y);
      if (!best || d > best.d) best = { a: uniq[i]!, b: uniq[j]!, d };
    }
  }
  if (!best) return null;
  return { x1: best.a.x, y1: best.a.y, x2: best.b.x, y2: best.b.y };
}

function toPosePoint(value: unknown): { x: number; y: number } | null {
  const normalize = (n: number) => clamp(Math.abs(n) > 1.5 ? n / 100 : n, 0, 1);
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 2) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: normalize(x), y: normalize(y) };
  }
  if (typeof value !== "object") return null;
  const v = value as { x?: unknown; y?: unknown; X?: unknown; Y?: unknown; u?: unknown; v?: unknown };
  const x = Number(v.x ?? v.X ?? v.u);
  const y = Number(v.y ?? v.Y ?? v.v);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: normalize(x), y: normalize(y) };
}

function readPosePoint(pose: Record<string, unknown> | null | undefined, names: string[]): { x: number; y: number } | null {
  if (!pose) return null;
  for (const name of names) {
    const direct = toPosePoint((pose as Record<string, unknown>)[name]);
    if (direct) return direct;
  }
  const keypoints = (pose as Record<string, unknown>).keypoints;
  if (Array.isArray(keypoints)) {
    for (const name of names) {
      const found = keypoints.find((k) => k && typeof k === "object" && (k as Record<string, unknown>).name === name);
      const pt = toPosePoint(found);
      if (pt) return pt;
    }
  }
  return null;
}

function computeHandPosition(pose?: Record<string, unknown> | null): { x: number; y: number } | null {
  const lw = readPosePoint(pose, ["leftWrist", "left_wrist", "leftHand", "left_hand"]);
  const rw = readPosePoint(pose, ["rightWrist", "right_wrist", "rightHand", "right_hand"]);
  if (lw && rw) return { x: (lw.x + rw.x) / 2, y: (lw.y + rw.y) / 2 };
  if (lw || rw) return lw || rw || null;

  // Fallbacks when wrists are occluded/blurred: elbows -> shoulders -> hips.
  const le = readPosePoint(pose, ["leftElbow", "left_elbow"]);
  const re = readPosePoint(pose, ["rightElbow", "right_elbow"]);
  if (le && re) return { x: (le.x + re.x) / 2, y: (le.y + re.y) / 2 };
  if (le || re) return le || re || null;

  const ls = readPosePoint(pose, ["leftShoulder", "left_shoulder"]);
  const rs = readPosePoint(pose, ["rightShoulder", "right_shoulder"]);
  if (ls && rs) return { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  if (ls || rs) return ls || rs || null;

  const lh = readPosePoint(pose, ["leftHip", "left_hip"]);
  const rh = readPosePoint(pose, ["rightHip", "right_hip"]);
  if (lh && rh) return { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  return lh || rh || null;
}

function toShaftVector(value: unknown): { x: number; y: number } | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const dx = Number(value[0]);
  const dy = Number(value[1]);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  return { x: dx, y: dy };
}

function averageDirections(v1: { x: number; y: number } | null, v2: { x: number; y: number } | null): { x: number; y: number } | null {
  if (!v1 && !v2) return null;
  if (v1 && !v2) return v1;
  if (!v1 && v2) return v2;
  const a = v1!;
  const b = v2!;
  const la = Math.hypot(a.x, a.y);
  const lb = Math.hypot(b.x, b.y);
  if (la < 1e-6 || lb < 1e-6) return la >= lb ? a : b;
  const ax = a.x / la;
  const ay = a.y / la;
  let bx = b.x / lb;
  let by = b.y / lb;
  const dot = ax * bx + ay * by;
  if (dot < 0) {
    bx *= -1;
    by *= -1;
  }
  const sx = ax + bx;
  const sy = ay + by;
  const ls = Math.hypot(sx, sy);
  if (ls < 1e-6) return { x: ax, y: ay };
  return { x: sx / ls, y: sy / ls };
}

function computeLineEvidenceSegment(
  line: { x1: number; y1: number; x2: number; y2: number },
  evidencePoints: Array<{ x: number; y: number } | null>,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const points = evidencePoints.filter((p): p is { x: number; y: number } => !!p);
  if (!points.length) return null;
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const denom = dx * dx + dy * dy;
  if (denom < 1e-8) return null;

  const tOf = (p: { x: number; y: number }) => ((p.x - line.x1) * dx + (p.y - line.y1) * dy) / denom;
  let minT = Number.POSITIVE_INFINITY;
  let maxT = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    const t = tOf(p);
    if (!Number.isFinite(t)) continue;
    minT = Math.min(minT, t);
    maxT = Math.max(maxT, t);
  }
  if (!Number.isFinite(minT) || !Number.isFinite(maxT)) return null;

  const pad = points.length >= 2 ? 0.06 : 0.12;
  minT = clamp(minT - pad, 0, 1);
  maxT = clamp(maxT + pad, 0, 1);
  if (maxT - minT < 1e-4) {
    const mid = clamp((minT + maxT) / 2, 0, 1);
    minT = clamp(mid - 0.06, 0, 1);
    maxT = clamp(mid + 0.06, 0, 1);
  }

  return {
    x1: clamp(line.x1 + dx * minT, 0, 1),
    y1: clamp(line.y1 + dy * minT, 0, 1),
    x2: clamp(line.x1 + dx * maxT, 0, 1),
    y2: clamp(line.y1 + dy * maxT, 0, 1),
  };
}

function normalizePlaneLine01(value: unknown): { x1: number; y1: number; x2: number; y2: number } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const x1 = readFiniteNumber(v.x1);
  const y1 = readFiniteNumber(v.y1);
  const x2 = readFiniteNumber(v.x2);
  const y2 = readFiniteNumber(v.y2);
  if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
  const to01 = (n: number) => (Math.abs(n) > 1.5 ? n / 100 : n);
  return { x1: clamp(to01(x1), 0, 1), y1: clamp(to01(y1), 0, 1), x2: clamp(to01(x2), 0, 1), y2: clamp(to01(y2), 0, 1) };
}

function medianOf(points: Array<{ x: number; y: number }>): { x: number; y: number } | null {
  if (!points.length) return null;
  const xs = points.map((p) => p.x).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const ys = points.map((p) => p.y).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length || !ys.length) return null;
  const mid = Math.floor(xs.length / 2);
  const x = xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
  const y = ys.length % 2 ? ys[mid]! : (ys[mid - 1]! + ys[mid]!) / 2;
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
}

function averageUnitDirections(vectors: Array<{ x: number; y: number }>): { x: number; y: number } | null {
  const vs = vectors
    .map((v) => {
      const len = Math.hypot(v.x, v.y);
      if (!Number.isFinite(len) || len < 1e-6) return null;
      return { x: v.x / len, y: v.y / len };
    })
    .filter((v): v is { x: number; y: number } => !!v);
  if (!vs.length) return null;
  const ref = vs[0]!;
  let sx = 0;
  let sy = 0;
  for (const v of vs) {
    const dot = ref.x * v.x + ref.y * v.y;
    sx += dot < 0 ? -v.x : v.x;
    sy += dot < 0 ? -v.y : v.y;
  }
  const ls = Math.hypot(sx, sy);
  if (!Number.isFinite(ls) || ls < 1e-6) return ref;
  return { x: sx / ls, y: sy / ls };
}

function wrapAngleRad(a: number) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function computeOnPlaneZoneEval(params: {
  handedness?: "left" | "right" | string | null;
  thetaDeg?: number;
  anchor: { x: number; y: number } | null;
  referenceLine: { x1: number; y1: number; x2: number; y2: number } | null;
  downswingTrace: Array<{ x: number; y: number }>;
}): {
  on_plane_rating: "A" | "B" | "C" | "D";
  zone_stay_ratio: string;
  primary_deviation: "outside" | "inside" | "none";
  key_observation: string;
  coaching_comment: string;
  zone_theta_deg: number;
  zone_stay_ratio_value: number;
} | null {
  // Default zone width is 8–12°, but we may calibrate to address landmarks (e.g., shoulder),
  // so allow a wider range while keeping it bounded.
  const thetaDeg = Number.isFinite(params.thetaDeg as number) ? clamp(Number(params.thetaDeg), 4, 20) : 10;
  const anchor = params.anchor;
  const line = params.referenceLine;
  const pts = params.downswingTrace.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!anchor || !line || pts.length < 2) return null;

  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 1e-6) return null;
  const ux = dx / len;
  const uy = dy / len;
  const baseAng = Math.atan2(uy, ux);
  const thetaRad = (thetaDeg * Math.PI) / 180;

  const n = pts.length;
  const midStart = Math.floor(n * 0.5);
  const midEnd = Math.max(midStart + 1, Math.ceil(n * 0.8));

  let inside = 0;
  let midInside = 0;
  let midTotal = 0;
  let maxAbs = 0;
  let maxSide: number | null = null;

  const sideSign = (p: { x: number; y: number }) => {
    const vx = p.x - anchor.x;
    const vy = p.y - anchor.y;
    // sign of cross(dir, v)
    return ux * vy - uy * vx;
  };

  for (let i = 0; i < n; i += 1) {
    const p = pts[i]!;
    const vx = p.x - anchor.x;
    const vy = p.y - anchor.y;
    const vl = Math.hypot(vx, vy);
    if (!Number.isFinite(vl) || vl < 1e-6) {
      inside += 1;
      if (i >= midStart && i < midEnd) {
        midInside += 1;
        midTotal += 1;
      }
      continue;
    }
    const ang = Math.atan2(vy, vx);
    const d = Math.abs(wrapAngleRad(ang - baseAng));
    const isInside = d <= thetaRad;
    if (isInside) inside += 1;
    else {
      if (d > maxAbs) {
        maxAbs = d;
        maxSide = sideSign(p);
      }
    }
    if (i >= midStart && i < midEnd) {
      midTotal += 1;
      if (isInside) midInside += 1;
    }
  }

  const stayRatio = inside / n;
  const midRatio = midTotal ? midInside / midTotal : stayRatio;
  const stayPct = Math.round(stayRatio * 100);

  const handed = params.handedness === "left" ? "left" : "right";
  const primary = (() => {
    if (maxSide == null || maxAbs <= 1e-6) return "none" as const;
    const s = maxSide;
    const outsideSign = handed === "left" ? -1 : 1;
    return s * outsideSign >= 0 ? ("outside" as const) : ("inside" as const);
  })();

  const rating = (() => {
    // Emphasize mid segment; don't punish early misses too much.
    if (midRatio >= 0.75 && primary !== "outside") return "A" as const;
    if (midRatio >= 0.7 && primary === "none") return "A" as const;
    if (primary === "outside") {
      if (midRatio >= 0.55) return "B" as const;
      return "C" as const;
    }
    if (primary === "inside") return "D" as const;
    // default
    return midRatio >= 0.6 ? ("B" as const) : ("C" as const);
  })();

  const key_observation = (() => {
    if (rating === "A") return `ダウンスイング中盤でゾーン内に収まりやすく、軌道のブレが小さい状態です。`;
    if (rating === "B") return `ゾーン外に出る場面はありますが、中盤ではゾーンに近づきやすい挙動です。`;
    if (rating === "C") return `ダウンスイング中盤でゾーン外（外側）を通りやすく、軌道が外に寄りやすい状態です。`;
    return `ダウンスイング中盤でゾーン外（内側）に落ちやすく、戻りにくい状態です。`;
  })();

  const coaching_comment = (() => {
    if (rating === "A") return `中盤でゾーン中央に留める感覚を維持しつつ、同じ帯の中を通す再現性を優先してください。`;
    if (rating === "B") return `切り返し直後のズレは許容しつつ、中盤でゾーン中央に戻す意識を強めると安定します。`;
    if (rating === "C") return `中盤で手元がゾーンの外側に出やすいので、ゾーン内に戻す幅を確保する意識を持つと改善します。`;
    return `中盤で手元がゾーンの内側に落ち続けやすいので、ゾーンの帯に戻ってくる“通り道”を作る意識が有効です。`;
  })();

  return {
    on_plane_rating: rating,
    zone_stay_ratio: `${stayPct}%`,
    primary_deviation: primary,
    key_observation,
    coaching_comment,
    zone_theta_deg: thetaDeg,
    zone_stay_ratio_value: stayPct,
  };
}

function safeJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizePoint01(value: unknown): { x: number; y: number } | null {
  const obj = safeJsonObject(value);
  if (!obj) return null;
  const x = readFiniteNumber(obj.x);
  const y = readFiniteNumber(obj.y);
  if (x == null || y == null) return null;
  const to01 = (n: number) => (Math.abs(n) > 1.5 ? n / 100 : n);
  return { x: clamp(to01(x), 0, 1), y: clamp(to01(y), 0, 1) };
}

function json<T>(body: T, init: { status: number }) {
  const res = NextResponse.json(body, init);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function isValidAnalysisId(id: string | null | undefined): id is AnalysisId {
  if (!id) return false;
  return /^[A-Za-z0-9_-]{6,200}$/.test(id);
}

const normalizeIndex = (value: unknown): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return rounded >= 1 ? rounded : null;
};

const normalizeIndices = (value: unknown): number[] => {
  if (value == null) return [];
  if (typeof value === "number") {
    const idx = normalizeIndex(value);
    return idx ? [idx] : [];
  }
  if (!Array.isArray(value)) return [];
  const out = value.map((v) => normalizeIndex(v)).filter((v): v is number => v != null);
  return Array.from(new Set(out)).sort((a, b) => a - b);
};

function parseDataUrl(url: string): { mimeType: string; base64: string } | null {
  if (typeof url !== "string") return null;
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const header = url.slice(5, comma);
  const data = url.slice(comma + 1);
  const [mimePart, ...params] = header.split(";");
  if (!params.includes("base64")) return null;
  const mimeType = mimePart || "image/jpeg";
  const base64 = data.replace(/\s+/g, "");
  if (!base64) return null;
  return { mimeType, base64 };
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

function coerceScore0to20(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(20, Math.round(n)));
}

function parseSinglePhaseResult(raw: unknown): { score: number; good: string[]; issues: string[]; advice: string[] } {
  if (!raw || typeof raw !== "object") return { score: 0, good: [], issues: [], advice: [] };
  const obj = raw as Record<string, unknown>;
  return {
    score: coerceScore0to20(obj.score),
    good: coerceStringArray(obj.good).slice(0, 4),
    issues: coerceStringArray(obj.issues).slice(0, 4),
    advice: coerceStringArray(obj.advice).slice(0, 4),
  };
}

type JudgeConfidence = "high" | "medium" | "low" | null;
type OutsideInJudge = { value: boolean; confidence: JudgeConfidence } | null;

function parseOutsideInJudge(raw: unknown): OutsideInJudge {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const rawValue = obj.outsideIn ?? obj.outside_in ?? obj["outside-in"] ?? obj.result ?? null;
  let value: boolean | null = null;
  if (typeof rawValue === "boolean") value = rawValue;
  else if (typeof rawValue === "string") {
    const t = rawValue.trim().toLowerCase();
    if (t === "true") value = true;
    if (t === "false") value = false;
  } else if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    value = rawValue >= 1;
  }

  const confRaw = obj.confidence;
  const confidence = confRaw === "high" || confRaw === "medium" || confRaw === "low" ? (confRaw as JudgeConfidence) : null;
  if (typeof value !== "boolean") return null;
  return { value, confidence };
}

function buildOverrideSig(indices: {
  address: number[];
  backswing: number[];
  top: number[];
  downswing: number[];
  impact: number[];
  finish: number[];
}) {
  // Keep stable across equivalent selections.
  const join = (xs: number[]) => xs.join(",");
  return `ad:${join(indices.address)}|bs:${join(indices.backswing)}|top:${join(indices.top)}|ds:${join(indices.downswing)}|imp:${join(indices.impact)}|fin:${join(indices.finish)}`;
}

const PHASE_REEVAL_VERSION = "v2025-12-31-address-clubhead-zone-v68-address-frame-v6-hip-cap";

async function judgeOutsideIn(frames: PhaseFrame[], args: { handedness?: string; clubType?: string; level?: string }): Promise<OutsideInJudge> {
  if (!frames.length) return null;
  const metaLines = [
    `利き手: ${args.handedness === "left" ? "左打ち" : "右打ち"}`,
    `クラブ: ${args.clubType ?? "unknown"}`,
    `レベル: ${args.level ?? "unknown"}`,
  ].join("\n");

  const prompt = [
    "あなたはゴルフスイングの判定専用AIです。",
    "提供されたフレーム画像のみを根拠に、Downswing（切り返し〜下ろし）の軌道がアウトサイドインかどうかを判定してください。",
    "迷った場合は false にしてください（グレーは false）。",
    "",
    "補足情報:",
    metaLines,
    "",
    "必ずJSONのみで返してください：",
    '{ "outsideIn": true/false, "confidence": "high"|"medium"|"low", "evidence": ["根拠1","根拠2"] }',
  ].join("\n");

  const raw = await askVisionAPI({ frames: frames.slice(0, 8), prompt }).catch(() => null);
  return parseOutsideInJudge(raw);
}

function postprocessSinglePhaseResult(args: { phaseLabel: string; result: { score: number; good: string[]; issues: string[]; advice: string[] } }) {
  const { phaseLabel, result } = args;
  const goodCount = result.good.filter((t) => t.trim().length > 0).length;

  if (phaseLabel === "ダウンスイング") {
    const dropGenericAdviceWhenNoIssues = () => {
      if (result.issues.length) return;
      result.advice = result.advice.filter(
        (t) =>
          !/インサイド|内側|手元.*先行|フェース.*開|アウトサイドイン|外から|カット軌道|かぶせ|上から|連動|同調/.test(String(t))
      );
    };
    // Soft "要確認" alone is not enough evidence to keep the score low.
    if (result.issues.length === 1 && /外から入りやすい傾向/.test(result.issues[0]) && goodCount >= 2) {
      result.issues = [];
      result.score = Math.max(result.score, 18);
      dropGenericAdviceWhenNoIssues();
    }
    // If issues are empty but score is still low, lift it to match the rubric.
    if (!result.issues.length && goodCount >= 2 && result.score < 18) {
      result.score = 20;
      dropGenericAdviceWhenNoIssues();
    }
  }

  if (phaseLabel === "インパクト") {
    const dropGenericAdviceWhenNoIssues = () => {
      if (result.issues.length) return;
      result.advice = result.advice.filter((t) => !/骨盤|前傾|早期伸展|腰.*前|スペース.*潰|軸|体幹/.test(String(t)));
    };
    // If early extension is mentioned without "(確定)", keep it as "要確認" and avoid harsh scoring.
    if (result.issues.some((t) => /早期伸展/.test(t)) && !result.issues.some((t) => /早期伸展（確定）/.test(t))) {
      result.issues = result.issues.map((t) => (/早期伸展/.test(t) ? "早期伸展の懸念" : t));
      result.score = Math.max(result.score, 11);
    }
    // If it's only a soft "要確認" note and otherwise all-positive, don't treat it as a real defect.
    if (result.issues.length === 1 && /早期伸展の懸念/.test(result.issues[0]) && goodCount >= 2) {
      result.issues = [];
      result.score = Math.max(result.score, 20);
      dropGenericAdviceWhenNoIssues();
    }
    if (!result.issues.length && goodCount >= 2 && result.score < 20) {
      result.score = 20;
      dropGenericAdviceWhenNoIssues();
    }
  }

  return result;
}

function buildPhasePrompt(args: { phaseLabel: string; handedness?: string; clubType?: string; level?: string }) {
  const metaLines = [
    `利き手: ${args.handedness === "left" ? "左打ち" : "右打ち"}`,
    `クラブ: ${args.clubType ?? "unknown"}`,
    `レベル: ${args.level ?? "unknown"}`,
  ].join("\n");

  const mustCheckLines: string[] = [];
  if (args.phaseLabel === "ダウンスイング") {
    mustCheckLines.push(
      `【重要チェック（省略不可）】`,
      `- クラブ軌道が「アウトサイドイン（確定）」か、「外から入りやすい傾向」かを必ず判定する。`,
      `- 確定できる場合のみ issues に必ず「アウトサイドイン（確定）」を含め、score は 0〜8 に収める。`,
      `- 外から入りそうな傾向が“見える”程度なら issues に「外から入りやすい傾向」を含め、score は 9〜12 に収める（確定と書かない）。`,
      `- 判断できない場合は、その文言を書かない（無理に当てはめない）。`
    );
  }
  if (args.phaseLabel === "インパクト") {
    mustCheckLines.push(
      `【重要チェック（省略不可）】`,
      `- 「早期伸展（骨盤が前に出る／前傾が起きる／スペースが潰れる）」に該当するか必ず判定する。`,
      `- 確定できる場合のみ issues に必ず「早期伸展（確定）」を含める。`,
      `- 懸念レベルの場合は issues に「早期伸展の懸念」を含める（確定と書かない）。`,
      `- 確定の場合 score は 0〜12（明確なら 0〜10）に収める。要確認の場合は 11〜15 を目安にし、過剰に減点しない。`
    );
  }

  return [
    `あなたはゴルフスイングの分析専門AIです。`,
    `これから提示する画像フレームは「${args.phaseLabel}」に該当するフレームです。`,
    `このフレーム群“のみ”を根拠に、${args.phaseLabel}の評価を返してください（一般論は禁止）。`,
    ``,
    `補足情報:`,
    metaLines,
    mustCheckLines.length ? `` : null,
    ...mustCheckLines,
    ``,
    `必ずJSONのみで返してください（前後の文章は禁止）。`,
    `出力形式:`,
    `{`,
    `  "score": 0〜20の数値,`,
    `  "good": ["良い点1","良い点2"],`,
    `  "issues": ["改善点1","改善点2"],`,
    `  "advice": ["アドバイス1","アドバイス2"]`,
    `}`,
  ].join("\n");
}

function buildOnPlanePrompt(args: { handedness?: string; clubType?: string; level?: string }) {
  const metaLines = [
    `利き手: ${args.handedness === "left" ? "左打ち" : "右打ち"}`,
    `クラブ: ${args.clubType ?? "unknown"}`,
    `レベル: ${args.level ?? "unknown"}`,
  ].join("\n");

  return [
    `あなたはゴルフスイングの判定専用AIです。`,
    `これから提示する画像は Top → Downswing → Impact の順です。`,
    `画像だけを根拠に「オンプレーン一致度」と「フェーズ別のズレ（cm）」を推定してください（正確さより理解優先の粗い推定でOK）。`,
    ``,
    `符号ルール:`,
    `- +（プラス）: プレーンより外側（アウトサイド寄り）`,
    `- -（マイナス）: プレーンより内側（インサイド寄り）`,
    ``,
    `補足情報:`,
    metaLines,
    ``,
    `必ずJSONのみで返してください（前後の文章は禁止）。`,
    `出力形式:`,
    `{`,
    `  "score": 0〜100の数値,`,
    `  "summary": "1文サマリ（cm/deg/度などの単位や数値の記載は禁止）",`,
    `  "top_to_downswing_cm": 数値（cm, 小数OK, 符号あり）,`,
    `  "late_downswing_cm": 数値（cm, 小数OK, 符号あり）,`,
    `  "impact_cm": 数値（cm, 小数OK, 符号あり）,`,
    `  "backswing_plane": { "x1": 0〜1, "y1": 0〜1, "x2": 0〜1, "y2": 0〜1 },`,
    `  "downswing_plane": { "x1": 0〜1, "y1": 0〜1, "x2": 0〜1, "y2": 0〜1 }`,
    `}`,
  ].join("\n");
}

function readFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return n;
}

function parseOnPlane(
  raw: unknown
): (Record<string, unknown> & {
  score: number;
  summary: string;
  top_to_downswing_cm: number;
  late_downswing_cm: number;
  impact_cm: number;
}) | null {
  const obj =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : typeof raw === "string"
        ? (() => {
            try {
              return JSON.parse(raw) as Record<string, unknown>;
            } catch {
              return null;
            }
          })()
        : null;
  if (!obj) return null;

  const scoreRaw = readFiniteNumber(obj.score);
  const tds = readFiniteNumber(obj.top_to_downswing_cm ?? obj.topToDownswingCm ?? obj.top_to_downswing);
  const late = readFiniteNumber(obj.late_downswing_cm ?? obj.lateDownswingCm ?? obj.downswing_late_cm ?? obj.downswingLateCm);
  const imp = readFiniteNumber(obj.impact_cm ?? obj.impactCm ?? obj.impact);
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";

  if (scoreRaw == null || tds == null || late == null || imp == null) return null;
  return {
    score: clamp(Math.round(scoreRaw), 0, 100),
    summary: summary.slice(0, 120),
    top_to_downswing_cm: clamp(tds, -50, 50),
    late_downswing_cm: clamp(late, -50, 50),
    impact_cm: clamp(imp, -50, 50),
    ...(obj.backswing_plane && typeof obj.backswing_plane === "object" ? { backswing_plane: obj.backswing_plane } : null),
    ...(obj.downswing_plane && typeof obj.downswing_plane === "object" ? { downswing_plane: obj.downswing_plane } : null),
  };
}

function computeTotalScoreFromPhases(phases: Record<string, { score?: number }>): number {
  const keys = ["address", "backswing", "top", "downswing", "impact", "finish"] as const;
  const sum = keys.reduce((acc, k) => acc + (Number(phases[k]?.score) || 0), 0);
  return Math.max(0, Math.min(100, Math.round((sum / (keys.length * 20)) * 100)));
}

function promoteHighNoIssueScores(phases: Record<string, { score?: number; good?: string[]; issues?: string[]; advice?: string[] }>) {
  const promote = (key: "downswing" | "impact") => {
    const phase = phases[key];
    if (!phase) return;
    const goodCount = Array.isArray(phase.good) ? phase.good.filter((t) => typeof t === "string" && t.trim().length > 0).length : 0;
    const issuesCount = Array.isArray(phase.issues)
      ? phase.issues.filter((t) => typeof t === "string" && t.trim().length > 0).length
      : 0;
    const score = Number(phase.score) || 0;
    // Only bump when the model already considers it very high but forgot to give full marks,
    // and there are no issues listed (i.e., no explicit defects to justify the gap).
    if (issuesCount === 0 && goodCount >= 2 && score >= 18) {
      phase.score = 20;
    }
  };
  promote("downswing");
  promote("impact");
  return phases;
}

async function loadAuthorizedAnalysis(req: NextRequest, analysisId: AnalysisId) {
  const { anonymousUserId: tokenAnonymous } = readAnonymousFromRequest(req);
  const emailSession = readEmailSessionFromRequest(req);
  const activeAuth = readActiveAuthFromRequest(req) ?? (emailSession ? "email" : null);

  let account = null as Awaited<ReturnType<typeof getUserById>> | null;
  if (activeAuth !== "email") {
    const session = await auth();
    const sessionUserId = session?.user?.id ?? null;
    account = sessionUserId ? await getUserById(sessionUserId) : null;
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
  const effectiveUserId = account?.userId ?? null;

  if (!effectiveUserId && !tokenAnonymous) {
    return { error: "not found" as const, account: null as typeof account };
  }

  const stored = await getAnalysis(analysisId);
  if (!stored) return { error: "not found" as const, account };

  if (effectiveUserId) {
    const user = await getUserById(effectiveUserId);
    if (!user) return { error: "not found" as const, account };
    const recordHasUser = stored.userId != null;
    const ownsByUser = recordHasUser && stored.userId === user.userId;
    const ownsByLinkedAnonymous =
      !recordHasUser &&
      !!stored.anonymousUserId &&
      Array.isArray(user.anonymousIds) &&
      user.anonymousIds.includes(stored.anonymousUserId);
    if (!ownsByUser && !ownsByLinkedAnonymous) return { error: "not found" as const, account };
  } else {
    if (stored.userId != null || !stored.anonymousUserId || stored.anonymousUserId !== tokenAnonymous) {
      return { error: "not found" as const, account };
    }
  }

  return { stored, account, error: null };
}

async function analyzeSinglePhase(
  frames: PhaseFrame[],
  args: { phaseLabel: string; handedness?: string; clubType?: string; level?: string }
) {
  const prompt = buildPhasePrompt(args);
  const raw = await askVisionAPI({ frames, prompt });
  const parsed = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
  return postprocessSinglePhaseResult({ phaseLabel: args.phaseLabel, result: parseSinglePhaseResult(parsed) });
}

async function extractGripCentersFromFrames(params: {
  frames: PhaseFrame[];
}): Promise<Array<{ idx: number; grip: { x: number; y: number } | null }>> {
  // NOTE: We avoid askVisionAPI here because its system prompt is tuned for Japanese "analysis".
  // This is a strict extraction call with a dedicated system instruction for stability.
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set (grip extraction)");

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_API_BASE ?? undefined,
  });

  type OpenAIRequestMessageContent =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" } };

  const SYSTEM_PROMPT = `
You are a vision model. Locate the golfer's grip center (hands on the club) for each image.

For EACH input image, return:
- idx: the image index (0-based, same order as provided)
- grip_point: {x,y} in normalized [0,1] (origin = top-left), or null if the grip area is not visible in that frame.

Rules:
- Do NOT reuse the same coordinates across frames; estimate each frame independently.
- If the grip is visible but blurry, still estimate (do not return null).
- Keep all x,y within [0,1].

Return JSON only:
{ "frames": [ { "idx": 0, "grip_point": { "x": 0.0, "y": 0.0 } | null }, ... ] }`;

  const content: OpenAIRequestMessageContent[] = [
    {
      type: "text",
      text: `Return JSON only. frames.length must equal ${params.frames.length}. idx must be 0..${params.frames.length - 1}.`,
    },
  ];
  params.frames.forEach((f, idx) => {
    content.push({ type: "text", text: `frame #${idx}` });
    content.push({
      type: "image_url",
      image_url: { url: `data:${f.mimeType};base64,${f.base64Image}`, detail: "high" },
    });
  });

  const result = await client.chat.completions.create({
    model: process.env.OPENAI_POSE_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ],
    temperature: 0.0,
    max_tokens: 2048,
    response_format: { type: "json_object" },
  });

  const structured = result.choices?.[0]?.message?.content ?? null;
  const parsed =
    typeof structured === "string"
      ? (() => {
          try {
            return JSON.parse(structured);
          } catch {
            return null;
          }
        })()
      : structured;
  const obj = safeJsonObject(parsed);
  const arr = obj && Array.isArray(obj.frames) ? (obj.frames as unknown[]) : [];
  const out: Array<{ idx: number; grip: { x: number; y: number } | null }> = [];
  for (let i = 0; i < arr.length; i += 1) {
    const e = safeJsonObject(arr[i]);
    if (!e) continue;
    const idx = Number(e.idx);
    const finalIdx = Number.isFinite(idx) ? idx : i;
    const grip = normalizePoint01(e.grip_point ?? e.gripPoint);
    out.push({ idx: finalIdx, grip });
  }
  return out.sort((a, b) => a.idx - b.idx);
}

async function extractAddressPoseLandmarks(
  frame: PhaseFrame,
  handedness?: string | null,
): Promise<{ shoulder: { x: number; y: number } | null; hip: { x: number; y: number } | null } | null> {
  if (!frame?.base64Image || !frame?.mimeType) return null;
  try {
    const poseFrames = await extractPoseKeypointsFromImages({
      frames: [{ base64Image: frame.base64Image, mimeType: frame.mimeType }],
    });
    const first = poseFrames[0];
    const pose = (first?.pose as Record<string, unknown> | null | undefined) ?? null;
    if (!pose) return null;
    const side = handedness === "left" ? "left" : "right";
    const shoulder = readPosePoint(pose, [`${side}Shoulder`, `${side}_shoulder`]);
    const hip = readPosePoint(pose, [`${side}Hip`, `${side}_hip`]);
    if (!shoulder && !hip) return null;
    return { shoulder, hip };
  } catch {
    return null;
  }
}

async function refineGripCentersWithRoi(params: {
  frames: PhaseFrame[];
  initial: Array<{ idx: number; grip: { x: number; y: number } | null }>;
  anchor?: { x: number; y: number } | null;
}): Promise<{
  refined: Array<{ idx: number; grip: { x: number; y: number } | null }>;
  refinedCount: number;
  refinedFrames: number;
}> {
  const { frames, initial, anchor } = params;
  const byIdx = new Map<number, { idx: number; grip: { x: number; y: number } | null }>();
  initial.forEach((e, i) => {
    const idx = Number.isFinite(e.idx) ? e.idx : i;
    byIdx.set(idx, { idx, grip: e.grip ?? null });
  });
  for (let i = 0; i < frames.length; i += 1) {
    if (!byIdx.has(i)) byIdx.set(i, { idx: i, grip: null });
  }

  const getNearestGrip = (idx: number): { x: number; y: number } | null => {
    let best: { x: number; y: number } | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    byIdx.forEach((val, key) => {
      if (!val.grip) return;
      const d = Math.abs(key - idx);
      if (d < bestDist) {
        bestDist = d;
        best = val.grip;
      }
    });
    return best ?? null;
  };

  const targets: Array<{ idx: number; frame: PhaseFrame }> = [];
  byIdx.forEach((val, idx) => {
    if (val.grip) return;
    const frame = frames[idx];
    if (!frame) return;
    const hint = getNearestGrip(idx) ?? anchor ?? null;
    if (!hint) return;
    targets.push({ idx, frame });
  });

  if (!targets.length) {
    return { refined: Array.from(byIdx.values()).sort((a, b) => a.idx - b.idx), refinedCount: 0, refinedFrames: 0 };
  }

  const croppedFrames: PhaseFrame[] = [];
  const croppedMeta: Array<{ idx: number; roi: RoiBox }> = [];
  for (const target of targets) {
    const hint = getNearestGrip(target.idx) ?? anchor ?? null;
    if (!hint) continue;
    const cropped = await cropFrameAroundPoint(target.frame, hint, 0.62);
    if (!cropped) continue;
    croppedFrames.push(cropped.frame);
    croppedMeta.push({ idx: target.idx, roi: cropped.roi });
  }

  if (!croppedFrames.length) {
    return { refined: Array.from(byIdx.values()).sort((a, b) => a.idx - b.idx), refinedCount: 0, refinedFrames: 0 };
  }

  const roiResults = await extractGripCentersFromFrames({ frames: croppedFrames });
  let refinedCount = 0;
  roiResults.forEach((res, i) => {
    const meta = croppedMeta[i];
    if (!meta || !res?.grip) return;
    const mapped = {
      x: clamp(meta.roi.x + meta.roi.w * res.grip.x, 0, 1),
      y: clamp(meta.roi.y + meta.roi.h * res.grip.y, 0, 1),
    };
    byIdx.set(meta.idx, { idx: meta.idx, grip: mapped });
    refinedCount += 1;
  });

  return {
    refined: Array.from(byIdx.values()).sort((a, b) => a.idx - b.idx),
    refinedCount,
    refinedFrames: croppedFrames.length,
  };
}

function pickBestConfidence(values: Array<"high" | "medium" | "low">): "high" | "medium" | "low" {
  const rank = (v: "high" | "medium" | "low") => (v === "high" ? 3 : v === "medium" ? 2 : 1);
  let best: "high" | "medium" | "low" = "low";
  for (const v of values) {
    if (rank(v) > rank(best)) best = v;
  }
  return best;
}

function mergeAddressZones(
  zones: Array<{
    clubhead: { x: number; y: number } | null;
    grip: { x: number; y: number } | null;
    ball: { x: number; y: number } | null;
    shoulder: { x: number; y: number } | null;
    side_shoulder: { x: number; y: number } | null;
    side_hip: { x: number; y: number } | null;
    clubhead_confidence: "high" | "medium" | "low";
    grip_confidence: "high" | "medium" | "low";
    ball_confidence: "high" | "medium" | "low";
    shoulder_confidence: "high" | "medium" | "low";
    debug?: {
      roi?: { x: number; y: number; w: number; h: number };
      roi_ball?: { x: number; y: number; w: number; h: number };
      roi_grip?: { x: number; y: number; w: number; h: number };
      roi_status?: "ok" | "crop_failed" | "error";
      roi_error?: string;
      candidate_scores?: Array<{
        source?: string;
        x: number;
        y: number;
        confidence: "high" | "medium" | "low";
        score: number | null;
        skipped?: boolean;
      }>;
      chosen_source?: string | null;
      shaft_dir?: { x: number; y: number } | null;
      hough_line?: { anchor: { x: number; y: number }; dir: { x: number; y: number }; score: number } | null;
    };
  }>
) {
  if (!zones.length) return null;
  const clubheads = zones.map((z) => z.clubhead).filter((p): p is { x: number; y: number } => !!p);
  const grips = zones.map((z) => z.grip).filter((p): p is { x: number; y: number } => !!p);
  const balls = zones.map((z) => z.ball).filter((p): p is { x: number; y: number } => !!p);
  const shoulders = zones.map((z) => z.shoulder).filter((p): p is { x: number; y: number } => !!p);
  const sideShoulders = zones.map((z) => z.side_shoulder).filter((p): p is { x: number; y: number } => !!p);
  const sideHips = zones.map((z) => z.side_hip).filter((p): p is { x: number; y: number } => !!p);
  const pickZoneScore = (z: {
    debug?: {
      candidate_scores?: Array<{
        source?: string;
        x: number;
        y: number;
        confidence: "high" | "medium" | "low";
        score: number | null;
        skipped?: boolean;
      }>;
      chosen_source?: string | null;
    };
  }): number | null => {
    const scores = z.debug?.candidate_scores ?? null;
    if (!scores || !scores.length) return null;
    const chosen = z.debug?.chosen_source ?? null;
    const chosenEntry = chosen ? scores.find((s) => s.source === chosen) : null;
    const picked = chosenEntry ?? scores.find((s) => s.score != null && !s.skipped) ?? null;
    return picked?.score ?? null;
  };
  const bestZone = (() => {
    if (!zones.length) return null;
    const rank = (v: "high" | "medium" | "low") => (v === "high" ? 3 : v === "medium" ? 2 : 1);
    let best = zones[0]!;
    let bestRank = rank(best.clubhead_confidence);
    let bestScore = pickZoneScore(best);
    for (const z of zones.slice(1)) {
      const r = rank(z.clubhead_confidence);
      if (r > bestRank) {
        best = z;
        bestRank = r;
        bestScore = pickZoneScore(z);
        continue;
      }
      if (r === bestRank) {
        const s = pickZoneScore(z);
        if (s != null && (bestScore == null || s < bestScore)) {
          best = z;
          bestScore = s;
        }
      }
    }
    return best;
  })();
  const clubhead = bestZone?.clubhead ?? medianOf(clubheads);
  const grip = medianOf(grips);
  const ball = medianOf(balls);
  const shoulder = medianOf(shoulders);
  const side_shoulder = medianOf(sideShoulders);
  const side_hip = medianOf(sideHips);
  const clubhead_confidence = pickBestConfidence(
    zones.filter((z) => z.clubhead).map((z) => z.clubhead_confidence)
  );
  const grip_confidence = pickBestConfidence(
    zones.filter((z) => z.grip).map((z) => z.grip_confidence)
  );
  const ball_confidence = pickBestConfidence(
    zones.filter((z) => z.ball).map((z) => z.ball_confidence)
  );
  const shoulder_confidence = pickBestConfidence(
    zones.filter((z) => z.shoulder).map((z) => z.shoulder_confidence)
  );
  const baseDebug = zones.find((z) => z.debug)?.debug ?? null;
  const samples = zones.slice(0, 3).map((z) => ({
    clubhead: z.clubhead,
    grip: z.grip,
    ball: z.ball,
    shoulder: z.shoulder,
  }));
  const debug = baseDebug ? { ...baseDebug, frame_count: zones.length, samples } : { frame_count: zones.length, samples };
  if (!clubhead && !grip && !ball && !shoulder) return null;
  return {
    clubhead,
    grip,
    ball,
    shoulder,
    side_shoulder,
    side_hip,
    clubhead_confidence,
    grip_confidence,
    ball_confidence,
    shoulder_confidence,
    debug,
  };
}

async function detectAddressSidePoints(
  frame: PhaseFrame,
  handedness?: string | null,
): Promise<{ sideShoulder: { x: number; y: number } | null; sideHip: { x: number; y: number } | null } | null> {
  const sideLabel = handedness === "left" ? "左打ち（左肩/左腰）" : "右打ち（右肩/右腰）";
  const prompt = `
あなたはゴルフスイング解析の補助AIです。
目的：アドレス（構え）画像から利き手側の肩と腰の位置を特定する。
利き手: ${sideLabel}

制約：
- 画像に写っているものだけを根拠にする（推測で作らない）
- 見えない場合は null を返す
- 出力は JSON のみ

出力JSON:
{
  "side_shoulder_point": { "x": 0.0, "y": 0.0 } | null,
  "side_hip_point": { "x": 0.0, "y": 0.0 } | null
}

座標は画像内の正規化座標（左上が(0,0)、右下が(1,1)）。
利き手側の肩と腰が不明確なら null。
`;
  const raw = await askVisionAPI({ frames: [frame], prompt });
  const obj = safeJsonObject(raw);
  if (!obj) return null;
  const side = handedness === "left" ? "left" : "right";
  const sideShoulder =
    normalizePoint01(obj.side_shoulder_point ?? obj.sideShoulderPoint) ??
    normalizePoint01((obj as Record<string, unknown>)[`${side}_shoulder_point`] ?? (obj as Record<string, unknown>)[`${side}ShoulderPoint`]);
  const sideHip =
    normalizePoint01(obj.side_hip_point ?? obj.sideHipPoint) ??
    normalizePoint01((obj as Record<string, unknown>)[`${side}_hip_point`] ?? (obj as Record<string, unknown>)[`${side}HipPoint`]);
  if (!sideShoulder && !sideHip) return null;
  return { sideShoulder: sideShoulder ?? null, sideHip: sideHip ?? null };
}

async function detectAddressZoneFromAddressFrame(
  frame: PhaseFrame,
  handedness?: string | null,
): Promise<{
  clubhead: { x: number; y: number } | null;
  grip: { x: number; y: number } | null;
  ball: { x: number; y: number } | null;
  shoulder: { x: number; y: number } | null;
  side_shoulder: { x: number; y: number } | null;
  side_hip: { x: number; y: number } | null;
  clubhead_confidence: "high" | "medium" | "low";
  grip_confidence: "high" | "medium" | "low";
  ball_confidence: "high" | "medium" | "low";
  shoulder_confidence: "high" | "medium" | "low";
  debug?: {
    roi?: { x: number; y: number; w: number; h: number };
    frame_count?: number;
    samples?: Array<{
      clubhead?: { x: number; y: number } | null;
      grip?: { x: number; y: number } | null;
      ball?: { x: number; y: number } | null;
      shoulder?: { x: number; y: number } | null;
    }>;
    roi_ball?: { x: number; y: number; w: number; h: number };
    roi_grip?: { x: number; y: number; w: number; h: number };
    roi_status?: "ok" | "crop_failed" | "error";
    roi_error?: string;
    candidate_scores?: Array<{
      source?: string;
      x: number;
      y: number;
      confidence: "high" | "medium" | "low";
      score: number | null;
      skipped?: boolean;
    }>;
    chosen_source?: string | null;
    shaft_dir?: { x: number; y: number } | null;
    hough_line?: { anchor: { x: number; y: number }; dir: { x: number; y: number }; score: number } | null;
  };
} | null> {
  const prompt = `
あなたはゴルフスイング解析の補助AIです。
目的：アドレス（構え）画像から「クラブヘッド中心」と「グリップ中心（手元）」を特定し、参照プレーン（アドレスのシャフト方向）の始点と方向を作る。

制約：
- 画像に写っているものだけを根拠にする（推測で作らない）
- 見えない場合は null を返す
- 出力は JSON のみ

出力JSON:
{
  "clubhead_point": { "x": 0.0, "y": 0.0 } | null,
  "grip_point": { "x": 0.0, "y": 0.0 } | null,
  "ball_point": { "x": 0.0, "y": 0.0 } | null,
  "shoulder_center": { "x": 0.0, "y": 0.0 } | null,
  "clubhead_confidence": "high" | "medium" | "low",
  "grip_confidence": "high" | "medium" | "low",
  "ball_confidence": "high" | "medium" | "low",
  "shoulder_confidence": "high" | "medium" | "low"
}

座標は画像内の正規化座標（左上が(0,0)、右下が(1,1)）。
クラブヘッドやグリップが判別できない場合は null にしてください（適当に置かない）。

重要：
- clubhead_point は「シャフト先端の黒いクラブヘッド中心」を返してください。ボールと同一点に置かないでください。
- grip_point は両手の間（グリップ中心）を優先してください。
- ball_point はボール中心（地面付近）を返してください。ボールが見えない場合は null にしてください。
- shoulder_center は両肩の中心（左右肩の中点）を返してください。肩が不明確なら null。
`;

  const raw = await askVisionAPI({ frames: [frame], prompt });
  const obj = safeJsonObject(raw);
  if (!obj) return null;
  let clubhead = normalizePoint01(obj.clubhead_point ?? obj.clubheadPoint);
  const grip = normalizePoint01(obj.grip_point ?? obj.gripPoint);
  const ball = normalizePoint01(obj.ball_point ?? obj.ballPoint);
  const shoulder = normalizePoint01(obj.shoulder_center ?? obj.shoulderCenter);
  let sideShoulder: { x: number; y: number } | null = null;
  let sideHip: { x: number; y: number } | null = null;
  {
    const effectiveHandedness = handedness ?? "right";
    const sidePoints = await detectAddressSidePoints(frame, effectiveHandedness);
    sideShoulder = sidePoints?.sideShoulder ?? null;
    sideHip = sidePoints?.sideHip ?? null;
    const poseSide = await extractAddressPoseLandmarks(frame, effectiveHandedness);
    if (poseSide?.shoulder) sideShoulder = poseSide.shoulder;
    if (poseSide?.hip) sideHip = poseSide.hip;
  }
  const cc =
    (obj.clubhead_confidence === "high" || obj.clubhead_confidence === "medium" || obj.clubhead_confidence === "low"
      ? obj.clubhead_confidence
      : "low") as "high" | "medium" | "low";
  const gc =
    (obj.grip_confidence === "high" || obj.grip_confidence === "medium" || obj.grip_confidence === "low"
      ? obj.grip_confidence
      : "low") as "high" | "medium" | "low";
  const bc =
    (obj.ball_confidence === "high" || obj.ball_confidence === "medium" || obj.ball_confidence === "low"
      ? obj.ball_confidence
      : "low") as "high" | "medium" | "low";
  const sc =
    (obj.shoulder_confidence === "high" || obj.shoulder_confidence === "medium" || obj.shoulder_confidence === "low"
      ? obj.shoulder_confidence
      : "low") as "high" | "medium" | "low";
  if (!clubhead && !grip && !ball && !shoulder && !sideShoulder && !sideHip) return null;
  let clubheadConfidence = cc;
  let debug: {
    roi?: { x: number; y: number; w: number; h: number };
    roi_ball?: { x: number; y: number; w: number; h: number };
    roi_grip?: { x: number; y: number; w: number; h: number };
    roi_status?: "ok" | "crop_failed" | "error";
    roi_error?: string;
    candidate_scores?: Array<{
      source?: string;
      x: number;
      y: number;
      confidence: "high" | "medium" | "low";
      score: number | null;
      skipped?: boolean;
    }>;
    chosen_source?: string | null;
    shaft_dir?: { x: number; y: number } | null;
    hough_line?: { anchor: { x: number; y: number }; dir: { x: number; y: number }; score: number } | null;
  } | null = null;
  if (ball && grip) {
    try {
      const shaftVec = await detectAddressShaftVector(frame);
      const roi = await cropFrameAroundBall(frame, ball, grip);
      if (roi) {
        const ballLocal = {
          x: clamp((ball.x - roi.roi.x) / roi.roi.w, 0, 1),
          y: clamp((ball.y - roi.roi.y) / roi.roi.h, 0, 1),
        };
        const gripLocal = {
          x: clamp((grip.x - roi.roi.x) / roi.roi.w, 0, 1),
          y: clamp((grip.y - roi.roi.y) / roi.roi.h, 0, 1),
        };
        const shaftDir = deriveShaftDirection(gripLocal, ballLocal, shaftVec);
        const shaftDirForLine =
          shaftDir ?? normalizeDirection({ x: ballLocal.x - gripLocal.x, y: ballLocal.y - gripLocal.y });
        const expected = estimateClubheadExpectedPoint(ballLocal, gripLocal, shaftDirForLine);
        const roiResult = await detectClubheadInRoi(roi.frame);
        const shaftResult = await detectClubheadAlongShaftInRoi(roi.frame, gripLocal, ballLocal, shaftDirForLine);
        const houghResult = await detectClubheadByHoughShaftInRoi(roi.frame, gripLocal, ballLocal, shaftDirForLine);
        const blobResult = await detectClubheadByDarkBlobOnShaftInRoi(
          roi.frame,
          gripLocal,
          ballLocal,
          shaftDirForLine,
        );
        const patchResult = await detectClubheadByDarkPatchInRoi(roi.frame, ballLocal, gripLocal, shaftDirForLine);
        const pcaResult = await detectClubheadByPcaShaftTipInRoi(roi.frame, gripLocal, ballLocal);
        const darkResult = await detectClubheadByDarkestInRoi(roi.frame, ballLocal, gripLocal);
        const mapFromRoi = (roiBox: RoiBox, pt: { x: number; y: number }) => ({
          x: clamp(roiBox.x + roiBox.w * pt.x, 0, 1),
          y: clamp(roiBox.y + roiBox.h * pt.y, 0, 1),
        });
        const candidates: Array<{ point: { x: number; y: number }; confidence: "high" | "medium" | "low"; source?: string }> = [];
        if (roiResult?.point) candidates.push({ point: mapFromRoi(roi.roi, roiResult.point), confidence: roiResult.confidence ?? clubheadConfidence, source: "roi_main" });
        if (shaftResult?.point) candidates.push({ point: mapFromRoi(roi.roi, shaftResult.point), confidence: "medium", source: "shaft_scan" });
        if (houghResult?.point) candidates.push({ point: mapFromRoi(roi.roi, houghResult.point), confidence: "medium", source: "hough" });
        if (blobResult?.point) candidates.push({ point: mapFromRoi(roi.roi, blobResult.point), confidence: "medium", source: "dark_blob" });
        if (patchResult?.point) candidates.push({ point: mapFromRoi(roi.roi, patchResult.point), confidence: "medium", source: "dark_patch" });
        if (pcaResult?.point) candidates.push({ point: mapFromRoi(roi.roi, pcaResult.point), confidence: "medium", source: "pca" });
        if (darkResult?.point) candidates.push({ point: mapFromRoi(roi.roi, darkResult.point), confidence: "medium", source: "darkest" });
        if (expected) candidates.push({ point: mapFromRoi(roi.roi, expected), confidence: "low", source: "expected_roi" });
        const expectedGlobal = estimateClubheadExpectedPoint(ball, grip, shaftDirForLine);
        const shaftLineGlobal = shaftDirForLine ? { anchor: grip, dir: shaftDirForLine } : null;

        const ballCrop = ball ? await cropFrameAroundPoint(frame, ball, 0.58) : null;
        const gripCrop = grip ? await cropFrameAroundPoint(frame, grip, 0.58) : null;
        if (ballCrop?.roi) {
          const extra = await detectClubheadInRoi(ballCrop.frame);
          if (extra?.point) {
            candidates.push({
              point: mapFromRoi(ballCrop.roi, extra.point),
              confidence: extra.confidence ?? "low",
              source: "roi_ball",
            });
          }
        }
        if (gripCrop?.roi) {
          const extra = await detectClubheadInRoi(gripCrop.frame);
          if (extra?.point) {
            candidates.push({
              point: mapFromRoi(gripCrop.roi, extra.point),
              confidence: extra.confidence ?? "low",
              source: "roi_grip",
            });
          }
        }

        const selection = selectBestClubheadCandidate(
          candidates,
          expectedGlobal,
          ball,
          shaftLineGlobal,
        );
        let chosenConf = clubheadConfidence;
        if (selection.best) {
          chosenConf = selection.best.confidence;
        }
        if (selection.best?.point) {
          clubhead = selection.best.point;
          clubheadConfidence = chosenConf;
        }
        debug = {
          roi: { x: roi.roi.x, y: roi.roi.y, w: roi.roi.w, h: roi.roi.h },
          roi_ball: ballCrop?.roi ? { x: ballCrop.roi.x, y: ballCrop.roi.y, w: ballCrop.roi.w, h: ballCrop.roi.h } : undefined,
          roi_grip: gripCrop?.roi ? { x: gripCrop.roi.x, y: gripCrop.roi.y, w: gripCrop.roi.w, h: gripCrop.roi.h } : undefined,
          roi_status: "ok",
          candidate_scores: selection.scores
            .map((s) => ({
              source: s.source ?? "unknown",
              x: Number(s.point.x.toFixed(4)),
              y: Number(s.point.y.toFixed(4)),
              confidence: s.confidence,
              score: Number.isFinite(s.score) ? Number(s.score.toFixed(4)) : null,
              skipped: s.skipped ?? false,
            }))
            .sort((a, b) => (a.score ?? 999) - (b.score ?? 999)),
          chosen_source: selection.best?.source ?? null,
          shaft_dir: shaftDirForLine ?? null,
          hough_line: houghResult?.line ?? null,
        };
      } else {
        debug = { roi_status: "crop_failed" };
      }
    } catch (e) {
      debug = {
        roi_status: "error",
        roi_error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
      };
    }
  }
  return {
    clubhead,
    grip,
    ball,
    shoulder,
    side_shoulder: sideShoulder ?? null,
    side_hip: sideHip ?? null,
    clubhead_confidence: clubheadConfidence,
    grip_confidence: gc,
    ball_confidence: bc,
    shoulder_confidence: sc,
    ...(debug ? { debug } : {}),
  };
}

type RoiBox = {
  left: number;
  top: number;
  width: number;
  height: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

function computeClubheadRoi(ball: { x: number; y: number }, grip: { x: number; y: number }, imgW: number, imgH: number): RoiBox | null {
  if (!Number.isFinite(imgW) || !Number.isFinite(imgH) || imgW <= 0 || imgH <= 0) return null;
  const dx = ball.x - grip.x;
  const dy = ball.y - grip.y;
  const dist = Math.hypot(dx, dy);
  const ux = Number.isFinite(dist) && dist > 1e-6 ? dx / dist : 0;
  const uy = Number.isFinite(dist) && dist > 1e-6 ? dy / dist : 0;
  // Perpendicular to shaft direction; choose the one that points left-down.
  const perpA = { x: -uy, y: ux };
  const perpB = { x: uy, y: -ux };
  const perp = perpA.x <= perpB.x && perpA.y >= perpB.y ? perpA : perpB;
  const shiftSide = clamp(dist * 0.18, 0.03, 0.09);
  const shiftAlong = clamp(dist * 0.08, 0.01, 0.06);
  const centerX = clamp(ball.x - ux * shiftAlong + perp.x * shiftSide, 0, 1);
  const centerY = clamp(ball.y - uy * shiftAlong + perp.y * shiftSide, 0, 1);
  const size = Number.isFinite(dist) && dist > 0.05 ? clamp(dist * 0.6, 0.12, 0.26) : 0.18;
  const width = Math.max(32, Math.round(size * imgW));
  const height = Math.max(32, Math.round(size * imgH));
  const cx = Math.round(centerX * imgW);
  const cy = Math.round(centerY * imgH);
  const left = clamp(Math.round(cx - width / 2), 0, Math.max(0, imgW - width));
  const top = clamp(Math.round(cy - height / 2), 0, Math.max(0, imgH - height));
  return {
    left,
    top,
    width,
    height,
    x: left / imgW,
    y: top / imgH,
    w: width / imgW,
    h: height / imgH,
  };
}

function computePointRoi(
  point: { x: number; y: number },
  imgW: number,
  imgH: number,
  sizeRatio: number,
): RoiBox | null {
  if (!Number.isFinite(imgW) || !Number.isFinite(imgH) || imgW <= 0 || imgH <= 0) return null;
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const minDim = Math.min(imgW, imgH);
  const size = clamp(Math.round(minDim * sizeRatio), 96, minDim);
  const cx = Math.round(clamp(point.x, 0, 1) * imgW);
  const cy = Math.round(clamp(point.y, 0, 1) * imgH);
  const left = clamp(Math.round(cx - size / 2), 0, Math.max(0, imgW - size));
  const top = clamp(Math.round(cy - size / 2), 0, Math.max(0, imgH - size));
  return {
    left,
    top,
    width: size,
    height: size,
    x: left / imgW,
    y: top / imgH,
    w: size / imgW,
    h: size / imgH,
  };
}

async function cropFrameAroundBall(
  frame: PhaseFrame,
  ball: { x: number; y: number },
  grip: { x: number; y: number },
): Promise<{ frame: PhaseFrame; roi: RoiBox } | null> {
  if (!frame?.base64Image || !frame?.mimeType) return null;
  const buffer = Buffer.from(frame.base64Image, "base64");
  const image = sharp(buffer);
  const meta = await image.metadata();
  if (!meta.width || !meta.height) return null;
  const roi = computeClubheadRoi(ball, grip, meta.width, meta.height);
  if (!roi) return null;
  const cropped = await image
    .extract({ left: roi.left, top: roi.top, width: roi.width, height: roi.height })
    .jpeg({ quality: 92 })
    .toBuffer();
  return {
    frame: { base64Image: cropped.toString("base64"), mimeType: "image/jpeg" },
    roi,
  };
}

async function cropFrameAroundPoint(
  frame: PhaseFrame,
  point: { x: number; y: number },
  sizeRatio = 0.58,
): Promise<{ frame: PhaseFrame; roi: RoiBox } | null> {
  if (!frame?.base64Image || !frame?.mimeType) return null;
  const buffer = Buffer.from(frame.base64Image, "base64");
  const image = sharp(buffer);
  const meta = await image.metadata();
  if (!meta.width || !meta.height) return null;
  const roi = computePointRoi(point, meta.width, meta.height, sizeRatio);
  if (!roi) return null;
  const cropped = await image
    .extract({ left: roi.left, top: roi.top, width: roi.width, height: roi.height })
    .jpeg({ quality: 92 })
    .toBuffer();
  return {
    frame: { base64Image: cropped.toString("base64"), mimeType: "image/jpeg" },
    roi,
  };
}

async function detectClubheadInRoi(
  frame: PhaseFrame,
): Promise<{ point: { x: number; y: number } | null; confidence: "high" | "medium" | "low" | null } | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set (clubhead ROI)");
  const client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_API_BASE ?? undefined,
  });

  const prompt = `
You are a vision model. The image is a cropped region around the ball and clubhead at address.

Return JSON only:
{
  "clubhead_point": { "x": 0.0, "y": 0.0 } | null,
  "clubhead_confidence": "high" | "medium" | "low"
}

Rules:
- clubhead_point is the center of the black clubhead (not the ball).
- If the clubhead is not visible, return null.
- Coordinates are normalized to the cropped image (top-left = 0,0).
`;

  const content = [
    { type: "text", text: prompt.trim() },
    { type: "image_url", image_url: { url: `data:${frame.mimeType};base64,${frame.base64Image}`, detail: "high" } },
  ] as Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" } }>;

  const result = await client.chat.completions.create({
    model: process.env.OPENAI_POSE_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o",
    messages: [
      { role: "system", content: "You are a vision model. Focus only on the provided image." },
      { role: "user", content },
    ],
    temperature: 0.0,
    max_tokens: 1024,
    response_format: { type: "json_object" },
  });

  const structured = result.choices?.[0]?.message?.content ?? null;
  const parsed =
    typeof structured === "string"
      ? (() => {
          try {
            return JSON.parse(structured);
          } catch {
            return null;
          }
        })()
      : structured;
  const obj = safeJsonObject(parsed);
  if (!obj) return null;
  const point = normalizePoint01(obj.clubhead_point ?? obj.clubheadPoint);
  const confRaw = obj.clubhead_confidence ?? obj.clubheadConfidence ?? null;
  const confidence = confRaw === "high" || confRaw === "medium" || confRaw === "low" ? (confRaw as "high" | "medium" | "low") : null;
  return { point, confidence };
}

async function detectClubheadByDarkestInRoi(
  frame: PhaseFrame,
  ballLocal: { x: number; y: number },
  gripLocal: { x: number; y: number },
): Promise<{ point: { x: number; y: number } | null } | null> {
  if (!frame?.base64Image) return null;
  const buffer = Buffer.from(frame.base64Image, "base64");
  const image = sharp(buffer);
  const size = 64;
  const raw = await image.resize(size, size, { fit: "fill" }).greyscale().raw().toBuffer();
  let bestVal = 255;
  let bestX = -1;
  let bestY = -1;
  const bx = clamp(ballLocal.x, 0, 1);
  const by = clamp(ballLocal.y, 0, 1);
  const expected = estimateClubheadExpectedPoint({ x: bx, y: by }, gripLocal);
  const cx = expected?.x ?? bx;
  const cy = expected?.y ?? by;
  const radius = expected ? 0.22 : 0.2;
  const minX = Math.max(0, Math.floor((bx - 0.22) * size));
  const maxX = Math.min(size - 1, Math.ceil((bx + 0.02) * size));
  const minY = Math.max(0, Math.floor((by - 0.02) * size));
  const maxY = Math.min(size - 1, Math.ceil((by + 0.22) * size));
  const rPx = radius * size;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const v = raw[y * size + x] ?? 255;
      if (x > bx * size + 2) continue;
      if (y < by * size - 2) continue;
      const dx = x + 0.5 - cx * size;
      const dy = y + 0.5 - cy * size;
      const dist = Math.hypot(dx, dy);
      if (dist > rPx) continue;
      const rightPenalty = Math.max(0, x + 0.5 - bx * size) * 0.4;
      const upPenalty = Math.max(0, by * size - (y + 0.5)) * 0.4;
      const score = v + dist * 2 + rightPenalty + upPenalty;
      if (score < bestVal) {
        bestVal = score;
        bestX = x;
        bestY = y;
      }
    }
  }
  if (bestX < 0 || bestY < 0) return null;
  return {
    point: { x: (bestX + 0.5) / size, y: (bestY + 0.5) / size },
  };
}

function estimateClubheadExpectedPoint(
  ballLocal: { x: number; y: number },
  gripLocal: { x: number; y: number },
  shaftDir?: { x: number; y: number } | null,
): { x: number; y: number } | null {
  const dx = ballLocal.x - gripLocal.x;
  const dy = ballLocal.y - gripLocal.y;
  const dist = Math.hypot(dx, dy);
  if (!Number.isFinite(dist) || dist < 1e-4) return null;
  const baseUx = dx / dist;
  const baseUy = dy / dist;
  const dir = shaftDir
    ? normalizeDirection(supportDirectionSign(shaftDir, { x: baseUx, y: baseUy }))
    : { x: baseUx, y: baseUy };
  const ux = dir?.x ?? baseUx;
  const uy = dir?.y ?? baseUy;
  const offset = clamp(dist * 0.32, 0.07, 0.24);
  const perpA = { x: -uy, y: ux };
  const perpB = { x: uy, y: -ux };
  const perp = perpA.x <= perpB.x && perpA.y >= perpB.y ? perpA : perpB;
  const sideBias = clamp(dist * 0.12, 0.03, 0.08);
  return {
    x: clamp(ballLocal.x - ux * offset + perp.x * sideBias, 0, 1),
    y: clamp(ballLocal.y - uy * offset + perp.y * sideBias, 0, 1),
  };
}

function distance2d(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function normalizeDirection(dir: { x: number; y: number } | null): { x: number; y: number } | null {
  if (!dir) return null;
  const len = Math.hypot(dir.x, dir.y);
  if (!Number.isFinite(len) || len < 1e-6) return null;
  return { x: dir.x / len, y: dir.y / len };
}

function supportDirectionSign(
  dir: { x: number; y: number },
  reference: { x: number; y: number },
): { x: number; y: number } {
  const dot = dir.x * reference.x + dir.y * reference.y;
  return dot >= 0 ? dir : { x: -dir.x, y: -dir.y };
}

function distancePointToLine(
  point: { x: number; y: number },
  anchor: { x: number; y: number },
  dir: { x: number; y: number },
): number {
  const norm = normalizeDirection(dir);
  if (!norm) return 0;
  const vx = point.x - anchor.x;
  const vy = point.y - anchor.y;
  const proj = vx * norm.x + vy * norm.y;
  const closestX = anchor.x + proj * norm.x;
  const closestY = anchor.y + proj * norm.y;
  return Math.hypot(point.x - closestX, point.y - closestY);
}

async function detectAddressShaftVector(frame: PhaseFrame): Promise<{ x: number; y: number } | null> {
  try {
    const poseFrames = await extractPoseKeypointsFromImages({
      frames: [{ base64Image: frame.base64Image, mimeType: frame.mimeType }],
    });
    const first = poseFrames[0];
    if (!first || typeof first !== "object") return null;
    const rawVec = (first.club as unknown as { shaftVector?: unknown } | undefined)?.shaftVector ?? null;
    const vec = toShaftVector(rawVec);
    return normalizeDirection(vec);
  } catch {
    return null;
  }
}

function deriveShaftDirection(
  gripLocal: { x: number; y: number },
  ballLocal: { x: number; y: number },
  shaftVec: { x: number; y: number } | null,
): { x: number; y: number } | null {
  if (!shaftVec) return null;
  const baseDx = ballLocal.x - gripLocal.x;
  const baseDy = ballLocal.y - gripLocal.y;
  const baseDist = Math.hypot(baseDx, baseDy);
  if (!Number.isFinite(baseDist) || baseDist < 1e-6) return null;
  const baseDir = { x: baseDx / baseDist, y: baseDy / baseDist };
  return normalizeDirection(supportDirectionSign(shaftVec, baseDir));
}

function selectBestClubheadCandidate(
  candidates: Array<{ point: { x: number; y: number }; confidence: "high" | "medium" | "low"; source?: string }>,
  expected: { x: number; y: number } | null,
  ballLocal: { x: number; y: number },
  shaftLine: { anchor: { x: number; y: number }; dir: { x: number; y: number } } | null,
): {
  best: { point: { x: number; y: number }; confidence: "high" | "medium" | "low"; source?: string } | null;
  scores: Array<{
    point: { x: number; y: number };
    confidence: "high" | "medium" | "low";
    source?: string;
    score: number;
    skipped?: boolean;
  }>;
} {
  if (!candidates.length) return { best: null, scores: [] };
  let best: { point: { x: number; y: number }; confidence: "high" | "medium" | "low"; source?: string } | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  const scores: Array<{
    point: { x: number; y: number };
    confidence: "high" | "medium" | "low";
    source?: string;
    score: number;
    skipped?: boolean;
  }> = [];
  for (const candidate of candidates) {
    const isRight = candidate.point.x > ballLocal.x + 0.025;
    const isUp = candidate.point.y < ballLocal.y - 0.025;
    if ((isRight || isUp) && (expected || shaftLine)) {
      scores.push({ ...candidate, score: Number.POSITIVE_INFINITY, skipped: true });
      continue;
    }
    const ballDist = distance2d(candidate.point, ballLocal);
    const expectedDist = expected ? distance2d(candidate.point, expected) : null;
    let score = expectedDist != null ? expectedDist * 1.6 : ballDist * 0.2;
    if (ballDist < 0.04) score += 0.04;
    // Penalize points that land right/up of the ball (common tee false-positive).
    if (candidate.point.x > ballLocal.x + 0.015) score += 0.08;
    if (candidate.point.y < ballLocal.y - 0.015) score += 0.08;
    if (shaftLine) {
      const lineDist = distancePointToLine(candidate.point, shaftLine.anchor, shaftLine.dir);
      score += Math.min(lineDist * 0.9, 0.2);
    }
    if (candidate.confidence === "high") score -= 0.015;
    if (candidate.confidence === "medium") score += 0.005;
    if (candidate.confidence === "low") score += 0.02;
    if (candidate.source === "roi_main") score += 0.02;
    if (candidate.source === "roi_ball") score += 0.03;
    if (candidate.source === "darkest") score += 0.06;
    if (candidate.source === "expected_roi") score += 0.03;
    scores.push({ ...candidate, score });
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (scores.length) {
    const shaftScan = scores
      .filter((s) => s.source === "shaft_scan" && s.score != null && !s.skipped)
      .sort((a, b) => (a.score ?? 999) - (b.score ?? 999))[0];
    if (shaftScan) {
      const picked = candidates.find(
        (c) => c.source === "shaft_scan" && c.point.x === shaftScan.x && c.point.y === shaftScan.y,
      );
      if (picked) {
        best = picked;
        bestScore = shaftScan.score ?? bestScore;
      }
    }
  }
  if (best && scores.length) {
    const preferred = new Set(["darkest", "expected_roi", "shaft_scan"]);
    const close = scores
      .filter((s) => !s.skipped && s.score != null && preferred.has(s.source ?? ""))
      .sort((a, b) => (a.score ?? 999) - (b.score ?? 999))[0];
    if (close && close.score != null && close.score - bestScore <= 0.02) {
      const picked = candidates.find((c) => c.source === close.source && c.point.x === close.point.x && c.point.y === close.point.y);
      if (picked) {
        best = picked;
        bestScore = close.score;
      }
    }
  }
  if (best && scores.length) {
    const roiMain = scores.find((s) => s.source === "roi_main" && s.score != null && !s.skipped);
    if (roiMain && roiMain.score != null && roiMain.score - bestScore <= 0.06) {
      const picked = candidates.find((c) => c.source === "roi_main" && c.point.x === roiMain.x && c.point.y === roiMain.y);
      if (picked) {
        best = picked;
        bestScore = roiMain.score;
      }
    }
  }
  if (best && scores.length && best.source === "darkest") {
    const roiMain = scores.find((s) => s.source === "roi_main" && s.score != null && !s.skipped);
    if (roiMain && roiMain.score != null && roiMain.score - bestScore <= 0.08) {
      const picked = candidates.find((c) => c.source === "roi_main" && c.point.x === roiMain.x && c.point.y === roiMain.y);
      if (picked) {
        best = picked;
        bestScore = roiMain.score;
      }
    }
  }
  if (best && scores.length && (best.source === "darkest" || best.source === "expected_roi")) {
    const roiMain = scores.find((s) => s.source === "roi_main" && s.score != null && !s.skipped && s.confidence === "high");
    if (roiMain && roiMain.score != null && roiMain.score - bestScore <= 0.12) {
      const picked = candidates.find((c) => c.source === "roi_main" && c.point.x === roiMain.x && c.point.y === roiMain.y);
      if (picked) {
        best = picked;
        bestScore = roiMain.score;
      }
    }
  }
  return { best, scores };
}

async function detectClubheadAlongShaftInRoi(
  frame: PhaseFrame,
  gripLocal: { x: number; y: number },
  ballLocal: { x: number; y: number },
  shaftDir?: { x: number; y: number } | null,
): Promise<{ point: { x: number; y: number } | null } | null> {
  if (!frame?.base64Image) return null;
  const buffer = Buffer.from(frame.base64Image, "base64");
  const image = sharp(buffer);
  const size = 64;
  const raw = await image.resize(size, size, { fit: "fill" }).greyscale().raw().toBuffer();
  const baseDx = ballLocal.x - gripLocal.x;
  const baseDy = ballLocal.y - gripLocal.y;
  const baseDist = Math.hypot(baseDx, baseDy);
  if (!Number.isFinite(baseDist) || baseDist < 1e-4) return null;
  const baseUx = baseDx / baseDist;
  const baseUy = baseDy / baseDist;
  const dir = shaftDir ? normalizeDirection(supportDirectionSign(shaftDir, { x: baseUx, y: baseUy })) : { x: baseUx, y: baseUy };
  const dx = dir?.x ?? baseUx;
  const dy = dir?.y ?? baseUy;
  const dist = Math.hypot(dx, dy);
  if (!Number.isFinite(dist) || dist < 1e-4) return null;
  const ux = dx / dist;
  const uy = dy / dist;
  let bestVal = 255;
  let bestX = -1;
  let bestY = -1;
  const startT = 0.55;
  const endT = 0.95;
  const steps = 18;
  for (let i = 0; i <= steps; i += 1) {
    const t = startT + (endT - startT) * (i / steps);
    const px = (gripLocal.x + ux * baseDist * t) * size;
    const py = (gripLocal.y + uy * baseDist * t) * size;
    const cx = Math.round(px);
    const cy = Math.round(py);
    for (let oy = -3; oy <= 3; oy += 1) {
      const y = cy + oy;
      if (y < 0 || y >= size) continue;
      for (let ox = -3; ox <= 3; ox += 1) {
        const x = cx + ox;
        if (x < 0 || x >= size) continue;
        const v = raw[y * size + x] ?? 255;
        const ballDx = x + 0.5 - ballLocal.x * size;
        const ballDy = y + 0.5 - ballLocal.y * size;
        const ballDist = Math.hypot(ballDx, ballDy);
        if (ballDist < size * 0.05) continue;
        // Prefer points closer to the tip side of the shaft.
        const tBias = (1 - t) * 28;
        const rightPenalty = Math.max(0, x + 0.5 - ballLocal.x * size) * 0.5;
        const upPenalty = Math.max(0, ballLocal.y * size - (y + 0.5)) * 0.5;
        const score = v + tBias + rightPenalty + upPenalty;
        if (score < bestVal) {
          bestVal = score;
          bestX = x;
          bestY = y;
        }
      }
    }
  }
  if (bestX < 0 || bestY < 0) return null;
  return { point: { x: (bestX + 0.5) / size, y: (bestY + 0.5) / size } };
}

async function detectClubheadByDarkBlobOnShaftInRoi(
  frame: PhaseFrame,
  gripLocal: { x: number; y: number },
  ballLocal: { x: number; y: number },
  shaftDir: { x: number; y: number } | null,
): Promise<{ point: { x: number; y: number } | null } | null> {
  if (!frame?.base64Image || !shaftDir) return null;
  const dir = normalizeDirection(shaftDir);
  if (!dir) return null;
  const buffer = Buffer.from(frame.base64Image, "base64");
  const image = sharp(buffer);
  const size = 64;
  const raw = await image.resize(size, size, { fit: "fill" }).greyscale().raw().toBuffer();
  const values: number[] = [];
  for (let i = 0; i < raw.length; i += 1) values.push(raw[i] ?? 255);
  values.sort((a, b) => a - b);
  const threshold = values[Math.floor(values.length * 0.15)] ?? 70;
  const mask = new Array(size * size).fill(0);
  const anchor = { x: gripLocal.x * size, y: gripLocal.y * size };
  const bx = clamp(ballLocal.x, 0, 1) * size;
  const by = clamp(ballLocal.y, 0, 1) * size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (x > bx - 1) continue;
      if (y < by - 1) continue;
      const v = raw[y * size + x] ?? 255;
      if (v > threshold) continue;
      const dist = distancePointToLine({ x: x + 0.5, y: y + 0.5 }, anchor, { x: dir.x * size, y: dir.y * size });
      if (dist > 4) continue;
      mask[y * size + x] = 1;
    }
  }

  let best: { x: number; y: number; score: number } | null = null;
  const visited = new Array(size * size).fill(0);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i] || visited[i]) continue;
    const stack = [i];
    visited[i] = 1;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let maxY = -1;
    while (stack.length) {
      const idx = stack.pop()!;
      const y = Math.floor(idx / size);
      const x = idx - y * size;
      count += 1;
      sumX += x + 0.5;
      sumY += y + 0.5;
      if (y > maxY) maxY = y;
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
        const nidx = ny * size + nx;
        if (!mask[nidx] || visited[nidx]) continue;
        visited[nidx] = 1;
        stack.push(nidx);
      }
    }
    if (count < 8) continue;
    const cx = sumX / count;
    const cy = sumY / count;
    const score = maxY + count * 0.1;
    if (!best || score > best.score) {
      best = { x: cx, y: cy, score };
    }
  }

  if (!best) return null;
  return { point: { x: best.x / size, y: best.y / size } };
}

async function detectClubheadByDarkPatchInRoi(
  frame: PhaseFrame,
  ballLocal: { x: number; y: number },
  gripLocal: { x: number; y: number },
  shaftDir: { x: number; y: number } | null,
): Promise<{ point: { x: number; y: number } | null } | null> {
  if (!frame?.base64Image) return null;
  const buffer = Buffer.from(frame.base64Image, "base64");
  const image = sharp(buffer);
  const size = 64;
  const raw = await image.resize(size, size, { fit: "fill" }).greyscale().raw().toBuffer();
  const bx = clamp(ballLocal.x, 0, 1) * size;
  const by = clamp(ballLocal.y, 0, 1) * size;
  const gx = clamp(gripLocal.x, 0, 1) * size;
  const gy = clamp(gripLocal.y, 0, 1) * size;
  const dir = shaftDir ? normalizeDirection(shaftDir) : normalizeDirection({ x: bx - gx, y: by - gy });

  const minX = Math.max(0, Math.floor(bx - size * 0.4));
  const maxX = Math.min(size - 1, Math.ceil(bx - size * 0.02));
  const minY = Math.max(0, Math.floor(by - size * 0.05));
  const maxY = Math.min(size - 1, Math.ceil(by + size * 0.4));
  const r = 3;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestX = -1;
  let bestY = -1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      let sum = 0;
      let count = 0;
      for (let oy = -r; oy <= r; oy += 1) {
        const yy = y + oy;
        if (yy < 0 || yy >= size) continue;
        for (let ox = -r; ox <= r; ox += 1) {
          const xx = x + ox;
          if (xx < 0 || xx >= size) continue;
          sum += raw[yy * size + xx] ?? 255;
          count += 1;
        }
      }
      const avg = count ? sum / count : 255;
      let score = avg;
      if (dir) {
        const dist = distancePointToLine({ x: x + 0.5, y: y + 0.5 }, { x: gx, y: gy }, { x: dir.x * size, y: dir.y * size });
        score += Math.min(dist * 0.8, 12);
      }
      const rightPenalty = Math.max(0, x - (bx - 1)) * 1.4;
      const upPenalty = Math.max(0, (by - 1) - y) * 1.2;
      score += rightPenalty + upPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }
  if (bestX < 0 || bestY < 0) return null;
  return { point: { x: (bestX + 0.5) / size, y: (bestY + 0.5) / size } };
}

async function detectClubheadByHoughShaftInRoi(
  frame: PhaseFrame,
  gripLocal: { x: number; y: number },
  ballLocal: { x: number; y: number },
  shaftDir: { x: number; y: number } | null,
): Promise<{ point: { x: number; y: number } | null; line?: { anchor: { x: number; y: number }; dir: { x: number; y: number }; score: number } } | null> {
  if (!frame?.base64Image) return null;
  const buffer = Buffer.from(frame.base64Image, "base64");
  const image = sharp(buffer);
  const size = 96;
  const raw = await image.resize(size, size, { fit: "fill" }).greyscale().raw().toBuffer();
  const gxKernel = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const gyKernel = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  const mag = new Float32Array(size * size);
  let maxMag = 0;
  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      let gx = 0;
      let gy = 0;
      let k = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const v = raw[(y + oy) * size + (x + ox)] ?? 0;
          gx += v * gxKernel[k];
          gy += v * gyKernel[k];
          k += 1;
        }
      }
      const m = Math.hypot(gx, gy);
      mag[y * size + x] = m;
      if (m > maxMag) maxMag = m;
    }
  }
  if (maxMag < 1) return null;
  const threshold = maxMag * 0.35;
  const edges: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < mag.length; i += 1) {
    if (mag[i] >= threshold) {
      const y = Math.floor(i / size);
      const x = i - y * size;
      edges.push({ x, y });
    }
  }
  if (edges.length < 20) return null;

  const baseDx = ballLocal.x - gripLocal.x;
  const baseDy = ballLocal.y - gripLocal.y;
  const baseNorm = Math.hypot(baseDx, baseDy);
  const baseAngle = baseNorm > 1e-6 ? Math.atan2(baseDy, baseDx) : 0;
  const dir = shaftDir ? normalizeDirection(shaftDir) : null;
  const dirAngle = dir ? Math.atan2(dir.y, dir.x) : baseAngle;
  const angleCenter = dir ? dirAngle : baseAngle;
  const angleRange = Math.PI / 12;
  const angleStep = Math.PI / 180;
  const thetaMin = angleCenter - angleRange;
  const thetaMax = angleCenter + angleRange;

  const rMax = Math.hypot(size, size);
  const rBins = Math.ceil(rMax * 2);
  const thetaBins = Math.max(1, Math.round((thetaMax - thetaMin) / angleStep));
  const acc = new Float32Array(rBins * thetaBins);
  for (let ti = 0; ti < thetaBins; ti += 1) {
    const theta = thetaMin + angleStep * ti;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    for (const p of edges) {
      const r = p.x * cosT + p.y * sinT;
      const ri = Math.round(r + rMax);
      if (ri < 0 || ri >= rBins) continue;
      acc[ti * rBins + ri] += 1;
    }
  }

  let best = -1;
  let bestTi = 0;
  let bestRi = 0;
  for (let ti = 0; ti < thetaBins; ti += 1) {
    for (let ri = 0; ri < rBins; ri += 1) {
      const v = acc[ti * rBins + ri];
      if (v > best) {
        best = v;
        bestTi = ti;
        bestRi = ri;
      }
    }
  }
  if (best < 12) return null;

  const theta = thetaMin + angleStep * bestTi;
  const r = bestRi - rMax;
  const lineDir = { x: -Math.sin(theta), y: Math.cos(theta) };
  const anchor = { x: Math.cos(theta) * r, y: Math.sin(theta) * r };

  const bx = clamp(ballLocal.x, 0, 1) * size;
  const by = clamp(ballLocal.y, 0, 1) * size;
  const baseDir = baseNorm > 1e-6 ? { x: baseDx / baseNorm, y: baseDy / baseNorm } : { x: 1, y: 0 };
  const lineDirSigned = supportDirectionSign(lineDir, baseDir);

  const projBall = (bx - anchor.x) * lineDirSigned.x + (by - anchor.y) * lineDirSigned.y;
  const searchStart = projBall - size * 0.18;
  const searchEnd = projBall + size * 0.04;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestX = -1;
  let bestY = -1;
  for (let t = searchStart; t <= searchEnd; t += 1) {
    const cx = anchor.x + lineDirSigned.x * t;
    const cy = anchor.y + lineDirSigned.y * t;
    if (cx < 2 || cx > size - 3 || cy < 2 || cy > size - 3) continue;
    let sum = 0;
    let count = 0;
    for (let oy = -2; oy <= 2; oy += 1) {
      for (let ox = -2; ox <= 2; ox += 1) {
        const xx = Math.round(cx + ox);
        const yy = Math.round(cy + oy);
        sum += raw[yy * size + xx] ?? 255;
        count += 1;
      }
    }
    const avg = count ? sum / count : 255;
    const rightPenalty = Math.max(0, cx - (bx - 1)) * 1.2;
    const upPenalty = Math.max(0, (by - 1) - cy) * 1.0;
    const score = avg + rightPenalty + upPenalty;
    if (score < bestScore) {
      bestScore = score;
      bestX = cx;
      bestY = cy;
    }
  }
  if (bestX < 0 || bestY < 0) return null;
  return {
    point: { x: bestX / size, y: bestY / size },
    line: {
      anchor: { x: anchor.x / size, y: anchor.y / size },
      dir: normalizeDirection(lineDirSigned) ?? { x: lineDirSigned.x, y: lineDirSigned.y },
      score: best,
    },
  };
}

async function detectClubheadByPcaShaftTipInRoi(
  frame: PhaseFrame,
  gripLocal: { x: number; y: number },
  ballLocal: { x: number; y: number },
): Promise<{ point: { x: number; y: number } | null } | null> {
  if (!frame?.base64Image) return null;
  const buffer = Buffer.from(frame.base64Image, "base64");
  const image = sharp(buffer);
  const size = 64;
  const raw = await image.resize(size, size, { fit: "fill" }).greyscale().raw().toBuffer();
  const bx = clamp(ballLocal.x, 0, 1) * size;
  const by = clamp(ballLocal.y, 0, 1) * size;
  const gx = clamp(gripLocal.x, 0, 1) * size;
  const gy = clamp(gripLocal.y, 0, 1) * size;

  const values: number[] = [];
  for (let i = 0; i < raw.length; i += 1) values.push(raw[i] ?? 255);
  values.sort((a, b) => a - b);
  const threshold = values[Math.floor(values.length * 0.2)] ?? 80;

  const pts: Array<{ x: number; y: number; v: number }> = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const v = raw[y * size + x] ?? 255;
      if (v > threshold) continue;
      if (x > bx - 1) continue;
      if (y < by - 1) continue;
      const distToBall = Math.hypot(x + 0.5 - bx, y + 0.5 - by);
      if (distToBall < size * 0.05) continue;
      pts.push({ x: x + 0.5, y: y + 0.5, v });
    }
  }
  if (pts.length < 20) return null;

  let meanX = 0;
  let meanY = 0;
  for (const p of pts) {
    meanX += p.x;
    meanY += p.y;
  }
  meanX /= pts.length;
  meanY /= pts.length;

  let covXX = 0;
  let covXY = 0;
  let covYY = 0;
  for (const p of pts) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    covXX += dx * dx;
    covXY += dx * dy;
    covYY += dy * dy;
  }
  covXX /= pts.length;
  covXY /= pts.length;
  covYY /= pts.length;

  const trace = covXX + covYY;
  const det = covXX * covYY - covXY * covXY;
  const temp = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
  const lambda = trace / 2 + temp;
  let vx = lambda - covYY;
  let vy = covXY;
  if (Math.abs(vx) < 1e-6 && Math.abs(vy) < 1e-6) {
    vx = covXY;
    vy = lambda - covXX;
  }
  const norm = Math.hypot(vx, vy);
  if (!Number.isFinite(norm) || norm < 1e-6) return null;
  vx /= norm;
  vy /= norm;

  const baseDx = bx - gx;
  const baseDy = by - gy;
  const baseNorm = Math.hypot(baseDx, baseDy);
  if (baseNorm > 1e-6) {
    const dot = vx * (baseDx / baseNorm) + vy * (baseDy / baseNorm);
    if (dot < 0) {
      vx = -vx;
      vy = -vy;
    }
  }

  const projPts = pts
    .map((p) => ({ p, t: (p.x - gx) * vx + (p.y - gy) * vy }))
    .filter((e) => e.t > 0);
  if (!projPts.length) return null;
  projPts.sort((a, b) => b.t - a.t);
  const take = Math.max(6, Math.floor(projPts.length * 0.12));
  let sumX = 0;
  let sumY = 0;
  let sumW = 0;
  for (let i = 0; i < Math.min(take, projPts.length); i += 1) {
    const { p } = projPts[i]!;
    const w = 1 + (255 - p.v) / 255;
    sumX += p.x * w;
    sumY += p.y * w;
    sumW += w;
  }
  if (sumW <= 0) return null;
  return { point: { x: (sumX / sumW) / size, y: (sumY / sumW) / size } };
}

export async function POST(req: NextRequest): Promise<NextResponse<GolfAnalysisResponse | { error: string }>> {
  const body = (await req.json().catch(() => null)) as
    | { analysisId?: string; address?: unknown; backswing?: unknown; top?: unknown; downswing?: unknown; impact?: unknown; finish?: unknown }
    | null;
  const analysisIdRaw = body?.analysisId ?? null;
  if (!isValidAnalysisId(analysisIdRaw)) {
    return json({ error: "invalid id" }, { status: 400 });
  }
  const analysisId = analysisIdRaw as AnalysisId;

  const addressIndices = normalizeIndices(body?.address);
  const backswingIndices = normalizeIndices(body?.backswing);
  const topIndices = normalizeIndices(body?.top);
  const downswingIndices = normalizeIndices(body?.downswing);
  const impactIndices = normalizeIndices(body?.impact);
  const finishIndices = normalizeIndices(body?.finish);

  if (!addressIndices.length && !backswingIndices.length && !topIndices.length && !downswingIndices.length && !impactIndices.length && !finishIndices.length) {
    return json({ error: "no overrides" }, { status: 400 });
  }

  const loaded = await loadAuthorizedAnalysis(req, analysisId);
  if (loaded.error) return json({ error: loaded.error }, { status: 404 });
  const { stored, account } = loaded;
  const meta = stored.meta ?? null;
  const storedAddressIndex =
    typeof meta?.addressFrameIndex === "number" && Number.isFinite(meta.addressFrameIndex) ? meta.addressFrameIndex : null;
  const fixedAddressIndex =
    addressIndices.length && storedAddressIndex && addressIndices.includes(storedAddressIndex)
      ? storedAddressIndex
      : addressIndices.length
        ? addressIndices[0]!
        : null;
  const effectiveAddressIndices = fixedAddressIndex ? [fixedAddressIndex] : addressIndices;

  const requestedOverrideSig = buildOverrideSig({
    address: effectiveAddressIndices,
    backswing: backswingIndices,
    top: topIndices,
    downswing: downswingIndices,
    impact: impactIndices,
    finish: finishIndices,
  });

  // If the override set is unchanged, return the stored result as-is to prevent
  // re-evaluation jitter (vision outputs can vary even with the same frames).
  if (stored?.result && stored?.meta?.phaseOverrideSig === requestedOverrideSig && stored?.meta?.phaseReevalVersion === PHASE_REEVAL_VERSION) {
    const res = json(
      {
        analysisId,
        result: stored.result,
        meta: stored.meta,
        createdAt: stored.createdAt,
      },
      { status: 200 }
    );
    if (account?.authProvider === "google") setActiveAuthOnResponse(res, "google");
    if (account?.authProvider === "email") setActiveAuthOnResponse(res, "email");
    return res;
  }

  const sequence = stored.result?.sequence;
  const frames = Array.isArray(sequence?.frames) ? sequence!.frames : [];
  if (!frames.length) {
    return json({ error: "sequence frames not available" }, { status: 400 });
  }

  const pickFrames = (indices: number[]): PhaseFrame[] => {
    const out: PhaseFrame[] = [];
    for (const idx1 of indices) {
      const i = idx1 - 1;
      const entry = frames[i];
      if (!entry || typeof entry.url !== "string") continue;
      const parsed = parseDataUrl(entry.url);
      if (!parsed) continue;
      out.push({ base64Image: parsed.base64, mimeType: parsed.mimeType, timestampSec: entry.timestampSec });
    }
    return out;
  };

  const pickFramesWithIndex = (indices: number[]): Array<PhaseFrame & { frameIndex: number }> => {
    const out: Array<PhaseFrame & { frameIndex: number }> = [];
    for (const idx1 of indices) {
      const i = idx1 - 1;
      const entry = frames[i];
      if (!entry || typeof entry.url !== "string") continue;
      const parsed = parseDataUrl(entry.url);
      if (!parsed) continue;
      out.push({ base64Image: parsed.base64, mimeType: parsed.mimeType, timestampSec: entry.timestampSec, frameIndex: idx1 });
    }
    return out;
  };

  const phaseUpdates: Partial<
    Record<"address" | "backswing" | "top" | "downswing" | "impact" | "finish", { score: number; good: string[]; issues: string[]; advice: string[] }>
  > = {};
  let onPlaneUpdate: Record<string, unknown> | null = null;

  try {
    if (effectiveAddressIndices.length) {
      const picked = pickFrames(effectiveAddressIndices);
      if (!picked.length) return json({ error: "invalid address frames" }, { status: 400 });
      phaseUpdates.address = await analyzeSinglePhase(picked, {
        phaseLabel: "アドレス",
        handedness: meta?.handedness,
        clubType: meta?.clubType,
        level: meta?.level,
      });
    }
    if (backswingIndices.length) {
      const picked = pickFrames(backswingIndices);
      if (!picked.length) return json({ error: "invalid backswing frames" }, { status: 400 });
      phaseUpdates.backswing = await analyzeSinglePhase(picked, {
        phaseLabel: "バックスイング",
        handedness: meta?.handedness,
        clubType: meta?.clubType,
        level: meta?.level,
      });
    }
    if (topIndices.length) {
      const picked = pickFrames(topIndices);
      if (!picked.length) return json({ error: "invalid top frames" }, { status: 400 });
      phaseUpdates.top = await analyzeSinglePhase(picked, {
        phaseLabel: "トップ",
        handedness: meta?.handedness,
        clubType: meta?.clubType,
        level: meta?.level,
      });
    }
    if (downswingIndices.length) {
      const picked = pickFrames(downswingIndices);
      if (!picked.length) return json({ error: "invalid downswing frames" }, { status: 400 });
      const downswingResult = await analyzeSinglePhase(picked, {
        phaseLabel: "ダウンスイング",
        handedness: meta?.handedness,
        clubType: meta?.clubType,
        level: meta?.level,
      });
      // Judge outside-in with a bit more context (Top/Impact) when available.
      const outsideInFrames: PhaseFrame[] = [
        ...(topIndices.length ? pickFrames(topIndices).slice(-2) : []),
        ...picked,
        ...(impactIndices.length ? pickFrames(impactIndices).slice(0, 2) : []),
      ].slice(0, 8);
      const outsideInJudge = await judgeOutsideIn(outsideInFrames.length ? outsideInFrames : picked, {
        handedness: meta?.handedness,
        clubType: meta?.clubType,
        level: meta?.level,
      });
      if (outsideInJudge?.value === true) {
        if (outsideInJudge.confidence === "high") {
          downswingResult.issues = Array.from(new Set(["アウトサイドイン（確定）", ...downswingResult.issues])).slice(0, 4);
          downswingResult.issues = downswingResult.issues.filter((t) => !/外から入りやすい傾向/.test(t));
          downswingResult.score = Math.min(downswingResult.score, 8);
        } else {
          if (!downswingResult.issues.some((t) => /外から入りやすい傾向/.test(t))) {
            downswingResult.issues = ["外から入りやすい傾向", ...downswingResult.issues].slice(0, 4);
          }
          downswingResult.issues = downswingResult.issues.filter((t) => !/（確定）/.test(t));
          downswingResult.score = Math.min(downswingResult.score, 12);
        }
      } else if (outsideInJudge?.value === false && outsideInJudge.confidence === "high") {
        // If judged as NOT outside-in, remove the tendency wording to avoid false negatives (e.g., elite swings).
        downswingResult.issues = downswingResult.issues.filter((t) => !/アウトサイドイン|外から入りやすい傾向|外から下り|カット軌道|上から/.test(t));
        const goodCount = downswingResult.good.filter((t) => t.trim().length > 0).length;
        if (!downswingResult.issues.length && goodCount >= 2) {
          downswingResult.score = Math.max(downswingResult.score, 18);
        }
      }
      phaseUpdates.downswing = downswingResult;
    }
    if (impactIndices.length) {
      const picked = pickFrames(impactIndices);
      if (!picked.length) return json({ error: "invalid impact frames" }, { status: 400 });
      phaseUpdates.impact = await analyzeSinglePhase(picked, {
        phaseLabel: "インパクト",
        handedness: meta?.handedness,
        clubType: meta?.clubType,
        level: meta?.level,
      });
    }
    if (finishIndices.length) {
      const picked = pickFrames(finishIndices);
      if (!picked.length) return json({ error: "invalid finish frames" }, { status: 400 });
      phaseUpdates.finish = await analyzeSinglePhase(picked, {
        phaseLabel: "フィニッシュ",
        handedness: meta?.handedness,
        clubType: meta?.clubType,
        level: meta?.level,
      });
    }

            // On-plane: use the same user-selected phase frames (Top/Downswing/Impact) as evidence.
    // This allows older analyses (without on_plane in the original result JSON) to be backfilled on reevaluation.
		    if (topIndices.length && downswingIndices.length && impactIndices.length) {
		      const addressFrames = effectiveAddressIndices.length ? pickFramesWithIndex(effectiveAddressIndices.slice(0, 1)) : [];
		      const backswingFrames = backswingIndices.length ? pickFramesWithIndex(backswingIndices.slice(0, 2)) : [];
		      const topFrames = pickFramesWithIndex(topIndices.slice(0, 6));
		      const dsFrames = pickFramesWithIndex(downswingIndices.slice(0, 8));
		      const impFrames = pickFramesWithIndex(impactIndices.slice(0, 6));
		      const framesForOnPlane = [...topFrames, ...dsFrames, ...impFrames].slice(0, 7);
		      if (framesForOnPlane.length >= 3) {
		        const prompt = buildOnPlanePrompt({ handedness: meta?.handedness, clubType: meta?.clubType, level: meta?.level });
		        const raw = await askVisionAPI({ frames: framesForOnPlane, prompt });
		        const parsed = parseOnPlane(raw);
	        const existingOnPlane = (stored.result as unknown as Record<string, unknown>)?.on_plane;
	        const baseOnPlane =
	          parsed ??
	          (existingOnPlane && typeof existingOnPlane === "object"
	            ? ({ ...(existingOnPlane as Record<string, unknown>) } as Record<string, unknown>)
	            : null);
	        if (baseOnPlane) onPlaneUpdate = baseOnPlane;

		        // Prefer deterministic plane lines from pose+shaftVector when available (2D estimate).
		        try {
		          // Pose-based hand tracing: keep the original (Top/Downswing/Impact) set for stability.
		          // Address is handled separately to anchor the zone at the clubhead.
		          const poseInputs = [...backswingFrames, ...topFrames, ...dsFrames, ...impFrames].slice(0, 16);
		          const bsCount = Math.min(backswingFrames.length, 2);
		          const topCount = Math.min(topFrames.length, 6);
			          const dsCount = Math.min(dsFrames.length, 8);
			          if (poseInputs.length >= 3) {
			            let poseError: string | null = null;
			            let poseFrames: Awaited<ReturnType<typeof extractPoseKeypointsFromImages>> = [];
			            try {
			              poseFrames = await extractPoseKeypointsFromImages({
			                frames: poseInputs.map((f) => ({ base64Image: f.base64Image, mimeType: f.mimeType })),
			              });
			            } catch (e) {
			              poseError = e instanceof Error ? e.message : String(e);
			              poseFrames = [];
			            }

		            const poseByIdx = new Map<number, Record<string, unknown>>();
		            const shaftByIdx = new Map<number, { x: number; y: number }>();
		            const metaByIdx = new Map<number, { frameIndex: number; timestampSec: number | undefined; phase: "backswing" | "top" | "downswing" | "impact" }>();
		            poseFrames.forEach((f) => {
		              if (!f || typeof f !== "object") return;
	              poseByIdx.set(f.idx, (f.pose as unknown as Record<string, unknown>) ?? {});
	              const rawVec = (f.club as unknown as { shaftVector?: unknown } | undefined)?.shaftVector ?? null;
	              const vec = toShaftVector(rawVec);
	              if (vec) shaftByIdx.set(f.idx, vec);
		            });
		            poseInputs.forEach((src, idx) => {
		              const mapped: "backswing" | "top" | "downswing" | "impact" =
		                idx < bsCount ? "backswing" : idx < bsCount + topCount ? "top" : idx < bsCount + topCount + dsCount ? "downswing" : "impact";
		              metaByIdx.set(idx, { frameIndex: src.frameIndex, timestampSec: src.timestampSec, phase: mapped });
		            });

		            const handTrace: Array<{ x: number; y: number; frameIndex: number; timestampSec?: number; phase: "backswing" | "top" | "downswing" | "impact" }> = [];
		            const bsHands: Array<{ x: number; y: number }> = [];
		            const topHands: Array<{ x: number; y: number }> = [];
		            const dsHands: Array<{ x: number; y: number }> = [];
		            const impHands: Array<{ x: number; y: number }> = [];
		            const bsVecs: Array<{ x: number; y: number }> = [];
		            const topVecs: Array<{ x: number; y: number }> = [];
		            const dsVecs: Array<{ x: number; y: number }> = [];
		            const impVecs: Array<{ x: number; y: number }> = [];
		            for (let i = 0; i < poseInputs.length; i += 1) {
		              const pose = poseByIdx.get(i) ?? null;
		              const hand = computeHandPosition(pose);
		              const vec = shaftByIdx.get(i) ?? null;
		              const meta = metaByIdx.get(i) ?? null;
		              if (!meta) continue;
		              if (hand) {
		                handTrace.push({ x: hand.x, y: hand.y, frameIndex: meta.frameIndex, timestampSec: meta.timestampSec, phase: meta.phase });
		                if (meta.phase === "backswing") bsHands.push(hand);
		                if (meta.phase === "top") topHands.push(hand);
		                if (meta.phase === "downswing") dsHands.push(hand);
		                if (meta.phase === "impact") impHands.push(hand);
		              }
		              if (vec) {
		                if (meta.phase === "backswing") bsVecs.push(vec);
		                if (meta.phase === "top") topVecs.push(vec);
		                if (meta.phase === "downswing") dsVecs.push(vec);
		                if (meta.phase === "impact") impVecs.push(vec);
		              }
		            }
		            handTrace.sort((a, b) => (a.timestampSec ?? a.frameIndex) - (b.timestampSec ?? b.frameIndex));
		            const bsHand = medianOf(bsHands);
		            const topHand = medianOf(topHands);
		            const dsHand = medianOf(dsHands);
		            const impHand = medianOf(impHands);
		            const bsVec = averageUnitDirections(bsVecs);
		            const topVec = averageUnitDirections(topVecs);
		            const dsVec = averageUnitDirections(dsVecs);
		            const impVec = averageUnitDirections(impVecs);
		            if (onPlaneUpdate) {
		              onPlaneUpdate.hand_points = {
		                backswing: bsHand,
		                top: topHand,
		                downswing: dsHand,
		                impact: impHand,
		              };
		              if (handTrace.length) onPlaneUpdate.hand_trace = handTrace;
		              // Clubhead/grip point (address) for zone anchor + reference plane.
              if (addressFrames.length) {
                try {
                  const addrFrames = addressFrames.filter(Boolean).slice(0, 3);
                  const addrZones: Array<{
                    clubhead: { x: number; y: number } | null;
                    grip: { x: number; y: number } | null;
                    ball: { x: number; y: number } | null;
                    shoulder: { x: number; y: number } | null;
                    clubhead_confidence: "high" | "medium" | "low";
                    grip_confidence: "high" | "medium" | "low";
                    ball_confidence: "high" | "medium" | "low";
                    shoulder_confidence: "high" | "medium" | "low";
                    debug?: {
                      roi?: { x: number; y: number; w: number; h: number };
                      roi_ball?: { x: number; y: number; w: number; h: number };
                      roi_grip?: { x: number; y: number; w: number; h: number };
                      roi_status?: "ok" | "crop_failed" | "error";
                      roi_error?: string;
                      candidate_scores?: Array<{
                        source?: string;
                        x: number;
                        y: number;
                        confidence: "high" | "medium" | "low";
                        score: number | null;
                        skipped?: boolean;
                      }>;
                      chosen_source?: string | null;
                      shaft_dir?: { x: number; y: number } | null;
                      hough_line?: { anchor: { x: number; y: number }; dir: { x: number; y: number }; score: number } | null;
                    };
                  }> = [];
                  for (const frame of addrFrames) {
                    const zone = await detectAddressZoneFromAddressFrame(frame, meta?.handedness ?? null);
                    if (zone) addrZones.push(zone);
                  }
                  const addrZone = mergeAddressZones(addrZones);
                  const rawClubhead = addrZone?.clubhead ?? null;
                  const gripPoint = addrZone?.grip ?? null;
                  const ballPoint = addrZone?.ball ?? null;
                  const derivedClubhead = (() => {
		                    if (rawClubhead || !ballPoint || !gripPoint) return null;
		                    const dx = ballPoint.x - gripPoint.x;
		                    const dy = ballPoint.y - gripPoint.y;
		                    const dist = Math.hypot(dx, dy);
		                    if (!Number.isFinite(dist) || dist < 1e-6) return null;
		                    const ux = dx / dist;
		                    const uy = dy / dist;
		                    // Perpendicular toward "left-down" from the shaft direction in DTL view.
		                    const px = -uy;
		                    const py = ux;
		                    const offset = clamp(dist * 0.05, 0.02, 0.06);
		                    return {
		                      x: clamp(ballPoint.x + px * offset, 0, 1),
		                      y: clamp(ballPoint.y + py * offset, 0, 1),
		                    };
		                  })();
		                  const clubheadFinal = rawClubhead ?? derivedClubhead ?? null;
		                  if (rawClubhead) (onPlaneUpdate as Record<string, unknown>).raw_clubhead_point = rawClubhead;
		                  if (derivedClubhead) (onPlaneUpdate as Record<string, unknown>).derived_clubhead_point = derivedClubhead;
		                  if (clubheadFinal) (onPlaneUpdate as Record<string, unknown>).clubhead_point = clubheadFinal;
                  if (ballPoint) (onPlaneUpdate as Record<string, unknown>).ball_point = ballPoint;
                  if (addrZone?.grip) (onPlaneUpdate as Record<string, unknown>).grip_point = addrZone.grip;
                  if (addrZone?.shoulder) (onPlaneUpdate as Record<string, unknown>).address_shoulder_point = addrZone.shoulder;
                  {
                    const poseLandmarks = await Promise.all(
                      addrFrames.map((f) => extractAddressPoseLandmarks(f, meta?.handedness ?? null)),
                    );
                    const firstPose = poseLandmarks.find((p) => p?.shoulder || p?.hip) ?? null;
                    const shoulder = firstPose?.shoulder ?? null;
                    let hip = firstPose?.hip ?? null;
                    if (shoulder && hip) {
                      const dy = hip.y - shoulder.y;
                      if (dy < 0.08 || dy > 0.32) {
                        hip = null;
                      } else {
                        const maxDy = 0.18;
                        if (dy > maxDy) {
                          hip = { x: hip.x, y: clamp(shoulder.y + maxDy, 0, 1) };
                        }
                      }
                    }
                    if (shoulder) (onPlaneUpdate as Record<string, unknown>).address_shoulder_point_pose = shoulder;
                    if (hip) (onPlaneUpdate as Record<string, unknown>).address_hip_point = hip;

                    if (!shoulder && addrZone?.side_shoulder) {
                      (onPlaneUpdate as Record<string, unknown>).address_shoulder_point_pose = addrZone.side_shoulder;
                    }
                    if (!hip && addrZone?.side_hip) {
                      const fallbackHip = addrZone.side_hip;
                      if (fallbackHip && shoulder) {
                        const dy = fallbackHip.y - shoulder.y;
                        if (dy < 0.08 || dy > 0.32) {
                          (onPlaneUpdate as Record<string, unknown>).address_hip_point = {
                            x: fallbackHip.x,
                            y: clamp(shoulder.y + 0.2, 0, 1),
                          };
                        } else {
                          (onPlaneUpdate as Record<string, unknown>).address_hip_point = fallbackHip;
                        }
                      } else if (fallbackHip) {
                        (onPlaneUpdate as Record<string, unknown>).address_hip_point = fallbackHip;
                      }
                    }
                  }
                  if (addrZone) {
                    (onPlaneUpdate as Record<string, unknown>).address_point_confidence = {
                      clubhead: addrZone.clubhead_confidence,
                      grip: addrZone.grip_confidence,
                      ball: addrZone.ball_confidence,
                      shoulder: addrZone.shoulder_confidence,
                    };
                    (onPlaneUpdate as Record<string, unknown>).address_debug =
                      addrZone.debug ?? { roi_status: "skipped" };
                    (onPlaneUpdate as Record<string, unknown>).clubhead_point_source = rawClubhead
                      ? "vision"
                      : derivedClubhead
                        ? "ball_perp_offset_fallback"
                        : "missing";
                  }
                } catch {
                  // ignore
                }
              }

              // Fallback: use pose-based right/left shoulder & hip from early backswing if address-specific points are missing.
              if (onPlaneUpdate && (!("address_shoulder_point_pose" in onPlaneUpdate) || !("address_hip_point" in onPlaneUpdate))) {
                const side = meta?.handedness === "left" ? "left" : "right";
                const pickPosePoint = (idx: number, name: string) => {
                  const p = poseByIdx.get(idx) ?? null;
                  return readPosePoint(p, [name, name.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)]);
                };
                const shoulderPts: Array<{ x: number; y: number }> = [];
                const hipPts: Array<{ x: number; y: number }> = [];
                for (let i = 0; i < poseInputs.length; i += 1) {
                  const metaInfo = metaByIdx.get(i);
                  if (metaInfo?.phase !== "backswing") continue;
                  const shoulder = pickPosePoint(i, `${side}Shoulder`);
                  const hip = pickPosePoint(i, `${side}Hip`);
                  if (shoulder) shoulderPts.push(shoulder);
                  if (hip) hipPts.push(hip);
                }
                const fallbackShoulder = medianOf(shoulderPts);
                const fallbackHip = medianOf(hipPts);
                if (fallbackShoulder && !(onPlaneUpdate as Record<string, unknown>).address_shoulder_point_pose) {
                  (onPlaneUpdate as Record<string, unknown>).address_shoulder_point_pose = fallbackShoulder;
                }
                if (fallbackHip && !(onPlaneUpdate as Record<string, unknown>).address_hip_point) {
                  (onPlaneUpdate as Record<string, unknown>).address_hip_point = fallbackHip;
                }
              }
		              if (process.env.NODE_ENV !== "production") {
		                const poseKeys = (idx: number) => {
		                  const p = poseByIdx.get(idx) ?? null;
		                  if (!p) return [];
	                  return Object.keys(p).slice(0, 20);
	                };
	                const poseSample = (idx: number) => {
	                  const p = poseByIdx.get(idx) ?? null;
	                  if (!p) return null;
	                  const pick = (k: string) => (p as Record<string, unknown>)[k];
	                  return {
	                    leftWrist: pick("leftWrist"),
	                    rightWrist: pick("rightWrist"),
	                    leftElbow: pick("leftElbow"),
	                    rightElbow: pick("rightElbow"),
	                    leftShoulder: pick("leftShoulder"),
	                    rightShoulder: pick("rightShoulder"),
	                    leftHip: pick("leftHip"),
	                    rightHip: pick("rightHip"),
	                  };
	                };
		                (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                  model: process.env.OPENAI_POSE_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o",
		                  returned: poseFrames.length,
		                  // capture errors to verify pose extraction is actually running
		                  ...(poseError ? { error: poseError.slice(0, 240) } : {}),
		                  hasTopHand: !!topHand,
		                  hasBackHand: !!bsHand,
		                  hasDownHand: !!dsHand,
		                  hasImpactHand: !!impHand,
		                  hasBackShaft: !!bsVec,
		                  hasTopShaft: !!topVec,
		                  hasDownShaft: !!dsVec,
		                  hasImpactShaft: !!impVec,
		                  backHandCount: bsHands.length,
		                  topHandCount: topHands.length,
		                  downHandCount: dsHands.length,
		                  impactHandCount: impHands.length,
		                  poseKeys: {
		                    backswing: poseKeys(0),
		                    top: poseKeys(Math.min(bsCount, poseInputs.length - 1)),
		                    downswing: poseKeys(Math.min(bsCount + topCount, poseInputs.length - 1)),
		                    impact: poseKeys(Math.min(bsCount + topCount + dsCount, poseInputs.length - 1)),
		                  },
	                  poseSample: {
	                    backswing: poseSample(0),
	                    top: poseSample(Math.min(bsCount, poseInputs.length - 1)),
	                    downswing: poseSample(Math.min(bsCount + topCount, poseInputs.length - 1)),
	                    impact: poseSample(Math.min(bsCount + topCount + dsCount, poseInputs.length - 1)),
	                  },
		                };
		              }
		            }

	            // If we already have plane lines (e.g. LLM-generated), compute "evidence segment" from hands even when shaftVector is missing.
		            if (onPlaneUpdate) {
		              const op = onPlaneUpdate as Record<string, unknown>;
		              const visual = op.visual && typeof op.visual === "object" ? (op.visual as Record<string, unknown>) : null;
		              const backLine =
		                normalizePlaneLine01(op.backswing_plane ?? op.backswingPlane ?? op.back_plane ?? op.backPlane) ??
		                normalizePlaneLine01(visual?.backswing_plane);
		              const downLine =
		                normalizePlaneLine01(op.downswing_plane ?? op.downswingPlane ?? op.down_plane ?? op.downPlane) ??
		                normalizePlaneLine01(visual?.downswing_plane);
		              if (backLine) {
		                const seg = computeLineEvidenceSegment(backLine, [...topHands, ...(topHand ? [topHand] : [])]);
		                if (seg) op.backswing_plane_evidence = seg;
		              }
		              if (downLine) {
		                const seg = computeLineEvidenceSegment(downLine, [...dsHands, ...impHands, ...(dsHand ? [dsHand] : []), ...(impHand ? [impHand] : [])]);
		                if (seg) op.downswing_plane_evidence = seg;
		              }
		            }

		            const downVec = averageDirections(dsVec, impVec);
		            const clubheadPoint =
		              (onPlaneUpdate as Record<string, unknown>)?.clubhead_point && typeof (onPlaneUpdate as Record<string, unknown>).clubhead_point === "object"
		                ? normalizePoint01((onPlaneUpdate as Record<string, unknown>).clubhead_point)
		                : null;
		            const ballPoint =
		              (onPlaneUpdate as Record<string, unknown>)?.ball_point && typeof (onPlaneUpdate as Record<string, unknown>).ball_point === "object"
		                ? normalizePoint01((onPlaneUpdate as Record<string, unknown>).ball_point)
		                : null;
		            const gripPoint =
		              (onPlaneUpdate as Record<string, unknown>)?.grip_point && typeof (onPlaneUpdate as Record<string, unknown>).grip_point === "object"
		                ? normalizePoint01((onPlaneUpdate as Record<string, unknown>).grip_point)
		                : null;
		            const anchorForRef = clubheadPoint ?? ballPoint;
		            const addrShaftVec = anchorForRef && gripPoint ? { x: gripPoint.x - anchorForRef.x, y: gripPoint.y - anchorForRef.y } : null;
		            const fallbackRefVec = bsVec ?? downVec ?? dsVec ?? impVec;
		            const referencePlane = anchorForRef
		              ? buildLineThroughUnitBox({ anchor: anchorForRef, dir: addrShaftVec ?? fallbackRefVec ?? { x: 1, y: -1 } })
		              : null;
		            const downswingPlane = (dsHand ?? impHand) && downVec ? buildLineThroughUnitBox({ anchor: dsHand ?? impHand, dir: downVec }) : null;

		            if (onPlaneUpdate) {
		              if (referencePlane) onPlaneUpdate.reference_plane = referencePlane;
		              if (downswingPlane) onPlaneUpdate.downswing_plane = downswingPlane;
		              if (referencePlane) {
		                const seg = computeLineEvidenceSegment(referencePlane, [
		                  ...(zoneAnchor ? [zoneAnchor] : []),
		                  ...(addrHands.length ? addrHands : []),
		                  ...(addrHand ? [addrHand] : []),
		                ]);
		                if (seg) onPlaneUpdate.reference_plane_evidence = seg;
		              }
		              if (downswingPlane) {
		                const seg = computeLineEvidenceSegment(downswingPlane, [...dsHands, ...impHands, ...(dsHand ? [dsHand] : []), ...(impHand ? [impHand] : [])]);
		                if (seg) onPlaneUpdate.downswing_plane_evidence = seg;
		              }
		              if (referencePlane || downswingPlane) {
		                onPlaneUpdate.plane_source = "shaft_vector_2d";
		                onPlaneUpdate.plane_confidence = referencePlane ? "medium" : "low";
		              }

		              // If pose-based hands are missing or collapsed to (almost) the same point, fallback to a grip-only vision extraction.
		              const tracePts = (onPlaneUpdate.hand_trace as unknown as Array<{ x: number; y: number; phase: string }> | undefined) ?? [];
		              const spread = (() => {
		                const pts = tracePts.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
		                if (pts.length < 2) return 0;
		                let minX = 1, minY = 1, maxX = 0, maxY = 0;
		                for (const p of pts) {
		                  minX = Math.min(minX, p.x);
		                  minY = Math.min(minY, p.y);
		                  maxX = Math.max(maxX, p.x);
		                  maxY = Math.max(maxY, p.y);
		                }
		                return Math.hypot(maxX - minX, maxY - minY);
		              })();
		              const needsGripFallback =
		                !tracePts.length ||
		                spread < 0.03 ||
		                (!topHand && !dsHand && !impHand);

		              if (needsGripFallback) {
		                try {
		                  const gripFrames = poseInputs.map((f) => ({ base64Image: f.base64Image, mimeType: f.mimeType, timestampSec: f.timestampSec }));
		                  const grips = await extractGripCentersFromFrames({ frames: gripFrames });
		                  const addrGrip =
		                    (onPlaneUpdate as Record<string, unknown>)?.grip_point &&
		                    typeof (onPlaneUpdate as Record<string, unknown>).grip_point === "object"
		                      ? normalizePoint01((onPlaneUpdate as Record<string, unknown>).grip_point)
		                      : null;
		                  const refined = await refineGripCentersWithRoi({ frames: gripFrames, initial: grips, anchor: addrGrip });
		                  const gripsFinal = refined.refined;
		                  const gripTrace: Array<{ x: number; y: number; frameIndex: number; timestampSec?: number; phase: "backswing" | "top" | "downswing" | "impact" }> = [];
		                  gripsFinal.forEach((g) => {
		                    const meta = metaByIdx.get(g.idx) ?? null;
		                    if (!meta || !g.grip) return;
		                    gripTrace.push({ x: g.grip.x, y: g.grip.y, frameIndex: meta.frameIndex, timestampSec: meta.timestampSec, phase: meta.phase });
		                  });
		                  gripTrace.sort((a, b) => (a.timestampSec ?? a.frameIndex) - (b.timestampSec ?? b.frameIndex));
		                  if (gripTrace.length >= 2) {
		                    onPlaneUpdate.hand_trace = gripTrace;
		                    const byPhase = (ph: "backswing" | "top" | "downswing" | "impact") =>
		                      medianOf(gripTrace.filter((p) => p.phase === ph).map((p) => ({ x: p.x, y: p.y })));
		                    onPlaneUpdate.hand_points = {
		                      backswing: byPhase("backswing"),
		                      top: byPhase("top"),
		                      downswing: byPhase("downswing"),
		                      impact: byPhase("impact"),
		                    };
		                    if (process.env.NODE_ENV !== "production") {
		                      (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                        ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		                        grip_fallback_used: true,
		                        grip_fallback_points: gripTrace.length,
		                        grip_fallback_roi_refined: refined.refinedCount,
		                        grip_fallback_roi_frames: refined.refinedFrames,
		                        grip_fallback_sample: gripTrace.slice(0, 5).map((p) => ({ x: p.x, y: p.y, phase: p.phase })),
		                      };
		                    }
		                  }
		                } catch (e) {
		                  if (process.env.NODE_ENV !== "production") {
		                    (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                      ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		                      grip_fallback_error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
		                    };
		                  }
		                }
		              }

		              // Zone-based on-plane evaluation (downswing only).
		              const traceForEval = ((onPlaneUpdate as Record<string, unknown>).hand_trace as unknown as Array<{ x: number; y: number; phase: string }>) ?? [];
		              const downswingOnly = traceForEval.filter((p) => p.phase === "downswing").map((p) => ({ x: p.x, y: p.y }));
		              const evalRefLine =
		                referencePlane ??
		                normalizePlaneLine01((onPlaneUpdate as Record<string, unknown>).reference_plane) ??
		                downswingPlane ??
		                normalizePlaneLine01((onPlaneUpdate as Record<string, unknown>).downswing_plane) ??
		                null;
		              const calibratedThetaDeg = (() => {
		                const shoulderPoint =
		                  (onPlaneUpdate as Record<string, unknown>)?.address_shoulder_point &&
		                  typeof (onPlaneUpdate as Record<string, unknown>).address_shoulder_point === "object"
		                    ? normalizePoint01((onPlaneUpdate as Record<string, unknown>).address_shoulder_point)
		                    : null;
		                if (!shoulderPoint || !anchorForRef || !evalRefLine) return 10;
		                const dx = evalRefLine.x2 - evalRefLine.x1;
		                const dy = evalRefLine.y2 - evalRefLine.y1;
		                const baseAng = Math.atan2(dy, dx);
		                const vx = shoulderPoint.x - anchorForRef.x;
		                const vy = shoulderPoint.y - anchorForRef.y;
		                const vAng = Math.atan2(vy, vx);
		                const d = Math.atan2(Math.sin(vAng - baseAng), Math.cos(vAng - baseAng));
		                const deg = Math.abs((d * 180) / Math.PI);
		                return clamp(deg, 4, 20);
		              })();
		              // Persist theta even if we can't compute the full eval (UI still needs the zone geometry).
		              (onPlaneUpdate as Record<string, unknown>).zone_theta_deg = calibratedThetaDeg;
		              const zoneEval = computeOnPlaneZoneEval({
		                handedness: meta?.handedness,
		                thetaDeg: calibratedThetaDeg,
		                anchor: anchorForRef ?? dsHand ?? impHand ?? topHand,
		                referenceLine: evalRefLine,
		                downswingTrace: downswingOnly.length ? downswingOnly : traceForEval.map((p) => ({ x: p.x, y: p.y })),
		              });
		              if (zoneEval) {
		                (onPlaneUpdate as Record<string, unknown>).on_plane_rating = zoneEval.on_plane_rating;
		                (onPlaneUpdate as Record<string, unknown>).zone_stay_ratio = zoneEval.zone_stay_ratio;
		                (onPlaneUpdate as Record<string, unknown>).primary_deviation = zoneEval.primary_deviation;
		                (onPlaneUpdate as Record<string, unknown>).key_observation = zoneEval.key_observation;
		                (onPlaneUpdate as Record<string, unknown>).coaching_comment = zoneEval.coaching_comment;
		                (onPlaneUpdate as Record<string, unknown>).zone_theta_deg = zoneEval.zone_theta_deg;
		                // Derive score emphasizing mid segment behavior.
		                const derivedScore = clamp(Math.round(zoneEval.zone_stay_ratio_value * 0.8 + 20), 0, 100);
		                if (typeof (onPlaneUpdate as Record<string, unknown>).score !== "number") {
		                  (onPlaneUpdate as Record<string, unknown>).score = derivedScore;
		                }
		              }
		            }
		          }
		        } catch {
		          // ignore (keep LLM output)
		        }
      }
    }
  } catch (err) {
    console.error("[reanalyze-phases] vision failed", err);
    return json({ error: "reanalyze failed" }, { status: 502 });
  }

  // Soft enforcement: if on-plane indicates a meaningful outside bias in Top→Downswing / late downswing,
  // treat it as "outside-in tendency" unless a confirmed label already exists.
  // This plugs cases where the phase-only prompt misses the trajectory issue.
  if (phaseUpdates.downswing && onPlaneUpdate) {
    const op = onPlaneUpdate as Record<string, unknown>;
    const opScore = readFiniteNumber(op.score);
    const tds = readFiniteNumber(op.top_to_downswing_cm ?? op.topToDownswingCm ?? op.top_to_downswing);
    const late = readFiniteNumber(op.late_downswing_cm ?? op.lateDownswingCm ?? op.downswing_late_cm ?? op.downswingLateCm);
    const isMeaningfulOutside =
      (opScore != null ? opScore <= 80 : true) &&
      ((tds != null && tds >= 3) || (late != null && late >= 3));

    if (isMeaningfulOutside) {
      const ds = phaseUpdates.downswing;
      const issues = Array.isArray(ds.issues) ? ds.issues : [];
      const hasConfirmed = issues.some((t) => /アウトサイドイン（確定）|カット軌道（確定）|外から下りる（確定）/.test(t));
      const hasTendency = issues.some((t) => /外から入りやすい傾向/.test(t));
      if (!hasConfirmed) {
        if (!hasTendency) ds.issues = ["外から入りやすい傾向", ...issues].slice(0, 4);
        ds.issues = ds.issues.filter((t) => !/（確定）/.test(t));
        ds.score = Math.min(ds.score, 12);
      }
    }
  }

  const nextResult = {
    ...stored.result,
    phases: {
      ...stored.result.phases,
      ...(phaseUpdates.address ? { address: phaseUpdates.address } : null),
      ...(phaseUpdates.backswing ? { backswing: phaseUpdates.backswing } : null),
      ...(phaseUpdates.top ? { top: phaseUpdates.top } : null),
      ...(phaseUpdates.downswing ? { downswing: phaseUpdates.downswing } : null),
      ...(phaseUpdates.impact ? { impact: phaseUpdates.impact } : null),
      ...(phaseUpdates.finish ? { finish: phaseUpdates.finish } : null),
    },
  };

  const nextTotal = computeTotalScoreFromPhases(nextResult.phases as Record<string, { score?: number }>);
  const rescored = rescoreSwingAnalysis({
    result: { ...(nextResult as SwingAnalysis), totalScore: nextTotal },
    deriveFromText: true,
  });
  // If we didn't reanalyze downswing/impact, but they have no issues and are already very high,
  // promote to full score to avoid an unexplained "18/20" with empty improvements.
  promoteHighNoIssueScores(rescored.phases as unknown as Record<string, { score?: number; good?: string[]; issues?: string[]; advice?: string[] }>);
  rescored.totalScore = computeTotalScoreFromPhases(rescored.phases as unknown as Record<string, { score?: number }>);

  let previousReport: SwingAnalysis | null = null;
  const previousAnalysisId = stored.meta?.previousAnalysisId ?? null;
  if (typeof previousAnalysisId === "string" && previousAnalysisId !== analysisId) {
    const previousLoaded = await loadAuthorizedAnalysis(req, previousAnalysisId as AnalysisId);
    if (!previousLoaded.error && "stored" in previousLoaded) {
      previousReport = previousLoaded.stored.result ?? null;
    }
  }

  const phaseComparison = previousReport ? buildPhaseComparison(previousReport, rescored) : null;
  const previousOnPlane =
    (previousReport as unknown as Record<string, unknown> | null)?.on_plane ??
    (previousReport as unknown as Record<string, unknown> | null)?.onPlane ??
    null;
  const finalResult = {
    ...rescored,
    comparison: phaseComparison ?? rescored.comparison,
    on_plane:
      onPlaneUpdate
        ? { ...onPlaneUpdate, ...(previousOnPlane ? { previous: previousOnPlane } : null) }
        : (stored.result as unknown as Record<string, unknown>)?.on_plane ?? null,
  };

  const updated = {
    ...stored,
    meta: {
      ...(stored.meta ?? {}),
      phaseOverrideSig: requestedOverrideSig,
      phaseReevalVersion: PHASE_REEVAL_VERSION,
      ...(fixedAddressIndex ? { addressFrameIndex: fixedAddressIndex } : null),
      phaseOverrideFrames: {
        ...(effectiveAddressIndices.length ? { address: effectiveAddressIndices } : null),
        ...(backswingIndices.length ? { backswing: backswingIndices } : null),
        ...(topIndices.length ? { top: topIndices } : null),
        ...(downswingIndices.length ? { downswing: downswingIndices } : null),
        ...(impactIndices.length ? { impact: impactIndices } : null),
        ...(finishIndices.length ? { finish: finishIndices } : null),
      },
    },
    result: finalResult,
  };
  await saveAnalysis(updated);

  const res = json(
    {
      analysisId,
      result: finalResult,
      meta: updated.meta,
      createdAt: stored.createdAt,
    },
    { status: 200 }
  );
  if (account?.authProvider === "google") setActiveAuthOnResponse(res, "google");
  if (account?.authProvider === "email") setActiveAuthOnResponse(res, "email");
  return res;
}
