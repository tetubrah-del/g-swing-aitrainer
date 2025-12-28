export type LevelEstimate = { label: string; detail: string };

export type RoundEstimateMetrics = {
  strokeRange: string;
  fwKeep: string;
  gir: string;
  ob: string;
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function estimateLevelFromScore(scoreRaw: number): LevelEstimate {
  const score = clamp(Number.isFinite(scoreRaw) ? scoreRaw : 0, 0, 100);
  if (score >= 90)
    return {
      label: "上級",
      detail:
        "全体の完成度が高く、動きの再現性が高いスイングです。良い点は、切り返し以降の体幹の回転が途切れにくく、インパクトでの当たり負けが少ないことです。一方で、わずかなフェース向きのズレやリリースのタイミング差が球筋に出やすく、弾道のばらつき要因になりやすい傾向があります。",
    };
  if (score >= 80)
    return {
      label: "中上級",
      detail:
        "全体のバランスが良く、スイングの形が崩れにくいタイプです。良い点は、トップ〜ダウンの動きが比較的スムーズで、ミート率につながる“体とクラブの同調”が見えやすいことです。課題は、切り返し付近でクラブの落ち方／フェース向きが一定になりきらず、方向性のブレが残りやすい点です。",
    };
  if (score >= 60)
    return {
      label: "中級",
      detail:
        "基本動作は安定しており、スイングの形としては十分にまとまっています。良い点は、アドレス〜トップまでの流れが大きく破綻せず、振り抜きまでのリズムが作れていることです。課題は、重心位置やトップ位置にわずかな差が出やすく、その影響が切り返し以降のクラブ軌道／フェース向きのばらつきとして現れやすい点です。",
    };
  if (score >= 45)
    return {
      label: "初級",
      detail:
        "スイングは成立しており、形の方向性も見えています。良い点は、フィニッシュまで振り切ろうとする意識があり、動作が途中で止まりにくいことです。課題は、アドレスの姿勢（前傾・重心）やグリップの一定感が揺れやすく、インパクトで当たり所とフェース向きが安定しにくい点です。",
    };
  return {
    label: "ビギナー",
    detail:
      "スイングの骨格を作っている段階で、動きの再現性はこれから伸びるタイプです。良い点は、クラブを振る動作自体はできており、改善に必要な“基準の形”を作れる余地が大きいことです。課題は、アドレス姿勢とテンポが毎回変わりやすく、トップ位置やインパクトの当たり所が揃いにくい点です。",
  };
}

export function computeRoundFallbackFromScore(scoreRaw: number): RoundEstimateMetrics {
  const score = clamp(Number.isFinite(scoreRaw) ? scoreRaw : 0, 0, 100);

  // Calibrated for typical amateurs:
  // - swing score ~70 -> ~90前後
  // - swing score ~50 -> ~105〜115
  const mid = Math.round(155 - score * 0.9);
  const spread = 4;
  const low = clamp(mid - spread, 70, 140);
  const high = clamp(mid + spread, 70, 140);

  const fwKeep = clamp(25 + score * 0.35, 25, 70);
  const gir = clamp(10 + score * 0.3, 10, 55);
  const ob = clamp(7 - score * 0.045, 1.5, 7);

  return {
    strokeRange: `${low}〜${high}`,
    fwKeep: `${fwKeep.toFixed(0)}%`,
    gir: `${gir.toFixed(0)}%`,
    ob: `${ob.toFixed(1)} 回`,
  };
}
