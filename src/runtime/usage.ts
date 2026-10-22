export type UsageWindow = { usedPercent: number | null; durationMins: number | null; resetsAt: number | null };
export type AccountUsage = {
  buckets: { id: string; name: string; windows: UsageWindow[] }[];
  loading: boolean;
  unavailable: boolean;
  stale?: boolean;
  fetchedAt?: number;
};
export type TokenUsage = {
  total: { input: number | null; cached: number | null; output: number | null; reasoning: number | null };
  lastTokens: number | null;
  contextWindow: number | null;
};
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
export function accountUsage(response: any): AccountUsage {
  const multi = response?.rateLimitsByLimitId;
  const entries: [string, any][] =
    multi && typeof multi === 'object' && !Array.isArray(multi) && Object.keys(multi).length
      ? Object.entries(multi).slice(0, 30)
      : response?.rateLimits
        ? [[response.rateLimits.limitId ?? 'codex', response.rateLimits]]
        : [];
  return {
    loading: false,
    unavailable: entries.length === 0,
    fetchedAt: Date.now(),
    buckets: entries
      .filter(([, value]) => value && typeof value === 'object')
      .map(([id, value]) => ({
        id: String(id).slice(0, 100),
        name: String(value.limitName ?? id).slice(0, 200),
        windows: [value.primary, value.secondary]
          .filter(w => w && typeof w === 'object')
          .map(w => ({
            usedPercent:
              typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) && w.usedPercent >= 0
                ? w.usedPercent
                : null,
            durationMins: count(w.windowDurationMins),
            resetsAt: count(w.resetsAt) !== null && w.resetsAt <= 8_640_000_000_000 ? w.resetsAt : null,
          })),
      })),
  };
}
export function tokenUsage(value: any): TokenUsage {
  return {
    total: {
      input: count(value?.total?.inputTokens),
      cached: count(value?.total?.cachedInputTokens),
      output: count(value?.total?.outputTokens),
      reasoning: count(value?.total?.reasoningOutputTokens),
    },
    lastTokens: count(value?.last?.totalTokens),
    contextWindow: count(value?.modelContextWindow),
  };
}
