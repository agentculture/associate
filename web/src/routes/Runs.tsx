import { useState } from "react";
import { Link } from "react-router-dom";
import type { RunCard } from "../api/types";
import Problem from "../components/Problem";
import StatusPill from "../components/StatusPill";
import { useRunsList } from "../hooks/useRunsList";
import { useTitle } from "../hooks/useTitle";
import { needsLook, outcomeItems, pillFor, repoName, timing } from "../model/runs";

/**
 * The Runs screen (artboard "associate: Runs"): the heading and its paragraph, the filter and
 * one card per run from `GET /runs`. Read-only: runs are started by a workflow or the CLI.
 */
export const FILTERS = [
  { key: "all", label: "All", keep: () => true, empty: "No runs yet." },
  {
    key: "running",
    label: "In progress",
    keep: (r: RunCard) => r.status === "running",
    empty: "No run is in progress.",
  },
  { key: "look", label: "Needs a look", keep: needsLook, empty: "Nothing needs a look." },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

function Card({ run, now }: { run: RunCard; now: Date }) {
  const pill = pillFor(run);
  const id = run.run_id;
  return (
    <li>
      <Link
        to={`/runs/${id}`}
        className={`run-card${run.status === "running" ? " run-card--running" : ""}`}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-top ${id}-facts`}
      >
        <div className="run-card__top" id={`${id}-top`}>
          <div className="run-card__status">
            <StatusPill pill={pill} />
            <span className="muted small">{timing(run, now)}</span>
          </div>
          <span className="muted small">Model: {run.model ?? "unknown"}</span>
        </div>
        <h2 className="run-card__title" id={`${id}-title`}>
          {run.title ?? `Run ${id}`}
        </h2>
        <div className="run-card__facts small" id={`${id}-facts`}>
          <span className="muted" title={run.checkout ?? undefined}>
            {repoName(run.checkout)}
          </span>
          {outcomeItems(run).map((item) => (
            <span key={item.text} className={item.warn ? "warn-text" : "muted"}>
              {item.text}
            </span>
          ))}
        </div>
      </Link>
    </li>
  );
}

function Empty() {
  return (
    <section className="panel empty" aria-labelledby="empty-title">
      <h2 className="panel__title" id="empty-title">
        No runs yet
      </h2>
      <p>
        A run is started by a workflow (an HTTP <code>POST /runs</code> with an admin token) or
        from the command line:
      </p>
      <pre className="command">
        <code>
          associate runs start --checkout PATH --model worker --test-command "CMD" -- "INSTRUCTION"
        </code>
      </pre>
      <p className="muted small">It appears here within half a minute of starting.</p>
    </section>
  );
}

export function Runs() {
  useTitle("Runs");
  const { state, reload } = useRunsList();
  const [filter, setFilter] = useState<FilterKey>("all");
  const now = new Date();
  const chosen = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];

  let body;
  if (state.status === "loading") {
    body = (
      <p role="status" className="muted">
        Loading runs…
      </p>
    );
  } else if (state.status === "error") {
    body = <Problem error={state.error} onRetry={reload} />;
  } else if (state.data.runs.length === 0) {
    body = <Empty />;
  } else {
    const shown = state.data.runs.filter((r) => chosen.keep(r));
    body = (
      <>
        {shown.length ? (
          <ul className="run-list" aria-label="Runs">
            {shown.map((run) => (
              <Card key={run.run_id} run={run} now={now} />
            ))}
          </ul>
        ) : (
          <p className="panel empty-filter">{chosen.empty}</p>
        )}
        {state.data.total > state.data.runs.length ? (
          <p className="muted small">
            Showing {state.data.runs.length} of {state.data.total} runs, the most recent first.
          </p>
        ) : null}
      </>
    );
  }

  return (
    <div className="screen">
      <div className="screen__intro">
        <h1 className="page__title">Runs</h1>
        <p className="page__lede">
          Each run is one instruction carried out in one checkout. A run merges into the
          checkout's local main only when it finished cleanly and its tests passed. Nothing is
          pushed.
        </p>
      </div>
      {state.status === "ok" && state.data.runs.length > 0 ? (
        <div className="filter" role="group" aria-label="Show">
          <span className="muted small" aria-hidden="true">
            Show
          </span>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className="filter__button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      ) : null}
      {body}
      <p className="muted small">
        Runs are started by a workflow or from the command line. This page only shows them.
      </p>
    </div>
  );
}

export default Runs;
