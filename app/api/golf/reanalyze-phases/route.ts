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
import { extractVideoWindowFrames } from "@/app/lib/vision/extractVideoWindowFrames";
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

function buildBestFitLine01(points: Array<{ x: number; y: number }>): { x1: number; y1: number; x2: number; y2: number } | null {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 2) return null;
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
  if (!Number.isFinite(norm) || norm < 1e-6) {
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    vx = b.x - a.x;
    vy = b.y - a.y;
  }
  return buildLineThroughUnitBox({ anchor: { x: meanX, y: meanY }, dir: { x: vx, y: vy } });
}

function computeTraceSpread(points: Array<{ x: number; y: number }>): number {
  if (points.length < 2) return 0;
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

function countTraceUnique(points: Array<{ x: number; y: number }>, precision: number = 0.01): number {
  if (!points.length) return 0;
  const step = Math.max(precision, 0.001);
  const seen = new Set<string>();
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const key = `${Math.round(p.x / step)}:${Math.round(p.y / step)}`;
    seen.add(key);
  }
  return seen.size;
}

function countTracePhases(points: Array<{ phase?: string | null }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of points) {
    const key = String(p?.phase ?? "");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function buildPhaseWiseTrace(
  gripTrace: Array<{ x: number; y: number; phase?: string; frameIndex?: number; timestampSec?: number }>,
  poseTrace: Array<{ x: number; y: number; phase?: string; frameIndex?: number; timestampSec?: number }>
): Array<{ x: number; y: number; phase?: string; frameIndex?: number; timestampSec?: number }> {
  const phases: Array<"backswing" | "top" | "downswing" | "impact"> = ["backswing", "top", "downswing", "impact"];
  const picked: Array<{ x: number; y: number; phase?: string; frameIndex?: number; timestampSec?: number }> = [];
  for (const phase of phases) {
    const g = gripTrace.filter((p) => p.phase === phase);
    const p = poseTrace.filter((p) => p.phase === phase);
    if (!g.length && !p.length) continue;
    const gSpread = computeTraceSpread(g);
    const pSpread = computeTraceSpread(p);
    let useGrip = false;
    if (phase === "top") {
      useGrip = g.length > 0 && p.length === 0;
    } else if (phase === "backswing") {
      useGrip = g.length > 0 && (p.length < 2 || gSpread >= pSpread * 0.9);
    } else {
      useGrip = g.length > 0 && (p.length < 2 || gSpread > pSpread * 1.1);
    }
    const chosen = useGrip ? g : p.length ? p : g;
    picked.push(...chosen);
  }
  const hasTop = picked.some((p) => p.phase === "top");
  if (!hasTop) {
    const topFromGrip = medianOf(gripTrace.filter((p) => p.phase === "top").map((p) => ({ x: p.x, y: p.y })));
    const topFromPose = medianOf(poseTrace.filter((p) => p.phase === "top").map((p) => ({ x: p.x, y: p.y })));
    const topPoint = topFromGrip ?? topFromPose ?? null;
    if (topPoint) {
      picked.push({ ...topPoint, phase: "top" });
    } else {
      const backMed = medianOf(picked.filter((p) => p.phase === "backswing").map((p) => ({ x: p.x, y: p.y })));
      const downMed = medianOf(picked.filter((p) => p.phase === "downswing").map((p) => ({ x: p.x, y: p.y })));
      if (backMed && downMed) {
        picked.push({ x: (backMed.x + downMed.x) / 2, y: (backMed.y + downMed.y) / 2, phase: "top" });
      }
    }
  }
  return picked.sort((a, b) => (a.timestampSec ?? a.frameIndex ?? 0) - (b.timestampSec ?? b.frameIndex ?? 0));
}

function smoothTrace(
  points: Array<{ x: number; y: number; phase?: string; frameIndex?: number; timestampSec?: number }>
): Array<{ x: number; y: number; phase?: string; frameIndex?: number; timestampSec?: number }> {
  if (points.length < 3) return points;
  return points.map((p, idx) => {
    const neighbors: Array<{ x: number; y: number }> = [];
    for (let i = Math.max(0, idx - 1); i <= Math.min(points.length - 1, idx + 1); i += 1) {
      const n = points[i];
      if (!n || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      neighbors.push({ x: n.x, y: n.y });
    }
    if (!neighbors.length) return p;
    const sum = neighbors.reduce((acc, n) => ({ x: acc.x + n.x, y: acc.y + n.y }), { x: 0, y: 0 });
    const next = { x: sum.x / neighbors.length, y: sum.y / neighbors.length };
    return { ...p, ...next };
  });
}

function smoothTraceEma(
  points: Array<{ x: number; y: number; phase?: string; frameIndex?: number; timestampSec?: number }>,
  alpha: number
): Array<{ x: number; y: number; phase?: string; frameIndex?: number; timestampSec?: number }> {
  if (points.length < 2) return points;
  const a = clamp(alpha, 0.05, 0.9);
  let prev = { x: points[0]!.x, y: points[0]!.y };
  const out: Array<{ x: number; y: number; phase?: string; frameIndex?: number; timestampSec?: number }> = [];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]!;
    const next = { x: a * p.x + (1 - a) * prev.x, y: a * p.y + (1 - a) * prev.y };
    out.push({ ...p, ...next });
    prev = next;
  }
  return out;
}

function densifyTrace(
  points: Array<{ x: number; y: number; phase?: string; frameIndex?: number; timestampSec?: number }>,
  targetCount: number
): Array<{ x: number; y: number; phase?: string; frameIndex?: number; timestampSec?: number }> {
  if (points.length < 2 || points.length >= targetCount) return points;
  const sorted = [...points].sort((a, b) => (a.timestampSec ?? a.frameIndex ?? 0) - (b.timestampSec ?? b.frameIndex ?? 0));
  const catmullRom = (p0: { x: number; y: number }, p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }, t: number) => {
    const t2 = t * t;
    const t3 = t2 * t;
    return {
      x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    };
  };
  const perSegment = Math.max(1, Math.ceil((targetCount - sorted.length) / Math.max(1, sorted.length - 1)));
  const densified: Array<{ x: number; y: number; phase?: string; frameIndex?: number; timestampSec?: number }> = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const p1 = sorted[i]!;
    const p2 = sorted[i + 1]!;
    const p0 = sorted[i - 1] ?? p1;
    const p3 = sorted[i + 2] ?? p2;
    densified.push(p1);
    for (let j = 1; j <= perSegment; j += 1) {
      const t = j / (perSegment + 1);
      const interp = catmullRom(p0, p1, p2, p3, t);
      densified.push({
        x: clamp(interp.x, 0, 1),
        y: clamp(interp.y, 0, 1),
        phase: p1.phase,
        frameIndex: p1.frameIndex,
        timestampSec: p1.timestampSec,
      });
    }
  }
  densified.push(sorted[sorted.length - 1]!);
  return densified;
}

function densifyTraceByWindows(
  points: Array<{ x: number; y: number; phase?: string; frameIndex?: number; timestampSec?: number }>,
  windows: Array<{ start: number; end: number }>,
  extraPoints: number
): { points: Array<{ x: number; y: number; phase?: string; frameIndex?: number; timestampSec?: number }>; inserted: number } {
  if (points.length < 2 || !windows.length || extraPoints <= 0) {
    return { points, inserted: 0 };
  }
  const sorted = [...points].sort((a, b) => (a.timestampSec ?? a.frameIndex ?? 0) - (b.timestampSec ?? b.frameIndex ?? 0));
  const catmullRom = (p0: { x: number; y: number }, p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }, t: number) => {
    const t2 = t * t;
    const t3 = t2 * t;
    return {
      x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    };
  };
  const inWindow = (t: number) => windows.some((w) => t >= w.start && t <= w.end);
  const densified: Array<{ x: number; y: number; phase?: string; frameIndex?: number; timestampSec?: number }> = [];
  let inserted = 0;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const p1 = sorted[i]!;
    const p2 = sorted[i + 1]!;
    densified.push(p1);
    const t1 = p1.timestampSec ?? p1.frameIndex ?? 0;
    const t2 = p2.timestampSec ?? p2.frameIndex ?? 0;
    if (!inWindow(t1) && !inWindow(t2)) continue;
    const p0 = sorted[i - 1] ?? p1;
    const p3 = sorted[i + 2] ?? p2;
    for (let j = 1; j <= extraPoints; j += 1) {
      const t = j / (extraPoints + 1);
      const interp = catmullRom(p0, p1, p2, p3, t);
      densified.push({
        x: clamp(interp.x, 0, 1),
        y: clamp(interp.y, 0, 1),
        phase: p1.phase,
        frameIndex: p1.frameIndex,
        timestampSec: typeof p1.timestampSec === "number" && typeof p2.timestampSec === "number"
          ? p1.timestampSec + (p2.timestampSec - p1.timestampSec) * t
          : p1.timestampSec,
      });
      inserted += 1;
    }
  }
  densified.push(sorted[sorted.length - 1]!);
  return { points: densified, inserted };
}

function estimateFpsFromMeta(
  metaByIdxPose: Map<number, { timestampSec?: number }>
): number {
  const times: number[] = [];
  metaByIdxPose.forEach((m) => {
    if (typeof m.timestampSec === "number" && Number.isFinite(m.timestampSec)) times.push(m.timestampSec);
  });
  if (times.length < 2) return 30;
  times.sort((a, b) => a - b);
  const diffs: number[] = [];
  for (let i = 1; i < times.length; i += 1) {
    const dt = times[i]! - times[i - 1]!;
    if (dt > 0.001 && dt < 0.5) diffs.push(dt);
  }
  if (!diffs.length) return 30;
  diffs.sort((a, b) => a - b);
  const mid = diffs[Math.floor(diffs.length / 2)]!;
  return mid > 0 ? clamp(1 / mid, 5, 120) : 30;
}

