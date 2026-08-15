/**
 * Small presentational helpers reused by every page.
 *
 * Every data page has the same three non-happy states — loading, failed, and
 * loaded-but-empty. Keeping them here means each page handles them in one line
 * instead of repeating the same markup, and they look identical throughout the
 * app.
 */

/** Centred spinner with an accessible label. */
export function Loading({ label = "Loading data…" }) {
  return (
    <div className="state-block">
      <div className="spinner" role="status" aria-label={label} />
      <p className="state-text">{label}</p>
    </div>
  );
}

/**
 * Error state. onRetry is optional: when provided, the user gets a button
 * instead of a dead end.
 */
export function ErrorState({ message, onRetry }) {
  return (
    <div className="state-block state-error" role="alert">
      <p className="state-text">{message || "Something went wrong."}</p>
      {onRetry && (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** Empty state, e.g. an empty watchlist or a pipeline that has never run. */
export function EmptyState({ message = "Nothing to show yet.", hint }) {
  return (
    <div className="state-block">
      <p className="state-text">{message}</p>
      {hint && <p className="state-hint">{hint}</p>}
    </div>
  );
}

/**
 * Formats a number as a signed percentage and colours it green or red.
 * Returns a neutral dash when the value is missing, which happens for a stock's
 * very first trading day (no previous close to compare against).
 */
export function ReturnBadge({ value }) {
  if (value === null || value === undefined) {
    return <span className="badge badge-neutral">—</span>;
  }

  const numeric = Number(value);
  const className = numeric >= 0 ? "badge badge-up" : "badge badge-down";
  const sign = numeric >= 0 ? "+" : "";

  return (
    <span className={className}>
      {sign}
      {numeric.toFixed(2)}%
    </span>
  );
}

/** Rupee-formatted price, or a dash when there is no data. */
export function Price({ value }) {
  if (value === null || value === undefined) return <span>—</span>;
  return <span>₹{Number(value).toFixed(2)}</span>;
}
