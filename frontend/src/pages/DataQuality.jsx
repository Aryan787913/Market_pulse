/**
 * Data Quality page: makes the pipeline visible inside the product.
 *
 * Three blocks:
 *   1. Freshness    — how far behind the warehouse is
 *   2. Check results — the latest batch's quality checks, failures first
 *   3. Run history  — recent ingestion runs with row counts and durations
 *
 * This page is the reason the pipeline writes to raw.ingestion_log and
 * raw.data_quality_log instead of only printing to the Airflow console: a
 * failed check is something the user of the dashboard should be able to see,
 * because it tells them whether to trust the numbers on the other pages.
 */

import { useCallback, useEffect, useState } from "react";

import { pipelineApi } from "../api/client";
import { EmptyState, ErrorState, Loading } from "../components/StateMessage";

/**
 * Severity is stored as a string by quality_checks.py and constrained to
 * ERROR/WARN by the CHECK on raw.data_quality_log, so the keys here must match
 * those exact values.
 */
const SEVERITY = {
  ERROR: { label: "Error", className: "sev sev-critical" },
  WARN: { label: "Warning", className: "sev sev-warning" },
};

export default function DataQuality() {
  const [runs, setRuns] = useState([]);
  const [checks, setChecks] = useState([]);
  const [summary, setSummary] = useState(null);
  const [freshness, setFreshness] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const [runsRes, qualityRes, freshnessRes] = await Promise.all([
        pipelineApi.runs(10),
        pipelineApi.quality(),
        pipelineApi.freshness(),
      ]);
      setRuns(runsRes.data);
      setChecks(qualityRes.data);
      setSummary(qualityRes.summary);
      setFreshness(freshnessRes.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Loading label="Loading pipeline status…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Pipeline &amp; Data Quality</h1>
        <button type="button" className="btn btn-secondary" onClick={load}>
          Refresh
        </button>
      </div>

      <section className="metric-grid">
        <StatCard
          label="Latest trade date"
          value={
            freshness?.latest_trade_date
              ? new Date(freshness.latest_trade_date).toLocaleDateString("en-IN")
              : "—"
          }
        />
        <StatCard
          label="Days behind"
          value={String(freshness?.days_behind ?? "—")}
          tone={freshness?.isStale ? "bad" : "good"}
        />
        <StatCard label="Stocks covered" value={String(freshness?.stocks_covered ?? "—")} />
        <StatCard label="Price rows" value={Number(freshness?.total_price_rows || 0).toLocaleString("en-IN")} />
        <StatCard
          label="Checks passed"
          value={summary ? `${summary.passed}/${summary.total}` : "—"}
          tone={summary && summary.failed > 0 ? "bad" : "good"}
        />
        <StatCard label="Checks failed" value={String(summary?.failed ?? "—")} tone={summary?.failed ? "bad" : "good"} />
      </section>

      <section className="card">
        <h2 className="card-title">Latest Quality Checks</h2>

        {checks.length === 0 ? (
          <EmptyState
            message="No quality checks recorded yet."
            hint="Trigger the marketpulse_daily DAG in Airflow to populate this."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Result</th>
                  <th scope="col">Check</th>
                  <th scope="col">Target</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Failed rows</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((check) => (
                  <tr key={check.check_id} className={check.passed ? "" : "row-flagged"}>
                    <td>
                      <span className={check.passed ? "badge badge-up" : "badge badge-down"}>
                        {check.passed ? "PASS" : "FAIL"}
                      </span>
                    </td>
                    <td>{check.check_name}</td>
                    <td className="mono">{check.check_target || "—"}</td>
                    <td>
                      <span className={SEVERITY[check.severity]?.className || "sev"}>
                        {SEVERITY[check.severity]?.label || check.severity}
                      </span>
                    </td>
                    <td>{check.failed_records}</td>
                    <td className="cell-details">{check.details || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">Recent Ingestion Runs</h2>

        {runs.length === 0 ? (
          <EmptyState message="The pipeline has not run yet." />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">Status</th>
                  <th scope="col">Symbols</th>
                  <th scope="col">Failed</th>
                  <th scope="col">Rows inserted</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Message</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.log_id}>
                    <td>{new Date(run.run_started_at).toLocaleString("en-IN")}</td>
                    <td>
                      <span className={statusClass(run.status)}>{run.status}</span>
                    </td>
                    <td>
                      {run.symbols_ok}/{run.symbols_total}
                    </td>
                    <td>{run.symbols_failed}</td>
                    <td>{Number(run.rows_inserted || 0).toLocaleString("en-IN")}</td>
                    <td>{run.duration_seconds === null ? "—" : `${run.duration_seconds}s`}</td>
                    <td className="cell-details">{run.message || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** SUCCESS is green, PARTIAL amber, anything else red. */
function statusClass(status) {
  if (status === "SUCCESS") return "badge badge-up";
  if (status === "PARTIAL") return "badge badge-warn";
  return "badge badge-down";
}

function StatCard({ label, value, tone }) {
  const toneClass = tone === "good" ? "metric-good" : tone === "bad" ? "metric-bad" : "";
  return (
    <div className={`metric-card ${toneClass}`}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
    </div>
  );
}