function reconstructHandTrajectoryFromPoseFrames(params: {
  poseByIdx: Map<number, Record<string, unknown>>;
  metaByIdxPose: Map<number, { frameIndex: number; timestampSec?: number; phase: "backswing" | "top" | "downswing" | "impact" }>;
  frameCount: number;
  handedness?: "left" | "right" | null;
}): {
  raw: Array<{ x: number; y: number; conf: number; phase: "backswing" | "top" | "downswing" | "impact"; frameIndex: number; timestampSec?: number } | null>;
  filtered: Array<{ x: number; y: number; conf: number; phase: "backswing" | "top" | "downswing" | "impact"; frameIndex: number; timestampSec?: number } | null>;
  smoothed: Array<{ x: number; y: number; phase: "backswing" | "top" | "downswing" | "impact"; frameIndex: number; timestampSec?: number }>;
  downswing: Array<{ x: number; y: number; phase: "backswing" | "top" | "downswing" | "impact"; frameIndex: number; timestampSec?: number }>;
  debug: {
    fps: number;
    rawCount: number;
    filteredCount: number;
    interpolatedCount: number;
    roiRejected: number;
    speedRejected: number;
    accelRejected: number;
    shoulderWidthMedian: number | null;
  };
} | null {
  if (params.frameCount < 2) return null;
  const fps = estimateFpsFromMeta(params.metaByIdxPose);
  const raw: Array<{ x: number; y: number; conf: number; phase: "backswing" | "top" | "downswing" | "impact"; frameIndex: number; timestampSec?: number } | null> = [];
  const filtered: Array<{ x: number; y: number; conf: number; phase: "backswing" | "top" | "downswing" | "impact"; frameIndex: number; timestampSec?: number } | null> = [];
  const candidates: Array<{ x: number; y: number; conf: number; phase: "backswing" | "top" | "downswing" | "impact"; frameIndex: number; timestampSec?: number } | null> = [];
  const transforms: Array<{ origin: { x: number; y: number }; scale: number } | null> = new Array(params.frameCount).fill(null);
  const shoulderAvailable: boolean[] = new Array(params.frameCount).fill(false);
  const hipAvailable: boolean[] = new Array(params.frameCount).fill(false);
  const localIdxByFrameIndex = new Map<number, number>();
  const shoulderWidths: number[] = [];
  for (let i = 0; i < params.frameCount; i += 1) {
    const pose = params.poseByIdx.get(i) ?? null;
    const meta = params.metaByIdxPose.get(i) ?? null;
    if (!meta) {
      candidates.push(null);
      continue;
    }
    localIdxByFrameIndex.set(meta.frameIndex, i);
    const lw = readPosePoint(pose, ["leftWrist", "left_wrist", "leftHand", "left_hand"]);
    const rw = readPosePoint(pose, ["rightWrist", "right_wrist", "rightHand", "right_hand"]);
    const ls = readPosePoint(pose, ["leftShoulder", "left_shoulder"]);
    const rs = readPosePoint(pose, ["rightShoulder", "right_shoulder"]);
    const lh = readPosePoint(pose, ["leftHip", "left_hip"]);
    const rh = readPosePoint(pose, ["rightHip", "right_hip"]);
    const shoulderMid = ls && rs ? { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 } : null;
    const hipMid = lh && rh ? { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 } : null;
    const shoulderWidth = ls && rs ? Math.hypot(ls.x - rs.x, ls.y - rs.y) : null;
    if (shoulderWidth) shoulderWidths.push(shoulderWidth);
    if (shoulderMid && shoulderWidth && Number.isFinite(shoulderWidth) && shoulderWidth > 1e-4) {
      transforms[i] = { origin: shoulderMid, scale: shoulderWidth };
      shoulderAvailable[i] = true;
    }
    if (hipMid) hipAvailable[i] = true;
    const lead = computeLeadHandPosition(pose, params.handedness ?? null);
    const avg = computeHandPositionAverage(pose);
    let candidate: { x: number; y: number; conf: number } | null = null;
    if (lw && rw) {
      candidate = { x: (lw.x + rw.x) / 2, y: (lw.y + rw.y) / 2, conf: 1.0 };
    } else if (lead) {
      candidate = { x: lead.x, y: lead.y, conf: 0.85 };
    } else if (avg) {
      candidate = { x: avg.x, y: avg.y, conf: 0.75 };
    } else if ((lw || rw) && shoulderMid) {
      const w = lw ?? rw!;
      candidate = {
        x: w.x + (shoulderMid.x - w.x) * 0.15,
        y: w.y + (shoulderMid.y - w.y) * 0.15,
        conf: 0.6,
      };
    }
    if (!candidate) {
      candidates.push(null);
      continue;
    }
    candidates.push({
      x: candidate.x,
      y: candidate.y,
      conf: candidate.conf,
      phase: meta.phase,
      frameIndex: meta.frameIndex,
      timestampSec: meta.timestampSec,
    });
  }
  const shoulderWidthMedianRaw = shoulderWidths.length ? shoulderWidths.sort((a, b) => a - b)[Math.floor(shoulderWidths.length / 2)]! : null;
  const shoulderWidthMedian =
    shoulderWidthMedianRaw && Number.isFinite(shoulderWidthMedianRaw)
      ? clamp(shoulderWidthMedianRaw, 0.12, 0.35)
      : null;
  const firstTransform = transforms.find((t) => t) ?? null;
  if (firstTransform) {
    for (let i = 0; i < transforms.length && !transforms[i]; i += 1) {
      transforms[i] = firstTransform;
    }
  }
  let lastTransform: { origin: { x: number; y: number }; scale: number } | null = null;
  for (let i = 0; i < transforms.length; i += 1) {
    if (transforms[i]) {
      lastTransform = transforms[i];
    } else if (lastTransform) {
      transforms[i] = lastTransform;
    }
  }
  const toLocal = (p: { x: number; y: number }, t: { origin: { x: number; y: number }; scale: number }) => ({
    x: (p.x - t.origin.x) / t.scale,
    y: (p.y - t.origin.y) / t.scale,
  });
  const toGlobal = (p: { x: number; y: number }, t: { origin: { x: number; y: number }; scale: number }) => ({
    x: t.origin.x + p.x * t.scale,
    y: t.origin.y + p.y * t.scale,
  });
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const transform = transforms[i];
    if (!candidate || !transform) {
      raw.push(null);
      filtered.push(null);
      continue;
    }
    const local = toLocal(candidate, transform);
    raw.push({ ...candidate, x: local.x, y: local.y });
    filtered.push({ ...candidate, x: local.x, y: local.y });
  }
  const confidenceMin = 0.15;
  const lowMask = new Array(filtered.length).fill(false);
  let lowStreak = 0;
  for (let i = 0; i < filtered.length; i += 1) {
    const cur = filtered[i];
    if (!cur) {
      lowStreak = 0;
      continue;
    }
    if (cur.conf < confidenceMin) {
      lowStreak += 1;
      if (lowStreak >= 2) {
        lowMask[i] = true;
        if (i > 0) lowMask[i - 1] = true;
      }
    } else {
      lowStreak = 0;
    }
  }
  let roiRejected = 0;
  let speedRejected = 0;
  let accelRejected = 0;
  let prevValid: { x: number; y: number; frameIndex: number; timestampSec?: number } | null = null;
  let prevPrevValid: { x: number; y: number; frameIndex: number; timestampSec?: number } | null = null;
  let roiCenterLocal: { x: number; y: number } | null = null;
  let roiScale = 1;
  let roiMissingStreak = 0;
  for (let i = 0; i < filtered.length; i += 1) {
    const cur = filtered[i];
    if (lowMask[i]) {
      filtered[i] = null;
      continue;
    }
    if (!cur) continue;
    const pose = params.poseByIdx.get(i) ?? null;
    const lh = readPosePoint(pose, ["leftHip", "left_hip"]);
    const rh = readPosePoint(pose, ["rightHip", "right_hip"]);
    const transform = transforms[i];
    const hipMid = lh && rh ? { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 } : null;
    const hipLocal = hipMid && transform ? toLocal(hipMid, transform) : null;
    const hasBodyAnchor = shoulderAvailable[i] || hipAvailable[i];
    if (hasBodyAnchor && hipLocal) {
      const hipCenter = { x: hipLocal.x * 0.5, y: hipLocal.y * 0.5 };
      const hipCenterOk = hipCenter.y > -0.3 && hipCenter.y < 0.9;
      if (hipCenterOk) {
        roiCenterLocal = hipCenter;
        roiScale = 1;
        roiMissingStreak = 0;
      } else if (transform) {
        roiCenterLocal = { x: 0, y: 0.35 };
        roiScale = 1;
        roiMissingStreak = 0;
      }
    } else if (hasBodyAnchor && transform) {
      roiCenterLocal = { x: 0, y: 0.35 };
      roiScale = 1;
      roiMissingStreak = 0;
    } else if (roiCenterLocal) {
      roiMissingStreak += 1;
      const targetScale = roiMissingStreak >= 3 ? 1.8 : roiMissingStreak >= 2 ? 1.4 : 1.1;
      roiScale = clamp(roiScale * targetScale, 1, 1.8);
    }
    const torsoLocal = roiCenterLocal ?? { x: 0, y: 0.35 };
    const confScale = cur.conf < 1 ? 0.9 : 1;
    if (roiMissingStreak < 3) {
      const R = (2.2 * confScale + 0.2) * roiScale;
      const d = Math.hypot(cur.x - torsoLocal.x, cur.y - torsoLocal.y);
      const yMin = torsoLocal.y - (1.2 * confScale + 0.2) * roiScale;
      const yMax = torsoLocal.y + (2.2 * confScale + 0.4) * roiScale;
      if (d > R || cur.y < yMin || cur.y > yMax) {
        filtered[i] = null;
        roiRejected += 1;
        continue;
      }
    }
    if (prevValid) {
      const dt = Math.max(
        1 / fps,
        typeof cur.timestampSec === "number" && typeof prevValid.timestampSec === "number"
          ? Math.max(0.0001, cur.timestampSec - prevValid.timestampSec)
          : 1 / fps
      );
      const dist = Math.hypot(cur.x - prevValid.x, cur.y - prevValid.y);
      const confScaleSpeed = cur.conf < 1 ? 0.85 : 1;
      const speed = dist / dt;
      const maxSpeed = 10.0 * confScaleSpeed;
      if (speed > maxSpeed) {
        filtered[i] = null;
        speedRejected += 1;
        continue;
      }
      if (prevPrevValid) {
        const dtPrev = Math.max(
          1 / fps,
          typeof prevValid.timestampSec === "number" && typeof prevPrevValid.timestampSec === "number"
            ? Math.max(0.0001, prevValid.timestampSec - prevPrevValid.timestampSec)
            : 1 / fps
        );
        const v1 = Math.hypot(prevValid.x - prevPrevValid.x, prevValid.y - prevPrevValid.y) / dtPrev;
        const v2 = speed;
        const baseAccel = 40.0 * confScaleSpeed;
        if (Math.abs(v2 - v1) > baseAccel) {
          filtered[i] = null;
          accelRejected += 1;
          continue;
        }
      }
    }
    prevPrevValid = prevValid;
    prevValid = { x: cur.x, y: cur.y, frameIndex: cur.frameIndex, timestampSec: cur.timestampSec };
  }
  const validIdx = filtered.map((p, idx) => (p ? idx : -1)).filter((idx) => idx >= 0);
  if (validIdx.length < 2) {
    return {
      raw,
      filtered,
      smoothed: [],
      downswing: [],
      debug: {
        fps,
        rawCount: raw.filter(Boolean).length,
        filteredCount: filtered.filter(Boolean).length,
        interpolatedCount: 0,
        roiRejected,
        speedRejected,
        accelRejected,
        shoulderWidthMedian: shoulderWidthMedian ?? null,
      },
    };
  }
  const smoothed: Array<{ x: number; y: number; phase: "backswing" | "top" | "downswing" | "impact"; frameIndex: number; timestampSec?: number }> = new Array(params.frameCount);
  const validSeq = validIdx.map((idx) => ({ idx, point: filtered[idx]! }));
  validSeq.forEach((item, seqIdx) => {
    const neighbors: Array<{ x: number; y: number; weight: number }> = [];
    for (let offset = -1; offset <= 1; offset += 1) {
      const entry = validSeq[seqIdx + offset];
      if (!entry) continue;
      neighbors.push({ x: entry.point.x, y: entry.point.y, weight: entry.point.conf });
    }
    const weightSum = neighbors.reduce((acc, n) => acc + n.weight, 0) || 1;
    const avg = neighbors.reduce(
      (acc, n) => ({ x: acc.x + n.x * n.weight, y: acc.y + n.y * n.weight }),
      { x: 0, y: 0 }
    );
    smoothed[item.idx] = {
      x: avg.x / weightSum,
      y: avg.y / weightSum,
      phase: item.point.phase,
      frameIndex: item.point.frameIndex,
      timestampSec: item.point.timestampSec,
    };
  });
  let interpolatedCount = 0;
  const getPoint = (idx: number) => smoothed[idx];
  const catmullRom = (p0: { x: number; y: number }, p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }, t: number) => {
    const t2 = t * t;
    const t3 = t2 * t;
    return {
      x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    };
  };
  for (let i = 0; i < validIdx.length - 1; i += 1) {
    const i1 = validIdx[i]!;
    const i2 = validIdx[i + 1]!;
    if (i2 - i1 <= 1) continue;
    const p1 = getPoint(i1)!;
    const p2 = getPoint(i2)!;
    const p0 = getPoint(validIdx[i - 1] ?? i1) ?? p1;
    const p3 = getPoint(validIdx[i + 2] ?? i2) ?? p2;
    for (let j = i1 + 1; j < i2; j += 1) {
      const t = (j - i1) / (i2 - i1);
      const interp = catmullRom(p0, p1, p2, p3, t);
      const meta = params.metaByIdxPose.get(j);
      if (!meta) continue;
      smoothed[j] = { x: clamp(interp.x, 0, 1), y: clamp(interp.y, 0, 1), phase: meta.phase, frameIndex: meta.frameIndex, timestampSec: meta.timestampSec };
      interpolatedCount += 1;
    }
  }
  const firstIdx = validIdx[0]!;
  const lastIdx = validIdx[validIdx.length - 1]!;
  const firstPoint = smoothed[firstIdx]!;
  const lastPoint = smoothed[lastIdx]!;
  for (let i = 0; i < params.frameCount; i += 1) {
    if (smoothed[i]) continue;
    const meta = params.metaByIdxPose.get(i);
    if (!meta) continue;
    if (i < firstIdx) {
      smoothed[i] = { ...firstPoint, phase: meta.phase, frameIndex: meta.frameIndex, timestampSec: meta.timestampSec };
    } else if (i > lastIdx) {
      smoothed[i] = { ...lastPoint, phase: meta.phase, frameIndex: meta.frameIndex, timestampSec: meta.timestampSec };
    }
  }
  const compact = smoothed.filter(
    (p): p is { x: number; y: number; phase: "backswing" | "top" | "downswing" | "impact"; frameIndex: number; timestampSec?: number } => !!p
  );
  const globalized = compact.map((p) => {
    const localIdx = localIdxByFrameIndex.get(p.frameIndex);
    const t = localIdx != null ? transforms[localIdx] : null;
    if (!t) return { ...p };
    const g = toGlobal(p, t);
    return { ...p, x: clamp(g.x, 0, 1), y: clamp(g.y, 0, 1) };
  });
  const emaTrace = globalized.length >= 2 ? smoothTraceEma(globalized, 0.25) : globalized;
  let topTime: number | null = null;
  let impactTime: number | null = null;
  params.metaByIdxPose.forEach((meta) => {
    if (meta.phase === "top" && topTime == null) {
      topTime = typeof meta.timestampSec === "number" ? meta.timestampSec : meta.frameIndex / fps;
    }
    if (meta.phase === "impact" && impactTime == null) {
      impactTime = typeof meta.timestampSec === "number" ? meta.timestampSec : meta.frameIndex / fps;
    }
  });
  const windows: Array<{ start: number; end: number }> = [];
  if (topTime != null) windows.push({ start: topTime - 0.15, end: topTime + 0.15 });
  if (impactTime != null) windows.push({ start: impactTime - 0.15, end: impactTime + 0.15 });
  const densified = densifyTraceByWindows(emaTrace, windows, 3);
  const finalSmooth = densified.points;
  const downswing = finalSmooth.filter((p) => p.phase === "downswing" || p.phase === "impact");
  return {
    raw,
    filtered,
    smoothed: finalSmooth,
    downswing,
    debug: {
      fps,
      rawCount: raw.filter(Boolean).length,
      filteredCount: filtered.filter(Boolean).length,
      interpolatedCount: interpolatedCount + densified.inserted,
      roiRejected,
      speedRejected,
      accelRejected,
      shoulderWidthMedian: shoulderWidthMedian ?? null,
    },
  };
}

function filterTraceOutliers(
  points: Array<{ x: number; y: number; phase?: string; frameIndex?: number; timestampSec?: number }>
): {
  filtered: Array<{ x: number; y: number; phase?: string; frameIndex?: number; timestampSec?: number }>;
  removed: number;
  threshold: number;
} {
  if (points.length < 4) return { filtered: points, removed: 0, threshold: 0 };
  const dists: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    dists.push(Math.hypot(b.x - a.x, b.y - a.y));
  }
  const sorted = [...dists].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
  const threshold = Math.max(0.06, median * 3);
  const keep = new Array(points.length).fill(true);
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    const phase = String(cur.phase ?? "");
    if (phase === "downswing" || phase === "impact" || phase === "top") continue;
    const dPrev = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const dNext = Math.hypot(next.x - cur.x, next.y - cur.y);
    if (dPrev > threshold && dNext > threshold) keep[i] = false;
  }
  if (points.length > 2) {
    const first = Math.hypot(points[1]!.x - points[0]!.x, points[1]!.y - points[0]!.y);
    const firstPhase = String(points[0]!.phase ?? "");
    if (firstPhase !== "downswing" && firstPhase !== "impact" && firstPhase !== "top" && first > threshold * 1.5) {
      keep[0] = false;
    }
    const last = Math.hypot(
      points[points.length - 1]!.x - points[points.length - 2]!.x,
      points[points.length - 1]!.y - points[points.length - 2]!.y
    );
    const lastPhase = String(points[points.length - 1]!.phase ?? "");
    if (lastPhase !== "downswing" && lastPhase !== "impact" && lastPhase !== "top" && last > threshold * 1.5) {
      keep[points.length - 1] = false;
    }
  }
  const filtered = points.filter((_, idx) => keep[idx]);
  return {
    filtered: filtered.length >= 2 ? filtered : points,
    removed: points.length - filtered.length,
    threshold,
  };
}

