import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
  costUsd: number;
}

interface RunningIssue {
  issueId: string;
  identifier: string;
  issueUrl: string | null;
  state: string;
  attempt: number | null;
  continuation: number;
  turnCount: number;
  startedAt: string;
  lastActivityAt: string;
  secondsRunning: number;
  usage: Usage;
  lastEvent: string | null;
}

interface RetryingIssue {
  issueId: string;
  identifier: string;
  issueUrl: string | null;
  attempt: number;
  dueAt: string;
  reason: "continuation" | "failure";
}

interface BlockedIssue {
  issueId: string;
  identifier: string;
  issueUrl: string | null;
  blockedAt: string;
  reasonCode:
    | "agent_reported"
    | "operator_action_required"
    | "retry_budget_exhausted"
    | "run_interrupted"
    | "orchestrator_failure"
    | "unknown";
}

interface RateLimit {
  status: "allowed" | "allowed_warning" | "rejected";
  rateLimitType:
    | "five_hour"
    | "seven_day"
    | "seven_day_opus"
    | "seven_day_sonnet"
    | "seven_day_overage_included"
    | "overage"
    | null;
  utilization: number | null;
}

interface DashboardState {
  generatedAt: string;
  startedAt: string | null;
  lastPollAt: string | null;
  dispatchPaused: boolean;
  counts: {
    running: number;
    retrying: number;
    blocked: number;
  };
  running: RunningIssue[];
  retrying: RetryingIssue[];
  blocked: BlockedIssue[];
  totals: Usage & { secondsRunning: number };
  rateLimit: RateLimit | null;
}

const unavailableMessage = "Dashboard data is temporarily unavailable. Retrying automatically.";
const actionFailedMessage = "The request could not be completed. Refresh and try again.";
const operationHeaders = { "X-Symphony-Operation": "1" };
const numberFormatter = new Intl.NumberFormat();
const currencyFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});
const blockedReasonLabels: Record<BlockedIssue["reasonCode"], string> = {
  agent_reported: "Agent reported",
  operator_action_required: "Operator action required",
  retry_budget_exhausted: "Retry budget exhausted",
  run_interrupted: "Run interrupted",
  orchestrator_failure: "Orchestrator failure",
  unknown: "Unknown",
};
const rateLimitStatusLabels: Record<RateLimit["status"], string> = {
  allowed: "Available",
  allowed_warning: "Warning",
  rejected: "Rate limited",
};
const rateLimitTypeLabels: Record<NonNullable<RateLimit["rateLimitType"]>, string> = {
  five_hour: "5-hour",
  seven_day: "7-day",
  seven_day_opus: "7-day Opus",
  seven_day_sonnet: "7-day Sonnet",
  seven_day_overage_included: "7-day overage included",
  overage: "Overage",
};

