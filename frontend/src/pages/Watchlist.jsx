/**
 * Watchlist page: the user's own list of stocks.
 *
 * Adding and removing both re-fetch the list afterwards rather than patching
 * local state by hand. It costs one extra request but guarantees the table
 * matches the database, which matters here because the API can silently no-op on
 * a duplicate add.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { stocksApi, watchlistApi } from "../api/client";
import { EmptyState, ErrorState, Loading, Price, ReturnBadge } from "../components/StateMessage";

export default function Watchlist() {
  const [rows, setRows] = useState([]);
  const [allSymbols, setAllSymbols] = useState([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      // The dropdown needs the full stock list, so both are fetched together.
      const [watchlistRes, stocksRes] = await Promise.all([
        watchlistApi.list(),
        stocksApi.list(),
      ]);
      setRows(watchlistRes.data);
      setAllSymbols(stocksRes.data.map((s) => ({ symbol: s.symbol, name: s.company_name })));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAdd(event) {
    event.preventDefault();
    if (!selected) return;

    setBusy(true);
    setNotice("");
    try {
      const result = await watchlistApi.add(selected);
      setNotice(result.message);
      setSelected("");
      await load();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(symbol) {
    setBusy(true);
    setNotice("");
    try {
      await watchlistApi.remove(symbol);
      setNotice(`${symbol} removed from your watchlist.`);
      await load();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading label="Loading your watchlist…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  // Stocks already on the list are excluded from the dropdown.
  const watched = new Set(rows.map((r) => r.symbol));
  const addable = allSymbols.filter((s) => !watched.has(s.symbol));

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">My Watchlist</h1>
        <span className="page-subtitle">
          {rows.length} stock{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      {notice && (
        <div className="alert alert-info" role="status">
          {notice}
        </div>
      )}

      <form className="card add-form" onSubmit={handleAdd}>
        <label className="field field-inline">
          <span className="field-label">Add a stock</span>
          <select
            className="field-input"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Choose a symbol…</option>
            {addable.map((stock) => (
              <option key={stock.symbol} value={stock.symbol}>
                {stock.symbol} — {stock.name}
              </option>
            ))}
          </select>
        </label>

        <button type="submit" className="btn btn-primary" disabled={!selected || busy}>
          {busy ? "Working…" : "Add"}
        </button>
      </form>

      {rows.length === 0 ? (
        <EmptyState
          message="Your watchlist is empty."
          hint="Add a stock above, or open any stock from the dashboard and use 'Add to watchlist'."
        />
      ) : (
        <div className="card">
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Symbol</th>
                  <th scope="col">Company</th>
                  <th scope="col">Sector</th>
                  <th scope="col">Close</th>
                  <th scope="col">Change</th>
                  <th scope="col">7d MA</th>
                  <th scope="col">Added</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.watchlist_id}>
                    <td>
                      <Link className="link-strong" to={`/stocks/${row.symbol}`}>
                        {row.symbol}
                      </Link>
                    </td>
                    <td>{row.company_name}</td>
                    <td>{row.sector || "—"}</td>
                    <td>
                      <Price value={row.close} />
                    </td>
                    <td>
                      <ReturnBadge value={row.daily_return} />
                    </td>
                    <td>
                      <Price value={row.moving_avg_7d} />
                    </td>
                    <td>{new Date(row.added_on).toLocaleDateString("en-IN")}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-danger btn-small"
                        onClick={() => handleRemove(row.symbol)}
                        disabled={busy}
                        aria-label={`Remove ${row.symbol} from watchlist`}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