function buildTraceFitLine(trace: Array<{ x: number; y: number; phase?: string }>): { line: PlaneLine01; unique: number; spread: number } | null {
  if (!trace.length) return null;
  const filtered = trace.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (filtered.length < 2) return null;
  const phaseDown = filtered.filter((p) => String(p.phase ?? "").includes("down") || String(p.phase ?? "").includes("impact"));
  const phaseTop = filtered.filter((p) => String(p.phase ?? "").includes("top"));
  const phaseImpact = filtered.filter((p) => String(p.phase ?? "").includes("impact"));
  const downCandidates = phaseDown.map((p) => ({ x: p.x, y: p.y }));
  const downUnique = countTraceUnique(downCandidates, 0.01);
  const downSpread = computeTraceSpread(downCandidates);
  const useDownOnly = downCandidates.length >= 3 && downUnique >= 3 && downSpread >= 0.04;
  const topPoint = medianOf(phaseTop.map((p) => ({ x: p.x, y: p.y })));
  const impactPoint = medianOf(phaseImpact.map((p) => ({ x: p.x, y: p.y })));
  if (!useDownOnly && topPoint && impactPoint) {
    const dir = { x: impactPoint.x - topPoint.x, y: impactPoint.y - topPoint.y };
    const line = buildLineThroughUnitBox({ anchor: topPoint, dir });
    if (line) {
      return { line, unique: 2, spread: Math.hypot(dir.x, dir.y) };
    }
  }
  const candidates = (useDownOnly ? downCandidates : [...phaseTop, ...phaseDown, ...filtered]).map((p) => ({ x: p.x, y: p.y }));
  if (candidates.length < 2) return null;
  const unique = countTraceUnique(candidates, 0.01);
  const spread = computeTraceSpread(candidates);
  if (unique < 2 || spread < 0.02) return null;
  const line = buildBestFitLine01(candidates);
  if (!line) return null;
  return { line, unique, spread };
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

function computeHandPositionAverage(pose?: Record<string, unknown> | null): { x: number; y: number } | null {
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

function computeLeadHandPosition(
  pose?: Record<string, unknown> | null,
  handedness?: "left" | "right" | null
): { x: number; y: number } | null {
  if (!handedness) return computeHandPositionAverage(pose);
  const lw = readPosePoint(pose, ["leftWrist", "left_wrist", "leftHand", "left_hand"]);
  const rw = readPosePoint(pose, ["rightWrist", "right_wrist", "rightHand", "right_hand"]);
  const primaryWrist = handedness === "left" ? rw : lw;
  const secondaryWrist = handedness === "left" ? lw : rw;
  if (primaryWrist) return primaryWrist;
  if (secondaryWrist) return secondaryWrist;

  // Fallbacks when wrists are occluded/blurred: elbows -> shoulders -> hips.
  const le = readPosePoint(pose, ["leftElbow", "left_elbow"]);
  const re = readPosePoint(pose, ["rightElbow", "right_elbow"]);
  const primaryElbow = handedness === "left" ? re : le;
  const secondaryElbow = handedness === "left" ? le : re;
  if (primaryElbow) return primaryElbow;
  if (secondaryElbow) return secondaryElbow;

  const ls = readPosePoint(pose, ["leftShoulder", "left_shoulder"]);
  const rs = readPosePoint(pose, ["rightShoulder", "right_shoulder"]);
  const primaryShoulder = handedness === "left" ? rs : ls;
  const secondaryShoulder = handedness === "left" ? ls : rs;
  if (primaryShoulder) return primaryShoulder;
  if (secondaryShoulder) return secondaryShoulder;

  const lh = readPosePoint(pose, ["leftHip", "left_hip"]);
  const rh = readPosePoint(pose, ["rightHip", "right_hip"]);
  const primaryHip = handedness === "left" ? rh : lh;
  const secondaryHip = handedness === "left" ? lh : rh;
  if (primaryHip) return primaryHip;
  if (secondaryHip) return secondaryHip;
  return null;
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

function medianOfPhase(
  trace: Array<{ x: number; y: number; phase?: string | null }>,
  phase: "backswing" | "top" | "downswing" | "impact"
): { x: number; y: number } | null {
  const pts = trace.filter((p) => String(p.phase ?? "").includes(phase)).map((p) => ({ x: p.x, y: p.y }));
  return medianOf(pts);
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
    const outsideSign = handed === "left" ? 1 : -1;
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

const PHASE_REEVAL_VERSION = "v2025-12-31-address-clubhead-zone-v68-address-frame-v6-hip-cap-hand-trace-v40";

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

async function analyzeSinglePhaseSafe(
  frames: PhaseFrame[],
  args: { phaseLabel: string; handedness?: string; clubType?: string; level?: string }
): Promise<ReturnType<typeof analyzeSinglePhase> | null> {
  try {
    return await analyzeSinglePhase(frames, args);
  } catch (err) {
    console.error("[reanalyze-phases] analyzeSinglePhase failed", args.phaseLabel, err);
    return null;
  }
}

async function extractGripCentersFromFrames(params: {
  frames: PhaseFrame[];
  strict?: boolean;
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
${params.strict ? "- IMPORTANT: If you output identical coordinates across many frames, the output is considered invalid. Use subtle movement if needed." : ""}

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

  // Prefer parsed when available (response_format can populate it).
  const structured = (result as unknown as { choices?: Array<{ message?: { parsed?: unknown; content?: unknown } }> })
    ?.choices?.[0]?.message?.parsed ?? result.choices?.[0]?.message?.content ?? null;
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
  allowLLM?: boolean,
): Promise<{ shoulder: { x: number; y: number } | null; hip: { x: number; y: number } | null } | null> {
  if (!frame?.base64Image || !frame?.mimeType) return null;
  try {
    const poseFrames = await extractPoseKeypointsFromImages({
      frames: [{ base64Image: frame.base64Image, mimeType: frame.mimeType }],
      allowLLM,
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

async function refineGripCentersWithHints(params: {
  frames: PhaseFrame[];
  hints: Array<{ idx: number; point: { x: number; y: number } }>;
  cropScale?: number;
}): Promise<Array<{ idx: number; grip: { x: number; y: number } | null }>> {
  const { frames, hints } = params;
  if (!frames.length || !hints.length) return [];
  const croppedFrames: PhaseFrame[] = [];
  const croppedMeta: Array<{ idx: number; roi: RoiBox }> = [];
  for (const hint of hints) {
    const frame = frames[hint.idx];
    if (!frame) continue;
    const cropScale = clamp(params.cropScale ?? 0.5, 0.3, 0.8);
    const cropped = await cropFrameAroundPoint(frame, hint.point, cropScale);
    if (!cropped) continue;
    croppedFrames.push(cropped.frame);
    croppedMeta.push({ idx: hint.idx, roi: cropped.roi });
  }
  if (!croppedFrames.length) return [];
  const roiResults = await extractGripCentersFromFrames({ frames: croppedFrames, strict: true });
  const refined: Array<{ idx: number; grip: { x: number; y: number } | null }> = [];
  roiResults.forEach((res, i) => {
    const meta = croppedMeta[i];
    if (!meta || !res?.grip) return;
    refined.push({
      idx: meta.idx,
      grip: {
        x: clamp(meta.roi.x + meta.roi.w * res.grip.x, 0, 1),
        y: clamp(meta.roi.y + meta.roi.h * res.grip.y, 0, 1),
      },
    });
  });
  return refined;
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
  allowLLM = true,
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
  if (!allowLLM) return null;
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
    const poseSide = await extractAddressPoseLandmarks(frame, effectiveHandedness, allowLLM);
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
    | {
        analysisId?: string;
        address?: unknown;
        backswing?: unknown;
        top?: unknown;
        downswing?: unknown;
        impact?: unknown;
        finish?: unknown;
        onPlaneOnly?: unknown;
      }
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
  const onPlaneOnly = body?.onPlaneOnly === true;
  const allowLLM = !onPlaneOnly;

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
  const storedPhaseOverrides = stored.meta?.phaseOverrideFrames ?? null;
  const resolvePhaseIndices = (current: number[], fallback?: number[] | null) => (current.length ? current : normalizeIndices(fallback));

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
  if (
    !onPlaneOnly &&
    stored?.result &&
    stored?.meta?.phaseOverrideSig === requestedOverrideSig &&
    stored?.meta?.phaseReevalVersion === PHASE_REEVAL_VERSION
  ) {
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

  const estimateFpsFromSequenceFrames = (sequenceFrames: Array<{ timestampSec?: number }>) => {
    const times: number[] = [];
    sequenceFrames.forEach((frame) => {
      if (typeof frame.timestampSec === "number" && Number.isFinite(frame.timestampSec)) {
        times.push(frame.timestampSec);
      }
    });
    if (times.length < 2) return 30;
    times.sort((a, b) => a - b);
    const diffs: number[] = [];
    for (let i = 1; i < times.length; i += 1) {
      const dt = times[i]! - times[i - 1]!;
      if (dt > 0.001 && dt < 0.5) diffs.push(dt);
    }
    if (!diffs.length) return 30;
    diffs.sort((a, b) => a - b);
    const mid = diffs[Math.floor(diffs.length / 2)]!;
    return mid > 0 ? clamp(1 / mid, 5, 120) : 30;
  };

  const resolveSourceVideoUrl = () => {
    const candidates = [
      (body as Record<string, unknown> | null)?.sourceVideoUrl,
      (body as Record<string, unknown> | null)?.videoUrl,
      (stored.meta as Record<string, unknown> | null)?.sourceVideoUrl,
      (stored.meta as Record<string, unknown> | null)?.videoUrl,
      (stored.result as Record<string, unknown> | null)?.sourceVideoUrl,
      (stored.result as Record<string, unknown> | null)?.videoUrl,
      (stored.result as Record<string, unknown> | null)?.sequence &&
        (stored.result as Record<string, unknown>).sequence &&
        typeof (stored.result as Record<string, unknown>).sequence === "object"
        ? (stored.result as Record<string, unknown>).sequence
        : null,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
      if (candidate && typeof candidate === "object") {
        const maybe = (candidate as Record<string, unknown>).sourceVideoUrl ?? (candidate as Record<string, unknown>).videoUrl;
        if (typeof maybe === "string" && maybe.trim().length > 0) return maybe.trim();
      }
    }
    return null;
  };

  const phaseUpdates: Partial<
    Record<"address" | "backswing" | "top" | "downswing" | "impact" | "finish", { score: number; good: string[]; issues: string[]; advice: string[] }>
  > = {};
  let onPlaneUpdate: Record<string, unknown> | null = null;

  try {
    if (!onPlaneOnly) {
      if (effectiveAddressIndices.length) {
        const picked = pickFrames(effectiveAddressIndices);
        if (!picked.length) return json({ error: "invalid address frames" }, { status: 400 });
        const res = await analyzeSinglePhaseSafe(picked, {
          phaseLabel: "アドレス",
          handedness: meta?.handedness,
          clubType: meta?.clubType,
          level: meta?.level,
        });
        if (res) phaseUpdates.address = res;
      }
      if (backswingIndices.length) {
        const picked = pickFrames(backswingIndices);
        if (!picked.length) return json({ error: "invalid backswing frames" }, { status: 400 });
        const res = await analyzeSinglePhaseSafe(picked, {
          phaseLabel: "バックスイング",
          handedness: meta?.handedness,
          clubType: meta?.clubType,
          level: meta?.level,
        });
        if (res) phaseUpdates.backswing = res;
      }
      if (topIndices.length) {
        const picked = pickFrames(topIndices);
        if (!picked.length) return json({ error: "invalid top frames" }, { status: 400 });
        const res = await analyzeSinglePhaseSafe(picked, {
          phaseLabel: "トップ",
          handedness: meta?.handedness,
          clubType: meta?.clubType,
          level: meta?.level,
        });
        if (res) phaseUpdates.top = res;
      }
      if (downswingIndices.length) {
        const picked = pickFrames(downswingIndices);
        if (!picked.length) return json({ error: "invalid downswing frames" }, { status: 400 });
        const downswingResult = await analyzeSinglePhaseSafe(picked, {
          phaseLabel: "ダウンスイング",
          handedness: meta?.handedness,
          clubType: meta?.clubType,
          level: meta?.level,
        });
        if (!downswingResult) {
          // Skip downswing updates if the vision call failed.
        } else {
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
      }
      if (impactIndices.length) {
        const picked = pickFrames(impactIndices);
        if (!picked.length) return json({ error: "invalid impact frames" }, { status: 400 });
        const res = await analyzeSinglePhaseSafe(picked, {
          phaseLabel: "インパクト",
          handedness: meta?.handedness,
          clubType: meta?.clubType,
          level: meta?.level,
        });
        if (res) phaseUpdates.impact = res;
      }
      if (finishIndices.length) {
        const picked = pickFrames(finishIndices);
        if (!picked.length) return json({ error: "invalid finish frames" }, { status: 400 });
        const res = await analyzeSinglePhaseSafe(picked, {
          phaseLabel: "フィニッシュ",
          handedness: meta?.handedness,
          clubType: meta?.clubType,
          level: meta?.level,
        });
        if (res) phaseUpdates.finish = res;
      }
    }

            // On-plane: use the same user-selected phase frames (Top/Downswing/Impact) as evidence.
    // This allows older analyses (without on_plane in the original result JSON) to be backfilled on reevaluation.
		    const onPlaneAddressIndices = resolvePhaseIndices(effectiveAddressIndices, storedPhaseOverrides?.address);
		    const onPlaneBackswingIndices = resolvePhaseIndices(backswingIndices, storedPhaseOverrides?.backswing);
		    const onPlaneTopIndices = resolvePhaseIndices(topIndices, storedPhaseOverrides?.top);
		    const onPlaneDownswingIndices = resolvePhaseIndices(downswingIndices, storedPhaseOverrides?.downswing);
		    const onPlaneImpactIndices = resolvePhaseIndices(impactIndices, storedPhaseOverrides?.impact);
		    const onPlaneFinishIndices = resolvePhaseIndices(finishIndices, storedPhaseOverrides?.finish);
		    const clampIndex = (n: number | null, maxFrameIndex = frames.length) =>
		      n && Number.isFinite(n) ? Math.max(1, Math.min(maxFrameIndex, n)) : null;
		    const rangeIndices = (start: number | null, end: number | null, maxFrameIndex = frames.length) => {
		      if (!start || !end) return [];
		      const s = clampIndex(start, maxFrameIndex);
		      const e = clampIndex(end, maxFrameIndex);
		      if (!s || !e) return [];
		      const [from, to] = s <= e ? [s, e] : [e, s];
		      const out: number[] = [];
		      for (let i = from; i <= to; i += 1) out.push(i);
		      return out;
		    };
		    const pickEvenly = <T,>(items: T[], maxCount: number): T[] => {
		      if (items.length <= maxCount) return items;
		      const out: T[] = [];
		      const step = (items.length - 1) / Math.max(1, maxCount - 1);
		      for (let i = 0; i < maxCount; i += 1) {
		        out.push(items[Math.round(i * step)]!);
		      }
		      return out;
		    };
		    const pickFramesWithIndexFromList = (
		      indices: number[],
		      entries: Array<PhaseFrame & { frameIndex: number }>
		    ): Array<PhaseFrame & { frameIndex: number }> => {
		      const out: Array<PhaseFrame & { frameIndex: number }> = [];
		      for (const idx1 of indices) {
		        const entry = entries[idx1 - 1];
		        if (!entry) continue;
		        out.push({ ...entry, frameIndex: idx1 });
		      }
		      return out;
		    };
		    if (onPlaneTopIndices.length && onPlaneDownswingIndices.length) {
		      const videoWindowFps = 15;
		      const videoWindowPreSec = 0.4;
		      const videoWindowPostSec = 0.2;
		      const videoWindowMaxFrames = 20;
		      const videoWindowTimeoutMs = 10000;
		      const useVideoWindow = onPlaneOnly;
		      const sourceVideoUrl = useVideoWindow ? resolveSourceVideoUrl() : null;
		      if (useVideoWindow && !sourceVideoUrl) {
		        return json({ error: "source video not available for on-plane analysis" }, { status: 400 });
		      }
		      const sequenceFps = estimateFpsFromSequenceFrames(frames);
		      const frameTimestamp = (idx: number) => {
		        const entry = frames[idx - 1];
		        if (entry && typeof entry.timestampSec === "number" && Number.isFinite(entry.timestampSec)) {
		          return entry.timestampSec;
		        }
		        return (idx - 1) / sequenceFps;
		      };

		      const addressIdxRaw = clampIndex(onPlaneAddressIndices[0] ?? null);
		      const topIdxRaw = clampIndex(onPlaneTopIndices[0] ?? null);
		      const impactIdxRaw =
		        clampIndex(onPlaneImpactIndices[0] ?? null) ??
		        clampIndex(onPlaneDownswingIndices[onPlaneDownswingIndices.length - 1] ?? null);
		      const finishIdxRaw =
		        clampIndex(onPlaneFinishIndices[0] ?? null) ??
		        clampIndex(onPlaneImpactIndices[onPlaneImpactIndices.length - 1] ?? null) ??
		        clampIndex(onPlaneDownswingIndices[onPlaneDownswingIndices.length - 1] ?? null);
		      const addressTime = addressIdxRaw ? frameTimestamp(addressIdxRaw) : null;
		      const topTime = topIdxRaw ? frameTimestamp(topIdxRaw) : null;
		      const impactTime = impactIdxRaw ? frameTimestamp(impactIdxRaw) : null;

		      let onPlaneFramesWithIndex: Array<PhaseFrame & { frameIndex: number }> | null = null;
		      let onPlaneMaxIndex = frames.length;
		      let onPlaneAddressIndicesLocal = onPlaneAddressIndices;
		      let onPlaneBackswingIndicesLocal = onPlaneBackswingIndices;
		      let onPlaneTopIndicesLocal = onPlaneTopIndices;
		      let onPlaneDownswingIndicesLocal = onPlaneDownswingIndices;
		      let onPlaneImpactIndicesLocal = onPlaneImpactIndices;
		      let onPlaneFinishIndicesLocal = onPlaneFinishIndices;
		      let videoWindowDebug: Record<string, unknown> | null = null;

		      if (useVideoWindow && sourceVideoUrl) {
		        if (!topTime || !impactTime) {
		          return json({ error: "top/impact timestamps missing for video on-plane analysis" }, { status: 400 });
		        }
		        const startSec = Math.max(0, topTime - videoWindowPreSec);
		        const endSec = Math.max(startSec + 0.1, impactTime + videoWindowPostSec);
		        const extracted = await extractVideoWindowFrames({
		          url: sourceVideoUrl,
		          startSec,
		          endSec,
		          fps: videoWindowFps,
		          maxFrames: videoWindowMaxFrames,
		          timeoutMs: videoWindowTimeoutMs,
		        });
		        onPlaneFramesWithIndex = extracted.frames.map((frame, idx) => ({
		          ...frame,
		          frameIndex: idx + 1,
		        }));
		        onPlaneMaxIndex = onPlaneFramesWithIndex.length;
		        if (!onPlaneMaxIndex) {
		          return json({ error: "no frames extracted from video window" }, { status: 500 });
		        }
		        videoWindowDebug = {
		          source: "video",
		          startSec: extracted.startSec,
		          endSec: extracted.endSec,
		          fps: extracted.fps,
		          frameCount: onPlaneMaxIndex,
		        };

		        const closestIndexByTime = (targetSec: number) => {
		          let bestIdx = 1;
		          let bestDiff = Number.POSITIVE_INFINITY;
		          onPlaneFramesWithIndex.forEach((frame, idx) => {
		            const ts = frame.timestampSec ?? extracted.startSec + idx / extracted.fps;
		            const diff = Math.abs(ts - targetSec);
		            if (diff < bestDiff) {
		              bestDiff = diff;
		              bestIdx = idx + 1;
		            }
		          });
		          return clampIndex(bestIdx, onPlaneMaxIndex) ?? 1;
		        };

		        const videoTopIdx = closestIndexByTime(topTime);
		        const videoImpactIdx = impactTime ? closestIndexByTime(impactTime) : onPlaneMaxIndex;
		        const videoAddressIdx = addressTime != null ? closestIndexByTime(addressTime) : 1;
		        const videoFinishIdx = videoImpactIdx;

		        onPlaneAddressIndicesLocal = videoAddressIdx ? [videoAddressIdx] : [];
		        onPlaneBackswingIndicesLocal = rangeIndices(videoAddressIdx, videoTopIdx, onPlaneMaxIndex);
		        onPlaneTopIndicesLocal = videoTopIdx ? [videoTopIdx] : [];
		        const downswingStart = clampIndex(videoTopIdx + 1, onPlaneMaxIndex) ?? videoTopIdx;
		        onPlaneDownswingIndicesLocal = rangeIndices(downswingStart, videoImpactIdx, onPlaneMaxIndex);
		        onPlaneImpactIndicesLocal = videoImpactIdx ? [videoImpactIdx] : [];
		        onPlaneFinishIndicesLocal = videoFinishIdx ? [videoFinishIdx] : [];
		      }
		      if (!onPlaneImpactIndicesLocal.length && impactIdxRaw) {
		        onPlaneImpactIndicesLocal = [impactIdxRaw];
		      }

		      const pickFramesForOnPlane = useVideoWindow && onPlaneFramesWithIndex
		        ? (indices: number[]) => pickFramesWithIndexFromList(indices, onPlaneFramesWithIndex!)
		        : pickFramesWithIndex;
		      const maxFrameIndex = useVideoWindow && onPlaneFramesWithIndex ? onPlaneMaxIndex : frames.length;
		      const addressFrames = onPlaneAddressIndicesLocal.length ? pickFramesForOnPlane(onPlaneAddressIndicesLocal.slice(0, 1)) : [];
		      const backswingFrames = onPlaneBackswingIndicesLocal.length ? pickFramesForOnPlane(onPlaneBackswingIndicesLocal.slice(0, 2)) : [];
		      const topFrames = pickFramesForOnPlane(onPlaneTopIndicesLocal.slice(0, 6));
		      const dsFrames = pickFramesForOnPlane(onPlaneDownswingIndicesLocal.slice(0, 8));
		      const impFrames = pickFramesForOnPlane(onPlaneImpactIndicesLocal.slice(0, 6));
		      const addressIdx =
		        clampIndex(onPlaneAddressIndicesLocal[0] ?? null, maxFrameIndex) ??
		        clampIndex(onPlaneTopIndicesLocal[0] ?? null, maxFrameIndex);
		      const topIdx = clampIndex(onPlaneTopIndicesLocal[0] ?? null, maxFrameIndex);
		      const finishIdx =
		        clampIndex(onPlaneFinishIndicesLocal[0] ?? null, maxFrameIndex) ??
		        clampIndex(onPlaneImpactIndicesLocal[onPlaneImpactIndicesLocal.length - 1] ?? null, maxFrameIndex) ??
		        clampIndex(onPlaneDownswingIndicesLocal[onPlaneDownswingIndicesLocal.length - 1] ?? null, maxFrameIndex);
		      const preTop = rangeIndices(addressIdx, topIdx, maxFrameIndex);
		      const postTop = rangeIndices(topIdx, finishIdx, maxFrameIndex);
		      const gripRangeIndices = Array.from(new Set([...preTop, ...postTop])).sort((a, b) => a - b);
		      const gripFramesRange = gripRangeIndices.length ? pickFramesForOnPlane(gripRangeIndices) : [];
		      const framesForOnPlane = [...topFrames, ...dsFrames, ...impFrames].slice(0, 7);
		      if (framesForOnPlane.length >= 3) {
		        const prompt = buildOnPlanePrompt({ handedness: meta?.handedness, clubType: meta?.clubType, level: meta?.level });
		        let parsed: ReturnType<typeof parseOnPlane> | null = null;
		        if (allowLLM) {
		          try {
		            const raw = await askVisionAPI({ frames: framesForOnPlane, prompt });
		            parsed = parseOnPlane(raw);
		          } catch (err) {
		            console.error("[reanalyze-phases] on_plane vision failed", err);
		            parsed = null;
		          }
		        }
	        const existingOnPlane = (stored.result as unknown as Record<string, unknown>)?.on_plane;
	        const parsedOnPlane =
	          parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
		        const baseOnPlane =
		          parsedOnPlane ??
		          (existingOnPlane && typeof existingOnPlane === "object"
		            ? ({ ...(existingOnPlane as Record<string, unknown>) } as Record<string, unknown>)
		            : null);
		        if (baseOnPlane) onPlaneUpdate = baseOnPlane;

		        if (!onPlaneUpdate) {
		          onPlaneUpdate =
		            existingOnPlane && typeof existingOnPlane === "object"
		              ? ({ ...(existingOnPlane as Record<string, unknown>) } as Record<string, unknown>)
		              : {};
		        }
		        if (!allowLLM) {
		          (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		            ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		            on_plane_llm_skipped: true,
		          };
		        }
		        if (useVideoWindow && videoWindowDebug) {
		          (onPlaneUpdate as Record<string, unknown>).source = "video";
		          (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		            ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		            video_window: videoWindowDebug,
		          };
		        }
		        if (useVideoWindow && onPlaneFramesWithIndex?.length) {
		          const toSequenceUrl = (idx1: number | null, label: string) => {
		            if (!idx1 || !Number.isFinite(idx1)) return null;
		            const entry = frames[idx1 - 1];
		            if (!entry || typeof entry.url !== "string") return null;
		            if (!entry.url.startsWith("data:image/")) return null;
		            return { label, url: entry.url };
		          };
		          const toDataUrl = (idx1: number | null, label: string) => {
		            if (!idx1 || !Number.isFinite(idx1)) return null;
		            const frame = onPlaneFramesWithIndex![idx1 - 1];
		            if (!frame?.base64Image) return null;
		            const mimeType = frame.mimeType || "image/jpeg";
		            return { label, url: `data:${mimeType};base64,${frame.base64Image}` };
		          };
		          const debugFrames: Array<{ label: string; url: string }> = [];
		          const dsIndices = onPlaneDownswingIndicesLocal.length ? onPlaneDownswingIndicesLocal : [];
		          const impactFallback = onPlaneImpactIndicesLocal[0] ?? dsIndices[dsIndices.length - 1] ?? null;
		          const addressFrame =
		            toSequenceUrl(addressIdxRaw ?? null, "Address") ??
		            toDataUrl(onPlaneAddressIndicesLocal[0] ?? null, "Address");
		          const backswingFrame =
		            toSequenceUrl(onPlaneBackswingIndices[0] ?? null, "Backswing") ??
		            toDataUrl(onPlaneBackswingIndicesLocal[0] ?? null, "Backswing");
		          const topFrame = toDataUrl(onPlaneTopIndicesLocal[0] ?? null, "Top");
		          const downswing1Frame = toDataUrl(dsIndices[0] ?? null, "Downswing 1");
		          const downswing2Frame = toDataUrl(dsIndices[1] ?? null, "Downswing 2");
		          const impactFrame = toDataUrl(impactFallback, "Impact");
		          if (addressFrame) debugFrames.push(addressFrame);
		          if (backswingFrame) debugFrames.push(backswingFrame);
		          if (topFrame) debugFrames.push(topFrame);
		          if (downswing1Frame) debugFrames.push(downswing1Frame);
		          if (downswing2Frame) debugFrames.push(downswing2Frame);
		          if (impactFrame) debugFrames.push(impactFrame);
		          if (debugFrames.length) {
		            (onPlaneUpdate as Record<string, unknown>).debug_frames = debugFrames;
		          }
		        }

		        const poseInputs = [...backswingFrames, ...topFrames, ...dsFrames, ...impFrames].slice(0, 16);
		        const gripFramesForTrace = gripFramesRange.length ? gripFramesRange : poseInputs;
		        const poseFramesForTrace = gripFramesRange.length
		          ? pickEvenly(gripFramesRange, 24)
		          : poseInputs.length
		            ? poseInputs
		            : gripFramesForTrace;
		        const bsCount = Math.min(backswingFrames.length, 2);
		        const topCount = Math.min(topFrames.length, 6);
		        const dsCount = Math.min(dsFrames.length, 8);
		        const metaByIdxGrip = new Map<number, { frameIndex: number; timestampSec: number | undefined; phase: "backswing" | "top" | "downswing" | "impact" }>();
		        const metaByIdxPose = new Map<number, { frameIndex: number; timestampSec: number | undefined; phase: "backswing" | "top" | "downswing" | "impact" }>();
		        const backswingIdx =
		          clampIndex(onPlaneBackswingIndicesLocal[onPlaneBackswingIndicesLocal.length - 1] ?? null, maxFrameIndex) ?? topIdx;
		        const downswingIdx =
		          clampIndex(onPlaneDownswingIndicesLocal[0] ?? null, maxFrameIndex) ?? topIdx;
		        const impactIdx =
		          clampIndex(onPlaneImpactIndicesLocal[0] ?? null, maxFrameIndex) ?? finishIdx;
		        const gripIdxByFrameIndex = new Map<number, number>();
		        gripFramesForTrace.forEach((src, idx) => {
		          const frameNo = src.frameIndex;
		          const mapped: "backswing" | "top" | "downswing" | "impact" =
		            backswingIdx && frameNo <= backswingIdx
		              ? "backswing"
		              : topIdx && frameNo <= topIdx
		                ? "top"
		                : impactIdx && frameNo <= impactIdx
		                  ? "downswing"
		                  : "impact";
		          metaByIdxGrip.set(idx, { frameIndex: src.frameIndex, timestampSec: src.timestampSec, phase: mapped });
		          gripIdxByFrameIndex.set(src.frameIndex, idx);
		        });
		        poseFramesForTrace.forEach((src, idx) => {
		          const frameNo = src.frameIndex;
		          const mapped: "backswing" | "top" | "downswing" | "impact" =
		            backswingIdx && frameNo <= backswingIdx
		              ? "backswing"
		              : topIdx && frameNo <= topIdx
		                ? "top"
		                : impactIdx && frameNo <= impactIdx
		                  ? "downswing"
		                  : "impact";
		          metaByIdxPose.set(idx, { frameIndex: src.frameIndex, timestampSec: src.timestampSec, phase: mapped });
		        });

		        let gripTraceInfo: { trace: Array<{ x: number; y: number; frameIndex: number; timestampSec?: number; phase: "backswing" | "top" | "downswing" | "impact" }>; spread: number } | null = null;
		        const addrGripAnchor = (() => {
		          const fromUpdate =
		            (onPlaneUpdate as Record<string, unknown>)?.grip_point &&
		            typeof (onPlaneUpdate as Record<string, unknown>).grip_point === "object"
		              ? normalizePoint01((onPlaneUpdate as Record<string, unknown>).grip_point)
		              : null;
		          if (fromUpdate) return fromUpdate;
		          const fromExisting =
		            existingOnPlane && typeof existingOnPlane === "object" && "grip_point" in (existingOnPlane as Record<string, unknown>)
		              ? normalizePoint01((existingOnPlane as Record<string, unknown>).grip_point)
		              : null;
		          return fromExisting;
		        })();
		        let poseTraceInfo: {
		          trace: Array<{ x: number; y: number; frameIndex: number; timestampSec?: number; phase: "backswing" | "top" | "downswing" | "impact" }>;
		          unique: number;
		          spread: number;
		          source: "lead" | "avg" | "reconstruct";
		        } | null = null;
		        // Always try grip-based trace first so we can show hand path even when pose extraction is unavailable.
		        if (allowLLM) {
		          try {
		          const gripFrames = gripFramesForTrace.map((f) => ({ base64Image: f.base64Image, mimeType: f.mimeType, timestampSec: f.timestampSec }));
		          const grips = await extractGripCentersFromFrames({ frames: gripFrames });
		          const refined = await refineGripCentersWithRoi({ frames: gripFrames, initial: grips, anchor: addrGripAnchor });
		          let gripsFinal = refined.refined;
		          const gripTrace: Array<{ x: number; y: number; frameIndex: number; timestampSec?: number; phase: "backswing" | "top" | "downswing" | "impact" }> = [];
		          gripsFinal.forEach((g) => {
		            const meta = metaByIdxGrip.get(g.idx) ?? null;
		            if (!meta || !g.grip) return;
		            gripTrace.push({ x: g.grip.x, y: g.grip.y, frameIndex: meta.frameIndex, timestampSec: meta.timestampSec, phase: meta.phase });
		          });
		          gripTrace.sort((a, b) => (a.timestampSec ?? a.frameIndex) - (b.timestampSec ?? b.frameIndex));
		          let gripSpread = computeTraceSpread(gripTrace);
		          let gripUnique = countTraceUnique(gripTrace, 0.01);
		          if (gripTrace.length >= 3 && (gripUnique <= 2 || gripSpread < 0.03)) {
		            const strict = await extractGripCentersFromFrames({ frames: gripFrames, strict: true });
		            const strictTrace: Array<{ x: number; y: number; frameIndex: number; timestampSec?: number; phase: "backswing" | "top" | "downswing" | "impact" }> = [];
		            strict.forEach((g) => {
		              const meta = metaByIdxGrip.get(g.idx) ?? null;
		              if (!meta || !g.grip) return;
		              strictTrace.push({ x: g.grip.x, y: g.grip.y, frameIndex: meta.frameIndex, timestampSec: meta.timestampSec, phase: meta.phase });
		            });
		            strictTrace.sort((a, b) => (a.timestampSec ?? a.frameIndex) - (b.timestampSec ?? b.frameIndex));
		            const strictSpread = computeTraceSpread(strictTrace);
		            const strictUnique = countTraceUnique(strictTrace, 0.01);
		            if (strictUnique > gripUnique || (strictUnique === gripUnique && strictSpread > gripSpread)) {
		              gripsFinal = strict;
		              gripTrace.length = 0;
		              strictTrace.forEach((p) => gripTrace.push(p));
		              gripSpread = strictSpread;
		              gripUnique = strictUnique;
		              (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		                grip_direct_retry_used: true,
		                grip_direct_retry_unique: strictUnique,
		                grip_direct_retry_spread: strictSpread,
		              };
		            }
		          }
		          if (gripTrace.length >= 3 && (gripUnique <= 2 || gripSpread < 0.03)) {
		            const forceIndices = gripFrames.map((_, idx) => idx);
		            const forced = await refineGripCentersWithRoi({
		              frames: gripFrames,
		              initial: gripsFinal,
		              anchor: addrGripAnchor ?? medianOf(gripTrace.map((p) => ({ x: p.x, y: p.y }))),
		              forceIndices,
		            });
		            gripsFinal = forced.refined;
		            gripTrace.length = 0;
		            gripsFinal.forEach((g) => {
		              const meta = metaByIdxGrip.get(g.idx) ?? null;
		              if (!meta || !g.grip) return;
		              gripTrace.push({ x: g.grip.x, y: g.grip.y, frameIndex: meta.frameIndex, timestampSec: meta.timestampSec, phase: meta.phase });
		            });
		            gripTrace.sort((a, b) => (a.timestampSec ?? a.frameIndex) - (b.timestampSec ?? b.frameIndex));
		            gripSpread = computeTraceSpread(gripTrace);
		            gripUnique = countTraceUnique(gripTrace, 0.01);
		            (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		              ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		              grip_direct_force_refined: true,
		              grip_direct_force_points: gripTrace.length,
		            };
		          }
		          gripTraceInfo = { trace: gripTrace, spread: gripSpread };
		          if (gripTrace.length >= 2) {
		            onPlaneUpdate.hand_trace = gripTrace;
		          }
		          if (gripTrace.length >= 1) {
		            const byPhase = (ph: "backswing" | "top" | "downswing" | "impact") =>
		              medianOf(gripTrace.filter((p) => p.phase === ph).map((p) => ({ x: p.x, y: p.y })));
		            onPlaneUpdate.hand_points = {
		              backswing: byPhase("backswing"),
		              top: byPhase("top"),
		              downswing: byPhase("downswing"),
		              impact: byPhase("impact"),
		            };
		          }
		          const downswingPts = gripTrace
		            .filter((p) => p.phase === "downswing" || p.phase === "impact")
		            .map((p) => ({ x: p.x, y: p.y }));
		          if (downswingPts.length >= 2) {
		            const fit = buildBestFitLine01(downswingPts);
		            if (fit) {
		              onPlaneUpdate.downswing_plane = fit;
		              onPlaneUpdate.plane_source = "hand_trace_fit";
		              onPlaneUpdate.plane_confidence = "low";
		            }
		          }
		          (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		            ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		            grip_direct_used: true,
		            grip_direct_points: gripTrace.length,
		            grip_direct_roi_refined: refined.refinedCount,
		            grip_direct_roi_frames: refined.refinedFrames,
		            grip_direct_unique: gripUnique,
		            grip_direct_spread: gripSpread,
		            grip_direct_sample: gripTrace.slice(0, 6).map((p) => ({ x: p.x, y: p.y, phase: p.phase })),
		            grip_direct_anchor_used: !!addrGripAnchor,
		          };
		          } catch (e) {
		            (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		              ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		              grip_direct_error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
		            };
		          }
		        } else {
		          (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		            ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		            grip_direct_skipped: true,
		          };
		        }

		        // Prefer deterministic plane lines from pose+shaftVector when available (2D estimate).
		        try {
		          // Pose-based hand tracing: keep the original (Top/Downswing/Impact) set for stability.
		          // Address is handled separately to anchor the zone at the clubhead.
		          if (poseFramesForTrace.length >= 3) {
			            let poseError: string | null = null;
			            let poseFrames: Awaited<ReturnType<typeof extractPoseKeypointsFromImages>> = [];
			            try {
			              poseFrames = await extractPoseKeypointsFromImages({
			                frames: poseFramesForTrace.map((f) => ({
			                  base64Image: f.base64Image,
			                  mimeType: f.mimeType,
			                  timestampSec: f.timestampSec,
			                })),
			                allowLLM,
			              });
			            } catch (e) {
			              poseError = e instanceof Error ? e.message : String(e);
			              poseFrames = [];
			            }
			            if ((poseError || poseFrames.length === 0) && !onPlaneUpdate) {
			              onPlaneUpdate =
			                existingOnPlane && typeof existingOnPlane === "object"
			                  ? ({ ...(existingOnPlane as Record<string, unknown>) } as Record<string, unknown>)
			                  : {};
			            }
			            if (poseError || poseFrames.length === 0) {
			              (onPlaneUpdate as Record<string, unknown>).pose_debug = {
			                ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
			                pose_error: poseError ?? null,
			                pose_frames: poseFrames.length,
			                pose_inputs: poseFramesForTrace.length,
			              };
			            }
			            (onPlaneUpdate as Record<string, unknown>).pose_debug = {
			              ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
			              pose_frames: poseFrames.length,
			              pose_inputs: poseFramesForTrace.length,
			            };

		            const poseByIdx = new Map<number, Record<string, unknown>>();
		            const shaftByIdx = new Map<number, { x: number; y: number }>();
		            poseFrames.forEach((f) => {
		              if (!f || typeof f !== "object") return;
	              poseByIdx.set(f.idx, (f.pose as unknown as Record<string, unknown>) ?? {});
	              const rawVec = (f.club as unknown as { shaftVector?: unknown } | undefined)?.shaftVector ?? null;
	              const vec = toShaftVector(rawVec);
	              if (vec) shaftByIdx.set(f.idx, vec);
		            });

		            const handTraceLead: Array<{ x: number; y: number; frameIndex: number; timestampSec?: number; phase: "backswing" | "top" | "downswing" | "impact" }> = [];
		            const handTraceAvg: Array<{ x: number; y: number; frameIndex: number; timestampSec?: number; phase: "backswing" | "top" | "downswing" | "impact" }> = [];
		            const bsHandsLead: Array<{ x: number; y: number }> = [];
		            const topHandsLead: Array<{ x: number; y: number }> = [];
		            const dsHandsLead: Array<{ x: number; y: number }> = [];
		            const impHandsLead: Array<{ x: number; y: number }> = [];
		            const bsHandsAvg: Array<{ x: number; y: number }> = [];
		            const topHandsAvg: Array<{ x: number; y: number }> = [];
		            const dsHandsAvg: Array<{ x: number; y: number }> = [];
		            const impHandsAvg: Array<{ x: number; y: number }> = [];
		            const bsVecs: Array<{ x: number; y: number }> = [];
		            const topVecs: Array<{ x: number; y: number }> = [];
		            const dsVecs: Array<{ x: number; y: number }> = [];
		            const impVecs: Array<{ x: number; y: number }> = [];
		            for (let i = 0; i < poseFramesForTrace.length; i += 1) {
		              const pose = poseByIdx.get(i) ?? null;
		              const metaInfo = metaByIdxPose.get(i) ?? null;
		              if (!metaInfo) continue;
		              const handLead = computeLeadHandPosition(pose, meta?.handedness ?? null);
		              const handAvg = computeHandPositionAverage(pose);
		              const vec = shaftByIdx.get(i) ?? null;
		              if (handLead) {
		                handTraceLead.push({
		                  x: handLead.x,
		                  y: handLead.y,
		                  frameIndex: metaInfo.frameIndex,
		                  timestampSec: metaInfo.timestampSec,
		                  phase: metaInfo.phase,
		                });
		                if (metaInfo.phase === "backswing") bsHandsLead.push(handLead);
		                if (metaInfo.phase === "top") topHandsLead.push(handLead);
		                if (metaInfo.phase === "downswing") dsHandsLead.push(handLead);
		                if (metaInfo.phase === "impact") impHandsLead.push(handLead);
		              }
		              if (handAvg) {
		                handTraceAvg.push({
		                  x: handAvg.x,
		                  y: handAvg.y,
		                  frameIndex: metaInfo.frameIndex,
		                  timestampSec: metaInfo.timestampSec,
		                  phase: metaInfo.phase,
		                });
		                if (metaInfo.phase === "backswing") bsHandsAvg.push(handAvg);
		                if (metaInfo.phase === "top") topHandsAvg.push(handAvg);
		                if (metaInfo.phase === "downswing") dsHandsAvg.push(handAvg);
		                if (metaInfo.phase === "impact") impHandsAvg.push(handAvg);
		              }
		              if (vec) {
		                if (metaInfo.phase === "backswing") bsVecs.push(vec);
		                if (metaInfo.phase === "top") topVecs.push(vec);
		                if (metaInfo.phase === "downswing") dsVecs.push(vec);
		                if (metaInfo.phase === "impact") impVecs.push(vec);
		              }
		            }
		            handTraceLead.sort((a, b) => (a.timestampSec ?? a.frameIndex) - (b.timestampSec ?? b.frameIndex));
		            handTraceAvg.sort((a, b) => (a.timestampSec ?? a.frameIndex) - (b.timestampSec ?? b.frameIndex));
		            const leadUnique = countTraceUnique(handTraceLead, 0.01);
		            const avgUnique = countTraceUnique(handTraceAvg, 0.01);
		            const leadSpread = computeTraceSpread(handTraceLead);
		            const avgSpread = computeTraceSpread(handTraceAvg);
		            const useAvgTrace =
		              handTraceAvg.length >= 2 &&
		              (handTraceLead.length < 2 ||
		                avgUnique > leadUnique ||
		                (avgUnique === leadUnique && avgSpread > leadSpread));
		            let handTrace = useAvgTrace ? handTraceAvg : handTraceLead;
		            let poseTraceSource: "lead" | "avg" | "reconstruct" = useAvgTrace ? "avg" : "lead";
		            let poseTraceSourceReason = useAvgTrace ? "avg_spread_over_lead" : "lead_default";
		            let bsHand = medianOf(bsHandsLead);
		            let topHand = medianOf(topHandsLead);
		            let dsHand = medianOf(dsHandsLead);
		            let impHand = medianOf(impHandsLead);
		            const bsHandAvg = medianOf(bsHandsAvg);
		            const topHandAvg = medianOf(topHandsAvg);
		            const dsHandAvg = medianOf(dsHandsAvg);
		            const impHandAvg = medianOf(impHandsAvg);

		            const reconstructed = reconstructHandTrajectoryFromPoseFrames({
		              poseByIdx,
		              metaByIdxPose,
		              frameCount: poseFramesForTrace.length,
		              handedness: (meta?.handedness as "left" | "right" | null | undefined) ?? null,
		            });
		            const reconstructSpread = reconstructed ? computeTraceSpread(reconstructed.smoothed) : 0;
		            const reconstructUnique = reconstructed ? countTraceUnique(reconstructed.smoothed, 0.01) : 0;
		            if (reconstructed && reconstructed.smoothed.length >= 2 && reconstructSpread >= 0.08 && reconstructUnique >= 4) {
		              handTrace = reconstructed.smoothed;
		              poseTraceSource = "reconstruct";
		              poseTraceSourceReason = "reconstruct_spread_unique";
		              bsHand = medianOf(reconstructed.smoothed.filter((p) => p.phase === "backswing").map((p) => ({ x: p.x, y: p.y })));
		              topHand = medianOf(reconstructed.smoothed.filter((p) => p.phase === "top").map((p) => ({ x: p.x, y: p.y })));
		              dsHand = medianOf(reconstructed.smoothed.filter((p) => p.phase === "downswing").map((p) => ({ x: p.x, y: p.y })));
		              impHand = medianOf(reconstructed.smoothed.filter((p) => p.phase === "impact").map((p) => ({ x: p.x, y: p.y })));
		            } else if (leadSpread >= avgSpread && leadSpread >= 0.08) {
		              handTrace = handTraceLead;
		              poseTraceSource = "lead";
		              poseTraceSourceReason = "lead_spread_threshold";
		              bsHand = medianOf(bsHandsLead);
		              topHand = medianOf(topHandsLead);
		              dsHand = medianOf(dsHandsLead);
		              impHand = medianOf(impHandsLead);
		            } else if (avgSpread >= 0.08) {
		              handTrace = handTraceAvg;
		              poseTraceSource = "avg";
		              poseTraceSourceReason = "avg_spread_threshold";
		              bsHand = medianOf(bsHandsAvg);
		              topHand = medianOf(topHandsAvg);
		              dsHand = medianOf(dsHandsAvg);
		              impHand = medianOf(impHandsAvg);
		            }
		            const bsVec = averageUnitDirections(bsVecs);
		            const topVec = averageUnitDirections(topVecs);
		            const dsVec = averageUnitDirections(dsVecs);
		            const impVec = averageUnitDirections(impVecs);
		            poseTraceInfo = {
		              trace: handTrace,
		              unique: countTraceUnique(handTrace, 0.01),
		              spread: computeTraceSpread(handTrace),
		              source: poseTraceSource,
		            };
		            let gripTrace = gripTraceInfo?.trace ?? [];
		            let gripTraceSpreadLocal = gripTraceInfo?.spread ?? 0;
		            const gripUniqueInitial = countTraceUnique(gripTrace, 0.01);
		            if (poseTraceInfo && (gripUniqueInitial < 5 || gripTraceSpreadLocal < 0.12)) {
		              const hintMap = new Map<number, { x: number; y: number }>();
		              poseTraceInfo.trace.forEach((p) => {
		                const idx = gripIdxByFrameIndex.get(p.frameIndex);
		                if (idx == null) return;
		                if (!hintMap.has(idx)) hintMap.set(idx, { x: p.x, y: p.y });
		              });
		              const hints = Array.from(hintMap.entries()).map(([idx, point]) => ({ idx, point }));
		              if (hints.length >= 3) {
		                const refined = await refineGripCentersWithHints({
		                  frames: gripFramesForTrace,
		                  hints,
		                  cropScale: 0.45,
		                });
		                if (refined.length) {
		                  const refinedTrace: Array<{ x: number; y: number; frameIndex: number; timestampSec?: number; phase: "backswing" | "top" | "downswing" | "impact" }> = [];
		                  refined.forEach((g) => {
		                    const meta = metaByIdxGrip.get(g.idx) ?? null;
		                    if (!meta || !g.grip) return;
		                    refinedTrace.push({
		                      x: g.grip.x,
		                      y: g.grip.y,
		                      frameIndex: meta.frameIndex,
		                      timestampSec: meta.timestampSec,
		                      phase: meta.phase,
		                    });
		                  });
		                  refinedTrace.sort((a, b) => (a.timestampSec ?? a.frameIndex) - (b.timestampSec ?? b.frameIndex));
		                  const refinedSpread = computeTraceSpread(refinedTrace);
		                  const refinedUnique = countTraceUnique(refinedTrace, 0.01);
		                  if (refinedUnique > gripUniqueInitial || refinedSpread > gripTraceSpreadLocal) {
		                    gripTrace = refinedTrace;
		                    gripTraceInfo = { trace: refinedTrace, spread: refinedSpread };
		                    gripTraceSpreadLocal = refinedSpread;
		                    (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                      ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		                      grip_pose_hint_used: true,
		                      grip_pose_hint_points: refinedTrace.length,
		                      grip_pose_hint_unique: refinedUnique,
		                      grip_pose_hint_spread: refinedSpread,
		                    };
		                  }
		                }
		              }
		            }
		            const gripHandPoints = {
		              backswing: medianOfPhase(gripTrace, "backswing"),
		              top: medianOfPhase(gripTrace, "top"),
		              downswing: medianOfPhase(gripTrace, "downswing"),
		              impact: medianOfPhase(gripTrace, "impact"),
		            };
		            const posePhaseCounts = countTracePhases(handTrace);
		            const gripPhaseCounts = countTracePhases(gripTrace);
		            const existingDebug = (onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined;
		            if (existingDebug && !("hand_trace_all_frames" in existingDebug)) {
		              const allFrames: Array<{
		                frameIndex: number;
		                timestampSec?: number;
		                phase: "backswing" | "top" | "downswing" | "impact";
		                lead: { x: number; y: number } | null;
		                avg: { x: number; y: number } | null;
		                lw: { x: number; y: number } | null;
		                rw: { x: number; y: number } | null;
		                confidence: number;
		                roi: {
		                  centerLocal: { x: number; y: number };
		                  centerGlobal: { x: number; y: number };
		                  radiusLocal: number;
		                  yMinLocal: number;
		                  yMaxLocal: number;
		                  scale: number;
		                  source: "hip" | "shoulder" | "carry";
		                } | null;
		              }> = [];
		              let roiCenterLocal: { x: number; y: number } | null = null;
		              let roiScale = 1;
		              let roiMissingStreak = 0;
		              for (let i = 0; i < poseFramesForTrace.length; i += 1) {
		                const pose = poseByIdx.get(i) ?? null;
		                const metaInfo = metaByIdxPose.get(i);
		                if (!metaInfo) continue;
		                const lw = readPosePoint(pose, ["leftWrist", "left_wrist", "leftHand", "left_hand"]);
		                const rw = readPosePoint(pose, ["rightWrist", "right_wrist", "rightHand", "right_hand"]);
		                const ls = readPosePoint(pose, ["leftShoulder", "left_shoulder"]);
		                const rs = readPosePoint(pose, ["rightShoulder", "right_shoulder"]);
		                const lh = readPosePoint(pose, ["leftHip", "left_hip"]);
		                const rh = readPosePoint(pose, ["rightHip", "right_hip"]);
		                const shoulderMid = ls && rs ? { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 } : null;
		                const shoulderWidth = ls && rs ? Math.hypot(ls.x - rs.x, ls.y - rs.y) : null;
		                const transform =
		                  shoulderMid && shoulderWidth && Number.isFinite(shoulderWidth) && shoulderWidth > 1e-4
		                    ? { origin: shoulderMid, scale: shoulderWidth }
		                    : null;
		                const hipMid = lh && rh ? { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 } : null;
		                const hipLocal = hipMid && transform ? { x: (hipMid.x - transform.origin.x) / transform.scale, y: (hipMid.y - transform.origin.y) / transform.scale } : null;
		                let roiSource: "hip" | "shoulder" | "carry" = "carry";
		                if (hipLocal) {
		                  const hipCenter = { x: hipLocal.x * 0.5, y: hipLocal.y * 0.5 };
		                  const hipCenterOk = hipCenter.y > -0.3 && hipCenter.y < 0.9;
		                  if (hipCenterOk) {
		                    roiCenterLocal = hipCenter;
		                    roiScale = 1;
		                    roiMissingStreak = 0;
		                    roiSource = "hip";
		                  } else if (transform) {
		                    roiCenterLocal = { x: 0, y: 0.35 };
		                    roiScale = 1;
		                    roiMissingStreak = 0;
		                    roiSource = "shoulder";
		                  }
		                } else if (transform) {
		                  roiCenterLocal = { x: 0, y: 0.35 };
		                  roiScale = 1;
		                  roiMissingStreak = 0;
		                  roiSource = "shoulder";
		                } else if (roiCenterLocal) {
		                  roiMissingStreak += 1;
		                  const targetScale = roiMissingStreak >= 3 ? 1.8 : roiMissingStreak >= 2 ? 1.4 : 1.1;
		                  roiScale = clamp(roiScale * targetScale, 1, 1.8);
		                  roiSource = "carry";
		                }
		                const lead = computeLeadHandPosition(pose, meta?.handedness ?? null);
		                const avg = computeHandPositionAverage(pose);
		                const confidence = lw && rw ? 1 : lead ? 0.85 : avg ? 0.75 : lw || rw ? 0.6 : 0;
		                let roi: {
		                  centerLocal: { x: number; y: number };
		                  centerGlobal: { x: number; y: number };
		                  radiusLocal: number;
		                  yMinLocal: number;
		                  yMaxLocal: number;
		                  scale: number;
		                  source: "hip" | "shoulder" | "carry";
		                } | null = null;
		                if (roiCenterLocal && transform) {
		                  const confScale = confidence < 1 ? 0.9 : 1;
		                  const radiusLocal = (2.2 * confScale + 0.2) * roiScale;
		                  const yMinLocal = roiCenterLocal.y - (1.2 * confScale + 0.2) * roiScale;
		                  const yMaxLocal = roiCenterLocal.y + (2.2 * confScale + 0.4) * roiScale;
		                  const centerGlobal = {
		                    x: transform.origin.x + roiCenterLocal.x * transform.scale,
		                    y: transform.origin.y + roiCenterLocal.y * transform.scale,
		                  };
		                  roi = {
		                    centerLocal: roiCenterLocal,
		                    centerGlobal,
		                    radiusLocal,
		                    yMinLocal,
		                    yMaxLocal,
		                    scale: roiScale,
		                    source: roiSource,
		                  };
		                }
		                allFrames.push({
		                  frameIndex: metaInfo.frameIndex,
		                  timestampSec: metaInfo.timestampSec,
		                  phase: metaInfo.phase,
		                  lead,
		                  avg,
		                  lw,
		                  rw,
		                  confidence,
		                  roi,
		                });
		              }
		              (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                ...(existingDebug ?? {}),
		                hand_trace_all_frames: allFrames,
		              };
		            }
		            (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		              ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		              pose_trace_points: handTrace.length,
		              pose_trace_unique: poseTraceInfo.unique,
		              pose_trace_spread: poseTraceInfo.spread,
		              pose_trace_source: poseTraceInfo.source,
		              pose_trace_source_reason: poseTraceSourceReason,
		              pose_trace_collapsed: poseTraceInfo.unique < 3 || poseTraceInfo.spread < 0.06,
		              pose_lead_unique: leadUnique,
		              pose_lead_spread: leadSpread,
		              pose_avg_unique: avgUnique,
		              pose_avg_spread: avgSpread,
		              pose_trace_sample: handTrace.slice(0, 6).map((p) => ({ x: p.x, y: p.y, phase: p.phase })),
		              pose_trace_phase_counts: posePhaseCounts,
		              grip_trace_phase_counts: gripPhaseCounts,
		              pose_reconstruct_debug: reconstructed?.debug ?? null,
		            };
		            const poseDetectionFailed =
		              useVideoWindow &&
		              reconstructed?.debug?.rawCount === 0 &&
		              handTraceLead.length === 0 &&
		              handTraceAvg.length === 0;
		            if (poseDetectionFailed && onPlaneUpdate) {
		              (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		                pose_video_failed: true,
		                pose_video_failed_reason: "no_pose_points",
		              };
		            }
		            if (!poseDetectionFailed) {
		            const poseTraceSpread = poseTraceInfo.spread;
		            const gripTraceSpread = gripTraceInfo?.spread ?? 0;
		            const poseUnique = poseTraceInfo.unique;
		            const gripUnique = countTraceUnique(gripTrace, 0.01);
		            const gripHighQuality = gripUnique >= 8 && gripTraceSpread >= 0.16;
		            const gripUsable = gripUnique >= 6 && gripTraceSpread >= 0.12;
		            const poseHasBackTop = (posePhaseCounts.backswing ?? 0) + (posePhaseCounts.top ?? 0) > 0;
		            const gripHasBackTop = (gripPhaseCounts.backswing ?? 0) + (gripPhaseCounts.top ?? 0) > 0;
		            const poseHasTop = (posePhaseCounts.top ?? 0) > 0;
		            const gripCollapsed = gripUnique <= 2 || gripTraceSpread < 0.03;
		            const poseCollapsed = poseUnique < 3 || poseTraceSpread < 0.06;
		            const poseUsable = handTrace.length >= 2 && poseUnique >= 2 && poseTraceSpread >= 0.01;
		            const poseReconstructUsable =
		              poseTraceInfo.source === "reconstruct" && !poseCollapsed && poseTraceSpread >= 0.06 && poseUnique >= 3;
		            const posePreferredForDisplay = poseUsable && !poseCollapsed && poseHasTop;
		            const usePoseTrace =
		              poseUsable &&
		              !poseCollapsed &&
		              (gripTrace.length < 2 || gripCollapsed || poseTraceSpread >= gripTraceSpread * 1.05);

		            if (!onPlaneUpdate && (handTrace.length || bsHand || topHand || dsHand || impHand || gripTrace.length)) {
		              onPlaneUpdate =
		                existingOnPlane && typeof existingOnPlane === "object"
		                  ? ({ ...(existingOnPlane as Record<string, unknown>) } as Record<string, unknown>)
		                  : {};
		            }
		            if (onPlaneUpdate) {
		              const gripTraceSpreadSafe = gripTraceSpread;
		              const poseTraceSpreadSafe = poseTraceSpread;
		              const bestIsPose =
		                !gripHighQuality &&
		                poseUsable &&
		                !poseCollapsed &&
		                (usePoseTrace ||
		                  gripTrace.length < 2 ||
		                  gripCollapsed ||
		                  poseUnique > gripUnique ||
		                  (poseUnique === gripUnique && poseTraceSpreadSafe > gripTraceSpreadSafe));
		              if (bestIsPose) {
		                onPlaneUpdate.hand_points = {
		                  backswing: bsHand,
		                  top: topHand,
		                  downswing: dsHand,
		                  impact: impHand,
		                };
		              }
		              const currentHandPoints =
		                onPlaneUpdate.hand_points && typeof onPlaneUpdate.hand_points === "object"
		                  ? (onPlaneUpdate.hand_points as {
		                      backswing?: { x: number; y: number } | null;
		                      top?: { x: number; y: number } | null;
		                      downswing?: { x: number; y: number } | null;
		                      impact?: { x: number; y: number } | null;
		                    })
		                  : null;
		              const poseTopPoint = medianOfPhase(handTrace, "top");
		              if (gripHandPoints.backswing || gripHandPoints.top || gripHandPoints.downswing || gripHandPoints.impact) {
		                onPlaneUpdate.hand_points = {
		                  backswing: currentHandPoints?.backswing ?? gripHandPoints.backswing ?? null,
		                  top: poseTopPoint ?? currentHandPoints?.top ?? gripHandPoints.top ?? null,
		                  downswing: currentHandPoints?.downswing ?? gripHandPoints.downswing ?? null,
		                  impact: currentHandPoints?.impact ?? gripHandPoints.impact ?? null,
		                };
		              }
		              const finalTrace = bestIsPose ? handTrace : gripTrace;
		              const useReconstructTrace = bestIsPose && poseTraceInfo?.source === "reconstruct" && !poseCollapsed;
		              const lockPoseDisplay = posePreferredForDisplay || poseReconstructUsable;
		              if (lockPoseDisplay) {
		                const filtered = filterTraceOutliers(handTrace);
		                const smoothed =
		                  filtered.filtered.length >= 4 ? smoothTraceEma(filtered.filtered, 0.35) : filtered.filtered;
		                onPlaneUpdate.hand_trace = densifyTrace(smoothed, 24);
		                (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                  ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		                  hand_trace_source: "pose_for_display",
		                  hand_trace_smoothed: filtered.filtered.length >= 4,
		                  hand_trace_smoothing: filtered.filtered.length >= 4 ? "ema" : "none",
		                  hand_trace_densified: true,
		                  hand_trace_outliers_removed: filtered.removed,
		                  hand_trace_outlier_threshold: filtered.threshold,
		                };
		              }
		              if (finalTrace.length >= 2 && !lockPoseDisplay) {
		                if (useReconstructTrace) {
		                  onPlaneUpdate.hand_trace = densifyTrace(finalTrace, 24);
		                  (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                    ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		                    hand_trace_source: "pose_reconstruct",
		                    hand_trace_smoothed: true,
		                    hand_trace_smoothing: "moving_avg_catmull",
		                    hand_trace_densified: true,
		                    hand_trace_outliers_removed: 0,
		                    hand_trace_outlier_threshold: 0,
		                  };
		                } else {
		                  const filtered = filterTraceOutliers(finalTrace);
		                  const smoothed =
		                    filtered.filtered.length >= 4 ? smoothTraceEma(filtered.filtered, 0.35) : filtered.filtered;
		                  onPlaneUpdate.hand_trace = densifyTrace(smoothed, 24);
		                  (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                    ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		                    hand_trace_source: bestIsPose ? "pose" : "grip",
		                    hand_trace_smoothed: filtered.filtered.length >= 4,
		                    hand_trace_smoothing: filtered.filtered.length >= 4 ? "ema" : "none",
		                    hand_trace_densified: true,
		                    hand_trace_outliers_removed: filtered.removed,
		                    hand_trace_outlier_threshold: filtered.threshold,
		                  };
		                }
		              }
		              if (!gripHighQuality && !useReconstructTrace && !lockPoseDisplay) {
		                const phaseWise = buildPhaseWiseTrace(gripUsable ? gripTrace : [], handTrace);
		                if (phaseWise.length >= 2) {
		                  const filtered = filterTraceOutliers(phaseWise);
		                  const smoothed =
		                    filtered.filtered.length >= 4 ? smoothTraceEma(filtered.filtered, 0.35) : filtered.filtered;
		                  onPlaneUpdate.hand_trace = densifyTrace(smoothed, 24);
		                  (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                    ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		                    hand_trace_source: gripUsable ? "phasewise_mix" : "pose_only_low_grip",
		                    hand_trace_smoothed: filtered.filtered.length >= 4,
		                    hand_trace_smoothing: filtered.filtered.length >= 4 ? "ema" : "none",
		                    hand_trace_densified: true,
		                    hand_trace_outliers_removed: filtered.removed,
		                    hand_trace_outlier_threshold: filtered.threshold,
		                  };
		                }
		              }
		              if (gripHighQuality && gripTrace.length >= 2 && !lockPoseDisplay) {
		                const filtered = filterTraceOutliers(gripTrace);
		                const smoothed =
		                  filtered.filtered.length >= 4 ? smoothTraceEma(filtered.filtered, 0.35) : filtered.filtered;
		                onPlaneUpdate.hand_trace = densifyTrace(smoothed, 24);
		                (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                  ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		                  hand_trace_source: "grip_quality_override",
		                  hand_trace_smoothed: filtered.filtered.length >= 4,
		                  hand_trace_smoothing: filtered.filtered.length >= 4 ? "ema" : "none",
		                  hand_trace_densified: true,
		                  hand_trace_outliers_removed: filtered.removed,
		                  hand_trace_outlier_threshold: filtered.threshold,
		                };
		              }
		              if (bestIsPose && !poseHasBackTop && gripHasBackTop && gripTrace.length >= 2) {
		                onPlaneUpdate.hand_trace = gripTrace;
		                (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                  ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		                  hand_trace_source: "grip_for_display",
		                };
		              }
		              const downswingPts = finalTrace
		                .filter((p) => p.phase === "downswing" || p.phase === "impact")
		                .map((p) => ({ x: p.x, y: p.y }));
		              if (downswingPts.length >= 2) {
		                const fit = buildBestFitLine01(downswingPts);
		                if (fit) {
		                  onPlaneUpdate.downswing_plane = fit;
		                  onPlaneUpdate.plane_source = bestIsPose ? "pose_trace_fit" : "hand_trace_fit";
		                  onPlaneUpdate.plane_confidence = "low";
		                }
		              }
		            }
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
                  let addrZone: ReturnType<typeof mergeAddressZones> | null = null;
                  if (allowLLM) {
                    for (const frame of addrFrames) {
                      const zone = await detectAddressZoneFromAddressFrame(frame, meta?.handedness ?? null, allowLLM);
                      if (zone) addrZones.push(zone);
                    }
                    addrZone = mergeAddressZones(addrZones);
                  } else if (onPlaneUpdate) {
                    (onPlaneUpdate as Record<string, unknown>).pose_debug = {
                      ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
                      address_llm_skipped: true,
                    };
                  }
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
                      addrFrames.map((f) => extractAddressPoseLandmarks(f, meta?.handedness ?? null, allowLLM)),
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
                for (let i = 0; i < poseFramesForTrace.length; i += 1) {
                  const metaInfo = metaByIdxPose.get(i);
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
		                if (!onPlaneUpdate) {
		                  onPlaneUpdate =
		                    existingOnPlane && typeof existingOnPlane === "object"
		                      ? ({ ...(existingOnPlane as Record<string, unknown>) } as Record<string, unknown>)
		                      : {};
		                }
		                (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                  ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		                  model: process.env.OPENAI_POSE_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o",
		                  returned: poseFrames.length,
		                  // capture errors to verify pose extraction is actually running
		                  ...(poseError ? { error: poseError.slice(0, 240) } : {}),
		                  hasTopHand: !!topHand,
		                  hasBackHand: !!bsHand,
		                  hasDownHand: !!dsHand,
		                  hasImpactHand: !!impHand,
		                  pose_trace_unique: poseUnique,
		                  pose_trace_spread: poseTraceSpread,
		                  grip_trace_unique: gripUnique,
		                  grip_trace_spread: gripTraceSpread,
		                  hasBackShaft: !!bsVec,
		                  hasTopShaft: !!topVec,
		                  hasDownShaft: !!dsVec,
		                  hasImpactShaft: !!impVec,
		                  backHandCount: bsHandsLead.length,
		                  topHandCount: topHandsLead.length,
		                  downHandCount: dsHandsLead.length,
		                  impactHandCount: impHandsLead.length,
		                  poseKeys: {
		                    backswing: poseKeys(0),
		                    top: poseKeys(Math.min(bsCount, poseFramesForTrace.length - 1)),
		                    downswing: poseKeys(Math.min(bsCount + topCount, poseFramesForTrace.length - 1)),
		                    impact: poseKeys(Math.min(bsCount + topCount + dsCount, poseFramesForTrace.length - 1)),
		                  },
	                  poseSample: {
	                    backswing: poseSample(0),
	                    top: poseSample(Math.min(bsCount, poseFramesForTrace.length - 1)),
	                    downswing: poseSample(Math.min(bsCount + topCount, poseFramesForTrace.length - 1)),
	                    impact: poseSample(Math.min(bsCount + topCount + dsCount, poseFramesForTrace.length - 1)),
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
		                const seg = computeLineEvidenceSegment(backLine, [...topHandsAvg, ...(topHandAvg ? [topHandAvg] : [])]);
		                if (seg) op.backswing_plane_evidence = seg;
		              }
		              if (downLine) {
		                const seg = computeLineEvidenceSegment(downLine, [
		                  ...dsHandsAvg,
		                  ...impHandsAvg,
		                  ...(dsHandAvg ? [dsHandAvg] : []),
		                  ...(impHandAvg ? [impHandAvg] : []),
		                ]);
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
		            const zoneAnchor = anchorForRef ?? gripPoint ?? null;
		            const addrHand = gripPoint ?? null;
		            const addrHands: Array<{ x: number; y: number }> = [];
		            const addrShaftVec = anchorForRef && gripPoint ? { x: gripPoint.x - anchorForRef.x, y: gripPoint.y - anchorForRef.y } : null;
		            const fallbackRefVec = bsVec ?? downVec ?? dsVec ?? impVec;
		            const traceRefVec = (() => {
		              if (fallbackRefVec) return fallbackRefVec;
		              const trace = (gripTraceInfo?.trace?.length ? gripTraceInfo?.trace : poseTraceInfo?.trace) ?? [];
		              const fit = trace.length >= 2 ? buildTraceFitLine(trace.map((p) => ({ x: p.x, y: p.y, phase: p.phase }))) : null;
		              if (!fit) return null;
		              return { x: fit.line.x2 - fit.line.x1, y: fit.line.y2 - fit.line.y1 };
		            })();
		            const traceAnchor =
		              anchorForRef ??
		              gripPoint ??
		              medianOf((gripTraceInfo?.trace ?? []).map((p) => ({ x: p.x, y: p.y }))) ??
		              medianOf((poseTraceInfo?.trace ?? []).map((p) => ({ x: p.x, y: p.y }))) ??
		              null;
		            const referenceAnchor = traceAnchor;
		            let referencePlane = referenceAnchor
		              ? buildLineThroughUnitBox({ anchor: referenceAnchor, dir: addrShaftVec ?? traceRefVec ?? { x: 1, y: -1 } })
		              : null;
		            let referencePlaneSource: "shaft_vector_2d" | "trace_ref" | null = referencePlane ? "shaft_vector_2d" : null;
		            const poseCollapsedForRef =
		              !poseTraceInfo || poseTraceInfo.unique < 4 || poseTraceInfo.spread < 0.08;
		            if (poseCollapsedForRef && gripTraceInfo?.trace?.length) {
		              const gripDown = gripTraceInfo.trace
		                .filter((p) => p.phase === "downswing" || p.phase === "impact")
		                .map((p) => ({ x: p.x, y: p.y }));
		              const traceLine = gripDown.length >= 2 ? buildBestFitLine01(gripDown) : null;
		              if (traceLine) {
		                referencePlane = traceLine;
		                referencePlaneSource = "trace_ref";
		                (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                  ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		                  reference_plane_source: "grip_trace_fit",
		                };
		              }
		            }
		            const downswingPlane =
		              (dsHandAvg ?? impHandAvg) && downVec ? buildLineThroughUnitBox({ anchor: dsHandAvg ?? impHandAvg, dir: downVec }) : null;

		            if (!onPlaneUpdate) {
		              onPlaneUpdate =
		                existingOnPlane && typeof existingOnPlane === "object"
		                  ? ({ ...(existingOnPlane as Record<string, unknown>) } as Record<string, unknown>)
		                  : {};
		            }
		            if (onPlaneUpdate) {
		              const planeSource = String((onPlaneUpdate as Record<string, unknown>).plane_source ?? "");
		              const traceFit = buildTraceFitLine((onPlaneUpdate.hand_trace as Array<{ x: number; y: number; phase?: string }>) ?? []);
		              const hasTraceFit = planeSource === "hand_trace_fit" || planeSource === "pose_trace_fit";
		              if (referencePlane) onPlaneUpdate.reference_plane = referencePlane;
		              if (traceFit && !referencePlane && (!hasTraceFit || planeSource === "shaft_vector_2d")) {
		                onPlaneUpdate.downswing_plane = traceFit.line;
		                onPlaneUpdate.plane_source = "hand_trace_fit";
		                onPlaneUpdate.plane_confidence = "low";
		                if (process.env.NODE_ENV !== "production") {
		                  (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                    ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		                    trace_fit_unique: traceFit.unique,
		                    trace_fit_spread: traceFit.spread,
		                  };
		                }
		              } else if (!hasTraceFit && downswingPlane) {
		                onPlaneUpdate.downswing_plane = downswingPlane;
		              }
		              if (referencePlane) {
		                const seg = computeLineEvidenceSegment(referencePlane, [
		                  ...(zoneAnchor ? [zoneAnchor] : []),
		                  ...(addrHands.length ? addrHands : []),
		                  ...(addrHand ? [addrHand] : []),
		                ]);
		                if (seg) onPlaneUpdate.reference_plane_evidence = seg;
		              }
		              if (downswingPlane) {
		                const seg = computeLineEvidenceSegment(downswingPlane, [
		                  ...dsHandsAvg,
		                  ...impHandsAvg,
		                  ...(dsHandAvg ? [dsHandAvg] : []),
		                  ...(impHandAvg ? [impHandAvg] : []),
		                ]);
		                if (seg) onPlaneUpdate.downswing_plane_evidence = seg;
		              }
		              if (referencePlane || downswingPlane) {
		                onPlaneUpdate.plane_source = referencePlaneSource ?? "shaft_vector_2d";
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
		              if (!allowLLM) {
		                (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                  ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		                  grip_fallback_skipped: true,
		                };
		              } else {
		                try {
		                  const gripFrames = gripFramesForTrace.map((f) => ({ base64Image: f.base64Image, mimeType: f.mimeType, timestampSec: f.timestampSec }));
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
		                    const meta = metaByIdxGrip.get(g.idx) ?? null;
		                    if (!meta || !g.grip) return;
		                    gripTrace.push({ x: g.grip.x, y: g.grip.y, frameIndex: meta.frameIndex, timestampSec: meta.timestampSec, phase: meta.phase });
		                  });
		                  gripTrace.sort((a, b) => (a.timestampSec ?? a.frameIndex) - (b.timestampSec ?? b.frameIndex));
		                  if (gripTrace.length >= 2) {
		                    onPlaneUpdate.hand_trace = gripTrace;
		                  }
		                  if (gripTrace.length >= 1) {
		                    const byPhase = (ph: "backswing" | "top" | "downswing" | "impact") =>
		                      medianOf(gripTrace.filter((p) => p.phase === ph).map((p) => ({ x: p.x, y: p.y })));
		                    onPlaneUpdate.hand_points = {
		                      backswing: byPhase("backswing"),
		                      top: byPhase("top"),
		                      downswing: byPhase("downswing"),
		                      impact: byPhase("impact"),
		                    };
		                  }
		                  (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                    ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		                    grip_fallback_used: true,
		                    grip_fallback_points: gripTrace.length,
		                    grip_fallback_roi_refined: refined.refinedCount,
		                    grip_fallback_roi_frames: refined.refinedFrames,
		                    grip_fallback_sample: gripTrace.slice(0, 5).map((p) => ({ x: p.x, y: p.y, phase: p.phase })),
		                  };
		                } catch (e) {
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
		        } catch (e) {
		          if (!onPlaneUpdate) {
		            onPlaneUpdate =
		              existingOnPlane && typeof existingOnPlane === "object"
		                ? ({ ...(existingOnPlane as Record<string, unknown>) } as Record<string, unknown>)
		                : {};
		          }
		          (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		            ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		            pose_block_error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
		          };
		        }

		        if (onPlaneUpdate) {
		          const traceSnapshot = Array.isArray(onPlaneUpdate.hand_trace)
		            ? (onPlaneUpdate.hand_trace as Array<{ x: number; y: number; phase?: string }>).slice(0, 8)
		            : [];
		          (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		            ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		            hand_trace_len: Array.isArray(onPlaneUpdate.hand_trace) ? onPlaneUpdate.hand_trace.length : 0,
		            hand_trace_sample: traceSnapshot.map((p) => ({ x: p.x, y: p.y, phase: p.phase })),
		            hand_trace_phase_counts: Array.isArray(onPlaneUpdate.hand_trace) ? countTracePhases(onPlaneUpdate.hand_trace as Array<{ phase?: string | null }>) : {},
		          };
		          const gripTrace = gripTraceInfo?.trace ?? [];
		          const gripUnique = countTraceUnique(gripTrace, 0.01);
		          const gripSpread = gripTraceInfo?.spread ?? 0;
		          const gripCollapsed = gripUnique <= 2 || gripSpread < 0.03;
		          const posePhaseCounts = poseTraceInfo ? countTracePhases(poseTraceInfo.trace) : {};
		          const gripPhaseCounts = countTracePhases(gripTrace);
		          const poseHasBackTop = (posePhaseCounts.backswing ?? 0) + (posePhaseCounts.top ?? 0) > 0;
		          const gripHasBackTop = (gripPhaseCounts.backswing ?? 0) + (gripPhaseCounts.top ?? 0) > 0;
		          const poseCollapsed =
		            !poseTraceInfo || poseTraceInfo.unique < 3 || poseTraceInfo.spread < 0.06;
		          if (poseCollapsed && gripTrace.length >= 2) {
		            const filtered = filterTraceOutliers(gripTrace);
		            const smoothed =
		              filtered.filtered.length >= 4 ? smoothTraceEma(filtered.filtered, 0.35) : filtered.filtered;
		            onPlaneUpdate.hand_trace = densifyTrace(smoothed, 24);
		            (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		              ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		              hand_trace_source: "grip_low_confidence",
		              hand_trace_smoothed: filtered.filtered.length >= 4,
		              hand_trace_smoothing: filtered.filtered.length >= 4 ? "ema" : "none",
		              hand_trace_densified: true,
		              hand_trace_outliers_removed: filtered.removed,
		              hand_trace_outlier_threshold: filtered.threshold,
		            };
		          }
		          if (poseTraceInfo) {
		            (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		              ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		              pose_trace_points: poseTraceInfo.trace.length,
		              pose_trace_unique: poseTraceInfo.unique,
		              pose_trace_spread: poseTraceInfo.spread,
		              grip_trace_unique: gripUnique,
		              grip_trace_spread: gripSpread,
		              pose_trace_phase_counts: posePhaseCounts,
		              grip_trace_phase_counts: gripPhaseCounts,
		            };
		          }
		          if (
		            poseTraceInfo &&
		            poseTraceInfo.source !== "reconstruct" &&
		            poseTraceInfo.unique >= 2 &&
		            poseTraceInfo.spread >= 0.01 &&
		            gripCollapsed &&
		            (!gripHasBackTop || poseHasBackTop)
		          ) {
		            const filtered = filterTraceOutliers(poseTraceInfo.trace);
		            const smoothed =
		              filtered.filtered.length >= 4 ? smoothTraceEma(filtered.filtered, 0.35) : filtered.filtered;
		            onPlaneUpdate.hand_trace = densifyTrace(smoothed, 24);
		            (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		              ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		              hand_trace_source: "pose_collapse_override",
		              hand_trace_smoothed: filtered.filtered.length >= 4,
		              hand_trace_smoothing: filtered.filtered.length >= 4 ? "ema" : "none",
		              hand_trace_densified: true,
		              hand_trace_outliers_removed: filtered.removed,
		              hand_trace_outlier_threshold: filtered.threshold,
		            };
		            const downswingPts = poseTraceInfo.trace
		              .filter((p) => p.phase === "downswing" || p.phase === "impact")
		              .map((p) => ({ x: p.x, y: p.y }));
		            if (downswingPts.length >= 2) {
		              const fit = buildBestFitLine01(downswingPts);
		              if (fit) {
		                onPlaneUpdate.downswing_plane = fit;
		                onPlaneUpdate.plane_source = "pose_trace_fit";
		                onPlaneUpdate.plane_confidence = "low";
		              }
		            }
		          }
		        }

		        // Final safeguard: if a trace exists, derive a fit line even if pose block failed.
        if (onPlaneUpdate && Array.isArray(onPlaneUpdate.hand_trace)) {
          const planeSource = String((onPlaneUpdate as Record<string, unknown>).plane_source ?? "");
          const hasRefPlane = !!(onPlaneUpdate as Record<string, unknown>).reference_plane;
          const traceFit = buildTraceFitLine(onPlaneUpdate.hand_trace as Array<{ x: number; y: number; phase?: string }>);
          if (traceFit && !planeSource && !hasRefPlane) {
            onPlaneUpdate.downswing_plane = traceFit.line;
            onPlaneUpdate.plane_source = "hand_trace_fit";
            onPlaneUpdate.plane_confidence = "low";
		            if (process.env.NODE_ENV !== "production") {
		              (onPlaneUpdate as Record<string, unknown>).pose_debug = {
		                ...((onPlaneUpdate as Record<string, unknown>).pose_debug as Record<string, unknown> | undefined),
		                trace_fit_unique: traceFit.unique,
		                trace_fit_spread: traceFit.spread,
		              };
		            }
		          }
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

  let baseResult: SwingAnalysis = stored.result as SwingAnalysis;
  let phaseComparison: ReturnType<typeof buildPhaseComparison> | null = null;
  if (!onPlaneOnly) {
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
    baseResult = rescored;
  }

  let previousReport: SwingAnalysis | null = null;
  const previousAnalysisId = stored.meta?.previousAnalysisId ?? null;
  if (typeof previousAnalysisId === "string" && previousAnalysisId !== analysisId) {
    const previousLoaded = await loadAuthorizedAnalysis(req, previousAnalysisId as AnalysisId);
    if (!previousLoaded.error && "stored" in previousLoaded) {
      previousReport = previousLoaded.stored.result ?? null;
    }
  }

  if (!onPlaneOnly) {
    phaseComparison = previousReport ? buildPhaseComparison(previousReport, baseResult) : null;
  }
  const previousOnPlane =
    (previousReport as unknown as Record<string, unknown> | null)?.on_plane ??
    (previousReport as unknown as Record<string, unknown> | null)?.onPlane ??
    null;
  const finalResult = {
    ...baseResult,
    comparison: onPlaneOnly ? baseResult.comparison : phaseComparison ?? baseResult.comparison,
    on_plane:
      onPlaneUpdate
        ? { ...onPlaneUpdate, ...(previousOnPlane ? { previous: previousOnPlane } : null) }
        : (stored.result as unknown as Record<string, unknown>)?.on_plane ?? null,
  };

  const updated = {
    ...stored,
    meta: onPlaneOnly
      ? { ...(stored.meta ?? {}) }
      : {
          ...(stored.meta ?? {}),
          phaseOverrideSig: requestedOverrideSig,
          phaseReevalVersion: PHASE_REEVAL_VERSION,
          ...(fixedAddressIndex ? { addressFrameIndex: fixedAddressIndex } : null),
          phaseOverrideFrames: {
            ...(storedPhaseOverrides ?? {}),
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
