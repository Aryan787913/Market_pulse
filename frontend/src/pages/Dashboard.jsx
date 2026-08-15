/**
 * Dashboard: the landing page after login.
 *
 * Layout, top to bottom:
 *   1. Freshness banner  — how current the warehouse is
 *   2. Movers            — biggest gainers and losers on the latest trading day
 *   3. Sector chart      — average return per sector
 *   4. Stock table       — every tracked stock, filterable and sortable
 *
 * All four calls are fired in parallel with Promise.all rather than one after
 * another, so total load time is the slowest request instead of the sum of all
 * of them.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { pipelineApi, stocksApi } from "../api/client";
import { EmptyState, ErrorState, Loading, Price, ReturnBadge } from "../components/StateMessage";

export default function Dashboard() {
  const [stocks, setStocks] = useState([]);
  const [movers, setMovers] = useState({ gainers: [], losers: [], latestDate: null });
  const [sectors, setSectors] = useState([]);
  const [freshness, setFreshness] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Table controls.
  const [sectorFilter, setSectorFilter] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState({ by: "symbol", order: "asc" });

  // useCallback keeps this function identity stable so the effect below does not
  // re-run on every render.
  const load = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const [stocksRes, moversRes, sectorsRes, freshnessRes] = await Promise.all([
        stocksApi.list({ sortBy: sort.by, order: sort.order, sector: sectorFilter || undefined }),
        stocksApi.movers(5),
        stocksApi.sectors(),
        pipelineApi.freshness(),
      ]);

      setStocks(stocksRes.data);
      setMovers(moversRes);
      setSectors(sectorsRes.data);
      setFreshness(freshnessRes.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [sort.by, sort.order, sectorFilter]);

  useEffect(() => {
    load();
  }, [load]);

  // Sector list for the dropdown, derived from the data instead of hardcoded.
  const sectorOptions = useMemo(
    () => [...new Set(stocks.map((s) => s.sector).filter(Boolean))].sort(),
    [stocks]
  );

  // Search filters on the client because the dataset is small (tens of rows).
  // Sorting stays on the server because it needs the full set to be correct.
  const visibleStocks = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return stocks;
    return stocks.filter(
      (s) =>
        s.symbol.toLowerCase().includes(needle) ||
        (s.company_name || "").toLowerCase().includes(needle)
    );
  }, [stocks, search]);

  /** Clicking a column header sorts by it, or flips direction if already sorted. */
  function toggleSort(column) {
    setSort((previous) =>
      previous.by === column
        ? { by: column, order: previous.order === "asc" ? "desc" : "asc" }
        : { by: column, order: "asc" }
    );
  }

  if (loading) return <Loading label="Loading market data…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Market Dashboard</h1>
        {movers.latestDate && (
          <span className="page-subtitle">
            Latest trading day: {new Date(movers.latestDate).toLocaleDateString("en-IN")}
          </span>
        )}
      </div>

      {/* A stale pipeline is called out rather than silently serving old data. */}
      {freshness?.isStale && (
        <div className="alert alert-warning" role="status">
          Data may be stale — the warehouse is {String(freshness.days_behind ?? "?")} day(s) behind.
          Check the Airflow DAG.
        </div>
      )}

      <section className="grid-2">
        <MoverCard title="Top Gainers" rows={movers.gainers} tone="up" />
        <MoverCard title="Top Losers" rows={movers.losers} tone="down" />
      </section>

      <section className="card">
        <h2 className="card-title">Average Daily Return by Sector</h2>
        {sectors.length === 0 ? (
          <EmptyState message="No sector data yet." />
        ) : (
          // ResponsiveContainer makes the chart follow its parent's width.
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={sectors} margin={{ top: 8, right: 16, bottom: 40, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="sector" angle={-30} textAnchor="end" height={60} tick={{ fontSize: 12 }} />
              <YAxis unit="%" tick={{ fontSize: 12 }} />
              <Tooltip formatter={(value) => `${Number(value).toFixed(2)}%`} />
              <Bar dataKey="avg_daily_return" radius={[4, 4, 0, 0]}>
                {/* Per-bar colour: green for gains, red for losses. */}
                {sectors.map((row) => (
                  <Cell
                    key={row.sector}
                    fill={Number(row.avg_daily_return) >= 0 ? "#16a34a" : "#dc2626"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">All Tracked Stocks</h2>

          <div className="controls">
            <input
              className="field-input control-input"
              type="search"
              placeholder="Search symbol or company…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search stocks"
            />
            <select
              className="field-input control-input"
              value={sectorFilter}
              onChange={(event) => setSectorFilter(event.target.value)}
              aria-label="Filter by sector"
            >
              <option value="">All sectors</option>
              {sectorOptions.map((sector) => (
                <option key={sector} value={sector}>
                  {sector}
                </option>
              ))}
            </select>
          </div>
        </div>

        {visibleStocks.length === 0 ? (
          <EmptyState
            message="No stocks match your filters."
            hint="Clear the search box or pick a different sector."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableHeader label="Symbol" column="symbol" sort={sort} onSort={toggleSort} />
                  <SortableHeader label="Company" column="company" sort={sort} onSort={toggleSort} />
                  <SortableHeader label="Sector" column="sector" sort={sort} onSort={toggleSort} />
                  <SortableHeader label="Close" column="close" sort={sort} onSort={toggleSort} />
                  <SortableHeader label="Change" column="return" sort={sort} onSort={toggleSort} />
                  <th scope="col">7d MA</th>
                  <th scope="col">30d MA</th>
                  <th scope="col">Volatility</th>
                </tr>
              </thead>
              <tbody>
                {visibleStocks.map((stock) => (
                  <tr key={stock.stock_id}>
                    <td>
                      <Link className="link-strong" to={`/stocks/${stock.symbol}`}>
                        {stock.symbol}
                      </Link>
                    </td>
                    <td>{stock.company_name}</td>
                    <td>{stock.sector || "—"}</td>
                    <td>
                      <Price value={stock.close} />
                    </td>
                    <td>
                      <ReturnBadge value={stock.daily_return} />
                    </td>
                    <td>
                      <Price value={stock.moving_avg_7d} />
                    </td>
                    <td>
                      <Price value={stock.moving_avg_30d} />
                    </td>
                    <td>
                      {stock.volatility_7d === null || stock.volatility_7d === undefined
                        ? "—"
                        : `${Number(stock.volatility_7d).toFixed(2)}%`}
                    </td>
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

/** Clickable table header with an arrow showing the current sort. */
function SortableHeader({ label, column, sort, onSort }) {
  const isActive = sort.by === column;

  return (
    <th scope="col">
      <button type="button" className="th-button" onClick={() => onSort(column)}>
        {label}
        <span className="sort-arrow" aria-hidden="true">
          {isActive ? (sort.order === "asc" ? "▲" : "▼") : ""}
        </span>
      </button>
    </th>
  );
}

/** Compact gainers/losers list. */
function MoverCard({ title, rows, tone }) {
  return (
    <div className={`card mover-card mover-${tone}`}>
      <h2 className="card-title">{title}</h2>

      {rows.length === 0 ? (
        <EmptyState message="No data for the latest trading day." />
      ) : (
        <ul className="mover-list">
          {rows.map((row) => (
            <li key={row.symbol} className="mover-item">
              <Link className="link-strong" to={`/stocks/${row.symbol}`}>
                {row.symbol}
              </Link>
              <span className="mover-name">{row.company_name}</span>
              <Price value={row.close} />
              <ReturnBadge value={row.daily_return} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
