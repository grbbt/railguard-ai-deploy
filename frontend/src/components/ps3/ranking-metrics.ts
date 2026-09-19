import type { RankingMetrics } from '@/lib/ps3-types';

/** Hit rates come only from saved case counts, never from a ranking score. */
export function rankingSummary(metrics?: RankingMetrics | null) {
  if (!metrics || !Number.isSafeInteger(metrics.cases) || metrics.cases <= 0
    || !Number.isSafeInteger(metrics.top1_correct) || !Number.isSafeInteger(metrics.top2_correct)
    || metrics.top1_correct < 0 || metrics.top2_correct < metrics.top1_correct || metrics.top2_correct > metrics.cases) return null;
  return {
    cases: metrics.cases,
    top1: { correct: metrics.top1_correct, percent: 100 * metrics.top1_correct / metrics.cases },
    top2: { correct: metrics.top2_correct, percent: 100 * metrics.top2_correct / metrics.cases },
    meanRank: typeof metrics.mean_rank === 'number' && Number.isFinite(metrics.mean_rank) && metrics.mean_rank >= 1 ? metrics.mean_rank : null,
  };
}