function App() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [changingDispatch, setChangingDispatch] = useState(false);
  const [retryingBlockedIssue, setRetryingBlockedIssue] = useState<string | null>(null);
  const activeController = useRef<AbortController | null>(null);

  const loadState = useCallback(async (replaceActive = false) => {
    if (activeController.current !== null) {
      if (!replaceActive) return;
      activeController.current.abort();
    }
    const controller = new AbortController();
    activeController.current = controller;
    try {
      const [stateResponse, readyResponse] = await Promise.all([
        fetch("/api/v1/state", { cache: "no-store", signal: controller.signal }),
        fetch("/readyz", { cache: "no-store", signal: controller.signal }),
      ]);
      if (!stateResponse.ok) throw new Error("state request failed");
      const nextState = (await stateResponse.json()) as DashboardState;
      setState(nextState);
      setReady(readyResponse.ok);
      setError(null);
    } catch (requestError) {
      if (!(requestError instanceof DOMException && requestError.name === "AbortError")) {
        setError(unavailableMessage);
        setReady(false);
      }
    } finally {
      if (activeController.current === controller) activeController.current = null;
    }
  }, []);

  useEffect(() => {
    void loadState();
    const timer = window.setInterval(() => void loadState(), 5_000);
    return () => {
      window.clearInterval(timer);
      activeController.current?.abort();
    };
  }, [loadState]);

  async function refreshNow() {
    setRefreshing(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/refresh", { method: "POST", headers: operationHeaders });
      if (!response.ok) throw new Error("refresh request failed");
      await loadState(true);
    } catch {
      setError(unavailableMessage);
    } finally {
      setRefreshing(false);
    }
  }

  async function retryBlockedIssue(issue: BlockedIssue) {
    setRetryingBlockedIssue(issue.issueId);
    setError(null);
    try {
      const response = await fetch(`/api/v1/${encodeURIComponent(issue.identifier)}/retry`, {
        method: "POST",
        headers: operationHeaders,
      });
      if (!response.ok) throw new Error("blocked retry request failed");
      await loadState(true);
    } catch {
      setError(actionFailedMessage);
    } finally {
      setRetryingBlockedIssue(null);
    }
  }

  async function toggleDispatch() {
    if (state === null) return;
    const paused = !state.dispatchPaused;
    setChangingDispatch(true);
    setError(null);
    try {
      const response = await fetch(paused ? "/api/v1/pause" : "/api/v1/resume", {
        method: "POST",
        headers: operationHeaders,
      });
      if (!response.ok) throw new Error("dispatch control request failed");
      await loadState(true);
    } catch {
      setError(actionFailedMessage);
    } finally {
      setChangingDispatch(false);
    }
  }

  return (
    <div className="shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">Symphony Node</p>
          <h1>Operations dashboard</h1>
          <p className="subtitle">A privacy-filtered view of the current orchestrator process.</p>
        </div>
        <div className="header-actions">
          <Readiness ready={ready} />
          <button
            type="button"
            onClick={() => void toggleDispatch()}
            disabled={state === null || changingDispatch || ready !== true}
            aria-busy={changingDispatch}
            title={state?.dispatchPaused === true
              ? "Resume dispatching new work and queue an immediate tracker poll"
              : "Pause dispatching new work; current runs continue"}
          >
            {changingDispatch
              ? state?.dispatchPaused === true ? "Resuming…" : "Pausing…"
              : state?.dispatchPaused === true ? "Resume new work" : "Pause new work"}
          </button>
          <button
            type="button"
            onClick={() => void refreshNow()}
            disabled={refreshing}
            aria-busy={refreshing}
            title="Queue an immediate tracker poll; eligible work may start"
          >
            {refreshing ? "Polling…" : "Poll tracker now"}
          </button>
        </div>
      </header>

      <div className="status-line">
        <span>Last poll: {formatDate(state?.lastPollAt ?? null)}</span>
        <span>Snapshot: {formatDate(state?.generatedAt ?? null)}</span>
        <span>Started: {formatDate(state?.startedAt ?? null)}</span>
      </div>

      {error !== null && <p className="error" role="alert">{error}</p>}
      {state === null ? (
        <main className="loading" aria-busy="true">Loading operational state…</main>
      ) : (
        <main>
          <section aria-labelledby="summary-heading">
            <h2 id="summary-heading">Current workload</h2>
            <div className="summary-grid">
              <Metric label="Running" value={formatNumber(state.counts.running)} tone="running" />
              <Metric label="Retrying" value={formatNumber(state.counts.retrying)} tone="retrying" />
              <Metric label="Blocked" value={formatNumber(state.counts.blocked)} tone="blocked" />
              <Metric label="Dispatch" value={formatDispatch(state.dispatchPaused, state.counts.running)} />
              <Metric label="Total tokens" value={formatNumber(state.totals.totalTokens)} />
              <Metric label="Estimated cost" value={formatCurrency(state.totals.costUsd)} />
              <Metric label="Claimed runtime" value={formatDuration(state.totals.secondsRunning)} />
              <Metric label="Model quota" value={formatRateLimit(state.rateLimit)} />
            </div>
          </section>

          <IssueSection title="Running" count={state.running.length} tone="running">
            {state.running.length === 0 ? <EmptyState>There are no running issues.</EmptyState> : (
              <div className="table-wrap">
                <table>
                  <caption className="visually-hidden">Running issues</caption>
                  <thead>
                    <tr>
                      <th scope="col">Issue</th>
                      <th scope="col">State</th>
                      <th scope="col">Attempt</th>
                      <th scope="col">Turns</th>
                      <th scope="col">Runtime</th>
                      <th scope="col">Usage</th>
                      <th scope="col">Last activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.running.map((issue) => (
                      <tr key={issue.issueId}>
                        <td><IssueReference identifier={issue.identifier} url={issue.issueUrl} /></td>
                        <td>
                          <span className="state-label">{issue.state}</span>
                          <span className="secondary">{humanize(issue.lastEvent)}</span>
                        </td>
                        <td>{issue.attempt ?? "—"}<span className="secondary">Continuation {issue.continuation}</span></td>
                        <td>{formatNumber(issue.turnCount)}</td>
                        <td>{formatDuration(issue.secondsRunning)}</td>
                        <td>{formatNumber(issue.usage.totalTokens)} tokens<span className="secondary">{formatCurrency(issue.usage.costUsd)}</span></td>
                        <td><Timestamp value={issue.lastActivityAt} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </IssueSection>

          <IssueSection title="Retrying" count={state.retrying.length} tone="retrying">
            {state.retrying.length === 0 ? <EmptyState>There are no scheduled retries.</EmptyState> : (
              <div className="table-wrap">
                <table>
                  <caption className="visually-hidden">Issues waiting to retry</caption>
                  <thead>
                    <tr>
                      <th scope="col">Issue</th>
                      <th scope="col">Reason</th>
                      <th scope="col">Attempt</th>
                      <th scope="col">Due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.retrying.map((issue) => (
                      <tr key={issue.issueId}>
                        <td><IssueReference identifier={issue.identifier} url={issue.issueUrl} /></td>
                        <td>{humanize(issue.reason)}</td>
                        <td>{issue.attempt}</td>
                        <td><Timestamp value={issue.dueAt} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </IssueSection>

          <IssueSection title="Blocked" count={state.blocked.length} tone="blocked">
            {state.blocked.length === 0 ? <EmptyState>There are no blocked issues.</EmptyState> : (
              <div className="table-wrap">
                <table>
                  <caption className="visually-hidden">Blocked issues</caption>
                  <thead>
                    <tr>
                      <th scope="col">Issue</th>
                      <th scope="col">Reason</th>
                      <th scope="col">Blocked since</th>
                      <th scope="col">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.blocked.map((issue) => (
                      <tr key={issue.issueId}>
                        <td><IssueReference identifier={issue.identifier} url={issue.issueUrl} /></td>
                        <td>{blockedReasonLabels[issue.reasonCode] ?? "Unknown"}</td>
                        <td><Timestamp value={issue.blockedAt} /></td>
                        <td>
                          <button
                            className="table-action"
                            type="button"
                            onClick={() => void retryBlockedIssue(issue)}
                            disabled={retryingBlockedIssue !== null || ready !== true}
                            aria-busy={retryingBlockedIssue === issue.issueId}
                            aria-label={`Retry blocked issue ${issue.identifier} once`}
                            title="Schedule one additional run; any configured retry label is consumed first"
                          >
                            {retryingBlockedIssue === issue.issueId ? "Retrying…" : "Retry once"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </IssueSection>

          <section className="panel totals" aria-labelledby="usage-heading">
            <h2 id="usage-heading">Cumulative usage</h2>
            <dl>
              <MetricDefinition label="Input tokens" value={formatNumber(state.totals.inputTokens)} />
              <MetricDefinition label="Output tokens" value={formatNumber(state.totals.outputTokens)} />
              <MetricDefinition label="Cache reads" value={formatNumber(state.totals.cacheReadInputTokens)} />
              <MetricDefinition label="Cache writes" value={formatNumber(state.totals.cacheCreationInputTokens)} />
            </dl>
          </section>
        </main>
      )}

      <footer>
        <a href="/assets/licenses.md">Third-party licenses</a>
      </footer>
    </div>
  );
}

function Readiness({ ready }: { ready: boolean | null }) {
  const label = ready === null ? "Checking readiness" : ready ? "Ready" : "Not ready";
  return <span className={`readiness ${ready === true ? "is-ready" : "is-waiting"}`} role="status" aria-live="polite"><span aria-hidden="true" />{label}</span>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className={`metric ${tone ?? ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

function IssueSection({ title, count, tone, children }: { title: string; count: number; tone: string; children: ReactNode }) {
  const headingId = `${tone}-heading`;
  return (
    <section className="panel" aria-labelledby={headingId}>
      <div className="panel-heading">
        <h2 id={headingId}>{title}</h2>
        <span className={`count ${tone}`} aria-label={`${count} ${title.toLowerCase()}`}>{formatNumber(count)}</span>
      </div>
      {children}
    </section>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

function IssueReference({ identifier, url }: { identifier: string; url: string | null }) {
  const safeUrl = httpUrl(url);
  return safeUrl === null ? <strong>{identifier}</strong> : (
    <a href={safeUrl} target="_blank" rel="noopener noreferrer">{identifier}<span className="visually-hidden"> (opens in a new tab)</span></a>
  );
}

function Timestamp({ value }: { value: string }) {
  return <time dateTime={value}>{formatDate(value)}</time>;
}

function MetricDefinition({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function httpUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function humanize(value: string | null): string {
  if (value === null || value.length === 0) return "No events yet";
  return value.replaceAll("_", " ").replace(/^./u, (first) => first.toUpperCase());
}

function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

function formatCurrency(value: number): string {
  return currencyFormatter.format(value);
}

function formatRateLimit(rateLimit: RateLimit | null): string {
  if (rateLimit === null) return "Unavailable";
  return [
    rateLimitStatusLabels[rateLimit.status],
    rateLimit.utilization === null ? null : `${Math.round(rateLimit.utilization * 100)}%`,
    rateLimit.rateLimitType === null ? null : rateLimitTypeLabels[rateLimit.rateLimitType],
  ].filter((part): part is string => part !== null).join(" · ");
}

function formatDispatch(paused: boolean, running: number): string {
  if (!paused) return "Active";
  return running > 0 ? "Draining" : "Paused";
}

function formatDate(value: string | null): string {
  if (value === null) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown" : dateFormatter.format(date);
}

function formatDuration(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3_600);
  const minutes = Math.floor((wholeSeconds % 3_600) / 60);
  const remainder = wholeSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

const root = document.getElementById("root");
if (root === null) throw new Error("Dashboard root element is missing");
createRoot(root).render(<App />);
