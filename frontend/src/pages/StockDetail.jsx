/**
 * Single-stock page: profile, latest metrics, and a price chart.
 *
 * The chart plots close alongside the 7-day and 30-day moving averages, which is
 * the point of computing them in the warehouse: the crossover between a short
 * and a long average is the classic trend signal, and it is only readable when
 * all three lines share an axis.
 *
 * The range selector (30 / 90 / 180 / 365 days) re-queries the API rather than
 * slicing data already in memory, so the browser never holds more rows than the
 * chart is showing.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { stocksApi, watchlistApi } from "../api/client";
import { EmptyState, ErrorState, Loading, Price, ReturnBadge } from "../components/StateMessage";

const RANGES = [30, 90, 180, 365];

export default function StockDetail() {
  const { symbol } = useParams();

  const [stock, setStock] = useState(null);
  const [history, setHistory] = useState([]);
  const [days, setDays] = useState(90);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const [detailRes, historyRes] = await Promise.all([
        stocksApi.detail(symbol),
        stocksApi.history(symbol, days),
      ]);
      setStock(detailRes.data);
      setHistory(historyRes.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [symbol, days]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAddToWatchlist() {
    setNotice("");
    try {
      const result = await watchlistApi.add(symbol);
      setNotice(result.message);
    } catch (err) {
      setNotice(err.message);
    }
  }

  if (loading) return <Loading label={`Loading ${symbol}…`} />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!stock) return <EmptyState message="Stock not found." />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <Link className="back-link" to="/">
            ← Back to dashboard
          </Link>
          <h1 className="page-title">
            {stock.symbol}
            <span className="page-subtitle"> · {stock.company_name}</span>
          </h1>
          <p className="page-meta">
            {stock.sector || "Unclassified"} · {stock.exchange || "—"}
          </p>
        </div>

        <button type="button" className="btn btn-primary" onClick={handleAddToWatchlist}>
          Add to watchlist
        </button>
      </div>

      {notice && (
        <div className="alert alert-info" role="status">
          {notice}
        </div>
      )}

      {/* Latest snapshot. */}
      <section className="metric-grid">
        <MetricCard label="Close" value={<Price value={stock.close} />} />
        <MetricCard label="Daily return" value={<ReturnBadge value={stock.daily_return} />} />
        <MetricCard label="7-day average" value={<Price value={stock.moving_avg_7d} />} />
        <MetricCard label="30-day average" value={<Price value={stock.moving_avg_30d} />} />
        <MetricCard
          label="7-day volatility"
          value={
            stock.volatility_7d === null || stock.volatility_7d === undefined
              ? "—"
              : `${Number(stock.volatility_7d).toFixed(2)}%`
          }
        />
        <MetricCard
          label="As of"
          value={
            stock.latest_date ? new Date(stock.latest_date).toLocaleDateString("en-IN") : "—"
          }
        />
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Price and Moving Averages</h2>

          <div className="range-picker" role="group" aria-label="Chart range">
            {RANGES.map((range) => (
              <button
                key={range}
                type="button"
                className={range === days ? "btn btn-chip active" : "btn btn-chip"}
                onClick={() => setDays(range)}
              >
                {range}d
              </button>
            ))}
          </div>
        </div>

        {history.length === 0 ? (
          <EmptyState
            message="No price history for this range."
            hint="The pipeline may not have backfilled this far yet."
          />
        ) : (
          <ResponsiveContainer width="100%" height={360}>
            <LineChart data={history} margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis
                dataKey="trade_date"
                tick={{ fontSize: 12 }}
                // Full ISO dates would overlap, so show a short day/month label.
                tickFormatter={(value) =>
                  new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
                }
                minTickGap={24}
              />
              <YAxis
                tick={{ fontSize: 12 }}
                // Prices sit far from zero, so let the axis fit the data instead.
                domain={["auto", "auto"]}
                tickFormatter={(value) => `₹${value}`}
              />
              <Tooltip
                formatter={(value, name) => [
                  value === null ? "—" : `₹${Number(value).toFixed(2)}`,
                  name,
                ]}
                labelFormatter={(label) => new Date(label).toLocaleDateString("en-IN")}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="close"
                name="Close"
                stroke="#2563eb"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="moving_avg_7d"
                name="7-day MA"
                stroke="#f59e0b"
                strokeWidth={1.5}
                dot={false}
                // connectNulls bridges the first few days where the window is
                // not yet full and the average is NULL.
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="moving_avg_30d"
                name="30-day MA"
                stroke="#7c3aed"
                strokeWidth={1.5}
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </section>
    </div>
  );
}

function MetricCard({ label, value }) {
  return (
    <div className="metric-card">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
    </div>
  );
}
