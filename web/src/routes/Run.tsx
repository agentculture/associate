import { useCallback, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { RUN_ID, showRun } from "../api/runs";
import type { RunDetail, TestsDetail } from "../api/types";
import Problem from "../components/Problem";
import StatusPill from "../components/StatusPill";
import { useLoad } from "../hooks/useLoad";
import { usePolling } from "../hooks/usePolling";
import { useTitle } from "../hooks/useTitle";
import { firstLine, pathsNote, pillFor, testResultWords, testsSummary, timing } from "../model/runs";

/**
 * One run (artboard "associate: One run"), from `GET /runs/{run_id}`. Read-only. Everything
 * shown is a field of that reply: the per-command test results are the stored argv and exit
 * code (never the output), the agent's words are its one final reply as paragraphs.
 */

function Section({
  id,
  title,
  children,
  tone,
}: {
  id: string;
  title: string;
  children: ReactNode;
  tone?: "alert";
}) {
  return (
    <section
      className={`panel${tone === "alert" ? " panel--alert" : ""}`}
      aria-labelledby={`${id}-title`}
    >
      <h2 className={tone === "alert" ? "panel__title" : "eyebrow-heading"} id={`${id}-title`}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function WhyNotMerged({ run }: { run: RunDetail }) {
  return (
    <Section id="why" title="Why it was not merged" tone="alert">
      {run.not_ok_because ? <p>Not ok because {run.not_ok_because}.</p> : null}
      {run.merge_reason ? (
        <p>
          The run's own reason: <span className="quote">{run.merge_reason}</span>
        </p>
      ) : null}
      {run.error ? <p>The run said: {run.error}</p> : null}
      {run.run_branch ? (
        <p>
          The work is kept on the branch <code>{run.run_branch}</code>
          {run.worktree ? (
            <>
              {" "}
              in <code>{run.worktree}</code>
            </>
          ) : null}
          .
        </p>
      ) : null}
      {run.details_dropped ? (
        <p className="muted small">Some details were left out to keep the answer small.</p>
      ) : null}
    </Section>
  );
}

function NoResult({ run }: { run: RunDetail }) {
  return (
    <Section id="noresult" title="Why there is no result" tone="alert">
      <p>{run.error ?? "The API gave no reason."}</p>
    </Section>
  );
}

function Tests({ tests }: { tests: TestsDetail | null | undefined }) {
  return (
    <Section id="tests" title="Tests">
      <p className={tests?.passed === true ? "" : "warn-text"}>{testsSummary(tests)}</p>
      {tests?.results?.length ? (
        <ul className="tiles">
          {tests.results.map((result, i) => {
            const words = testResultWords(result);
            return (
              <li key={`${i}-${result.command}`} className="tile tile--split">
                <code>{result.command}</code>
                <span className={`pill pill--${words.ok ? "good" : "bad"}`}>{words.text}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {tests?.results === null ? (
        <p className="muted small">Each command's result was left out to keep the answer small.</p>
      ) : null}
      {tests?.results && tests.results_truncated ? (
        <p className="muted small">Some commands are shortened or left out to keep the answer small.</p>
      ) : null}
      {tests?.error ? <p className="warn-text">{tests.error}</p> : null}
    </Section>
  );
}

function ChangedPaths({ run }: { run: RunDetail }) {
  const paths = run.changed_paths ?? [];
  return (
    <Section id="paths" title="Changed paths">
      {paths.length ? (
        <ul className="tiles">
          {paths.map((path, i) => (
            <li key={`${i}-${path}`} className="tile">
              <code>{path}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {run.changed_paths_error ? <p className="warn-text">{run.changed_paths_error}</p> : null}
      <p className="muted small">
        {pathsNote(run.changed_paths_total ?? paths.length, paths.length, !!run.changed_paths_truncated)}
      </p>
    </Section>
  );
}

function Reply({ run }: { run: RunDetail }) {
  const paragraphs = (run.final_reply ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <Section id="reply" title="What the agent said">
      {paragraphs.length ? (
        <div className="reply">
          {paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      ) : (
        <p className="muted">
          {run.final_reply_dropped
            ? "The reply was left out to keep the answer small."
            : "The agent left no final reply."}
        </p>
      )}
      <p className="muted small">
        The agent's own words, shortened when long. They are not checked: the tests above are.
      </p>
    </Section>
  );
}

function RunView({ run }: { run: RunDetail }) {
  const title = firstLine(run.instruction) ?? `Run ${run.run_id}`;
  useTitle(title);
  const finished = run.status === "finished";
  const commit = run.base_commit ?? null;
  return (
    <>
      <div className="run-head" data-testid="run-head">
        <Link to="/runs" className="back-link">
          All runs
        </Link>
        <div className="run-head__status">
          <StatusPill pill={pillFor(run)} large />
          <span className="muted small">
            {timing(run, new Date())}. Model: {run.model ?? "unknown"}.
          </span>
        </div>
        <h1 className="page__title run-head__title">{title}</h1>
        <p className="muted">
          <span className="path">{run.checkout ?? "unknown checkout"}</span>
          {commit ? (
            <>
              , from commit <code title={commit}>{commit.slice(0, 7)}</code>
            </>
          ) : null}
        </p>
      </div>

      {finished && !run.ok ? <WhyNotMerged run={run} /> : null}
      {run.status === "lost" || run.status === "failed-to-start" ? <NoResult run={run} /> : null}
      {run.status === "running" ? (
        <p className="notice" role="status">
          The result appears here when the run finishes; this page reads it again every few
          seconds.
        </p>
      ) : null}

      {finished ? (
        <div className="grid-2">
          <Tests tests={run.tests} />
          <ChangedPaths run={run} />
        </div>
      ) : null}
      {run.status === "running" ? (
        <Section id="tests" title="Tests">
          <p>
            {run.test_command_count === 1
              ? "1 test command runs after the agent finishes."
              : `${run.test_command_count} test commands run after the agent finishes.`}
          </p>
        </Section>
      ) : null}

      <Section id="instruction" title="Instruction">
        <p className="prose">{run.instruction ?? "The run's request holds no instruction text."}</p>
        {run.instruction_truncated ? (
          <p className="muted small">The instruction is shortened here.</p>
        ) : null}
      </Section>

      {finished ? <Reply run={run} /> : null}
    </>
  );
}

function NotFound({ message }: { message: string }) {
  useTitle("No such run");
  return (
    <div className="run-head">
      <Link to="/runs" className="back-link">
        All runs
      </Link>
      <h1 className="page__title">No such run</h1>
      <p className="muted">{message}</p>
    </div>
  );
}

function Loaded({ runId }: { runId: string }) {
  const load = useCallback((signal: AbortSignal) => showRun(runId, signal), [runId]);
  const { state, reload, refresh } = useLoad(load, runId);
  usePolling(state.status === "ok" && state.data.status === "running", refresh);

  if (state.status === "loading") {
    return (
      <p role="status" className="muted">
        Loading the run…
      </p>
    );
  }
  if (state.status === "error") {
    if (state.error.status === 404 || state.error.code === "invalid") {
      return <NotFound message={state.error.message} />;
    }
    return (
      <>
        <Link to="/runs" className="back-link">
          All runs
        </Link>
        <Problem error={state.error} onRetry={reload} />
      </>
    );
  }
  return <RunView run={state.data} />;
}

export function Run() {
  const { runId = "" } = useParams();
  return (
    <div className="screen">
      {RUN_ID.test(runId) ? (
        <Loaded runId={runId} />
      ) : (
        <NotFound message="A run id is 'run-' followed by 32 lowercase hex digits; this one is not." />
      )}
    </div>
  );
}

export default Run;
