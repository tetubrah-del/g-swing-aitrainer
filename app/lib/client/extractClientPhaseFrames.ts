/**
 * Client-side phase frame extractor
 *
 * P1 仕様：
 * 1. extractKeyFrames() で動画全体を約 25–35 フレームに間引き
 * 2. computeMotionEnergy() で隣接差分から動き量を算出
 * 3. detectPhases() で Address / Top / Downswing / Impact / Finish を決定
 */

import { extractKeyFrames } from "./extractKeyFrames";
import { computeMotionEnergy } from "../vision/computeMotionEnergy";
import { detectPhases } from "../vision/detectPhases";
import type { PhaseFrame } from "../vision/extractFrames";

export interface ClientPhaseFrames {
  address: PhaseFrame;
  top: PhaseFrame;
  downswing: PhaseFrame;
  impact: PhaseFrame;
  finish: PhaseFrame;
  debug?: {
    energies: number[];
    keyframes: PhaseFrame[];
    indices: Record<string, number>;
  };
}

export async function extractClientPhaseFrames(file: File): Promise<ClientPhaseFrames> {
  // 1️⃣ Key frames 抽出
  const keyframes = await extractKeyFrames(file);
  if (!keyframes.length) throw new Error("Keyframes が抽出できませんでした");

  // 2️⃣ motion energy を計算
  const energies = await computeMotionEnergy(keyframes);

  // 3️⃣ 動きのパターンから 5 フェーズを推定
  const phases = detectPhases(keyframes, energies);

  const get = (idx: number): PhaseFrame => {
    const f = keyframes[idx];
    return {
      id: f.id,
      base64Image: f.base64Image,
      mimeType: f.mimeType,
      timestampSec: f.timestampSec,
    };
  };

  return {
    address: get(phases.address),
    top: get(phases.top),
    downswing: get(phases.downswing),
    impact: get(phases.impact),
    finish: get(phases.finish),
    debug: {
      energies,
      keyframes,
      indices: phases,
    },
  };
}

