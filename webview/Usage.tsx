import React, { useEffect, useState } from 'react';
import type { Action, ViewState } from '../src/shared';
import type en from '../locales/en.json';
export function Usage({
  state,
  t,
  post,
  compact = false,
}: {
  state: ViewState;
  t: typeof en;
  post(action: Action): void;
  compact?: boolean;
}) {
  const account = state.usage,
    tokens = state.tokenUsage;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const checking =
    state.status === 'connecting' ||
    (state.account === 'unknown' &&
      Boolean(state.runtimeVersion) &&
      !state.accountReadFailed &&
      !['offline', 'unknown'].includes(state.status));
  const number = (value: number | null | undefined) =>
    value == null ? t.usageUnavailable : new Intl.NumberFormat(state.locale).format(value);
  const resetLabel = (timestamp: number | null) => {
    if (timestamp == null) return `${t.resetsAt}: ${t.usageUnavailable}`;
    const minutes = Math.ceil((timestamp * 1000 - now) / 60000);
    if (minutes <= 0) return t.resetPending;
    const unit = (value: number, unit: 'day' | 'hour' | 'minute') =>
      new Intl.NumberFormat(state.locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(value);
    const days = Math.floor(minutes / 1440),
      hours = Math.floor((minutes % 1440) / 60);
    const time = days
      ? `${unit(days, 'day')} ${unit(hours, 'hour')}`
      : hours
        ? `${unit(hours, 'hour')} ${unit(minutes % 60, 'minute')}`
        : unit(minutes, 'minute');
    return t.resetsIn.replace('{time}', time);
  };
  return (
    <section className="usage-panel" aria-label={t.usage} title={compact ? t.usageHelp : undefined}>
      <div className="section-heading">
        <h2>{t.usage}</h2>
        <button
          className="secondary"
          disabled={
            account?.loading ||
            state.account !== 'chatgpt' ||
            ['offline', 'connecting', 'unknown'].includes(state.status)
          }
          onClick={() => post({ type: 'refreshUsage' })}
        >
          {t.refresh}
        </button>
      </div>
      {!compact ? <p className="muted">{t.usageHelp}</p> : null}
      {account?.loading ? <p role="status">{t.loadingIntegrations}</p> : null}
      {account?.fetchedAt ? (
        <p className="muted">
          {t.usageUpdated}: {new Date(account.fetchedAt).toLocaleString(state.locale)}
        </p>
      ) : null}
      {account?.stale ? <p role="status">{t.usageStale}</p> : null}
      {!account || account.unavailable ? (
        <p role={checking ? 'status' : undefined}>{checking ? t.cliChecking : t.usageUnavailable}</p>
      ) : (
        account.buckets.map(bucket => (
          <section key={bucket.id} className="usage-bucket">
            <h3>{bucket.name}</h3>
            {!bucket.windows.length ? (
              <p>{t.usageUnavailable}</p>
            ) : (
              bucket.windows.map((window, index) => (
                <div className="usage-window" key={index}>
                  <strong>
                    {window.durationMins === 10080
                      ? t.weeklyLimit
                      : window.durationMins === 300
                        ? t.fiveHourLimit
                        : t.usageWindow}
                  </strong>
                  <span>
                    {window.usedPercent == null
                      ? t.usageUnavailable
                      : `${number(Math.max(0, 100 - window.usedPercent))}% ${t.remaining}`}
                  </span>
                  {window.usedPercent != null ? (
                    <meter min={0} max={100} value={Math.max(0, 100 - window.usedPercent)} aria-label={t.remaining} />
                  ) : null}
                  <small
                    title={
                      window.resetsAt == null
                        ? undefined
                        : `${t.resetsAt}: ${new Date(window.resetsAt * 1000).toLocaleString(state.locale)}`
                    }
                  >
                    {resetLabel(window.resetsAt)}
                  </small>
                </div>
              ))
            )}
          </section>
        ))
      )}
      {!compact ? (
        <>
          <h3>{t.contextUsage}</h3>
          <p className="muted">{t.contextUsageHelp}</p>
          <dl className="token-usage">
            {[
              [t.latestTokens, tokens?.lastTokens],
              [t.contextLimit, tokens?.contextWindow],
              [t.inputTokens, tokens?.total.input],
              [t.cachedTokens, tokens?.total.cached],
              [t.outputTokens, tokens?.total.output],
              [t.reasoningTokens, tokens?.total.reasoning],
            ].map(([label, value]) => (
              <React.Fragment key={label as string}>
                <dt>{label}</dt>
                <dd>{number(value as number | undefined)}</dd>
              </React.Fragment>
            ))}
          </dl>
        </>
      ) : null}
    </section>
  );
}
