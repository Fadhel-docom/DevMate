import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { getBrowserStorage } from "./storage";
import { STORAGE_KEY } from "./storage";
import { readPreservedSource, type CutoverState } from "./cutoverState";
import { browserDownload, prepareArchiveExport, summarizeArchive, type ExportFile } from "./archiveExport";

const box: CSSProperties = { margin: "16px 0 0", padding: "14px", border: "1px solid #c9d3e6", background: "#f4f7fd", color: "#15233f", borderRadius: 12, fontSize: 14, lineHeight: 1.5 };
const alertBox: CSSProperties = { ...box, border: "1px solid #f1b5b5", background: "#fff1f1", color: "#7a1f1f" };
const MAX_LISTED_TASKS = 500;

type ReadStorage = Pick<Storage, "getItem">;
type Source = { id: "preserved" | "current"; title: string; raw: string | null; note: string };
type Loaded = { sources: Source[]; problems: string[] };

/** Reads only. Never calls setItem/removeItem. */
export function loadArchiveSources(storage: ReadStorage | null): Loaded {
  const sources: Source[] = []; const problems: string[] = [];
  if (!storage) return { sources, problems: ["Browser storage is unavailable, so no archive can be shown."] };
  const preserved = readPreservedSource(storage);
  if (preserved.ok) sources.push({ id: "preserved", title: "Preserved legacy copy", raw: preserved.raw, note: "The exact copy kept when the cutover was declared." });
  else problems.push(`The preserved legacy copy cannot be read (${preserved.reason}): ${preserved.message}`);
  try {
    const current = storage.getItem(STORAGE_KEY);
    if (!preserved.ok || current !== preserved.raw) sources.push({ id: "current", title: "Current legacy workspace", raw: current, note: preserved.ok ? "This differs from the preserved copy; it may have been changed by another tab or an older version of the app." : "Read directly from the legacy storage key." });
  } catch (error) { problems.push(`The current legacy workspace cannot be read: ${error instanceof Error ? error.message : String(error)}`); }
  return { sources, problems };
}

export function archiveHeading(state: CutoverState): { title: string; body: string; next: string; tone: "status" | "alert" } | null {
  switch (state.mode) {
    case "legacy": return null;
    case "recovery": return { tone: "status", title: "Recovery: cutover not finished",
      body: `A storage cutover was declared and stopped at phase "${state.phase}". Editing is disabled on purpose. Your legacy workspace was preserved byte for byte and nothing has been deleted or migrated away.`,
      next: "You can safely look at your legacy tasks below and download the raw data. This version cannot finish, undo or delete the cutover; keep the downloaded file until the owner has confirmed recovery." };
    case "durable": return { tone: "status", title: "Durable mode recorded; legacy data is an archive",
      body: "A completed cutover is recorded in this browser. This version has no durable workspace screen, so durable data cannot be shown here. The legacy workspace is kept as a read-only archive.",
      next: "You can look at the legacy archive and download the raw data. Legacy tasks are not governed or executable and nothing here can edit, restore or delete them." };
    case "indeterminate": return { tone: "alert", title: "Storage state cannot be verified",
      body: `The cutover state could not be verified (${state.reason}). ${state.message} All writes are blocked and nothing was changed.`,
      next: "Download the raw data below before doing anything else. Do not edit or clear browser data until the owner has inspected the stored state." };
  }
}

export default function RecoveryArchive({ state, storage, download = browserDownload }: { state: CutoverState; storage?: ReadStorage | null; download?: (file: ExportFile) => void }) {
  const heading = archiveHeading(state);
  const loaded = useMemo<Loaded>(() => (heading ? loadArchiveSources(storage === undefined ? getBrowserStorage() : storage) : { sources: [], problems: [] }), [state, storage, heading !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const [status, setStatus] = useState("");
  const [failure, setFailure] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  if (!heading) return null;
  function doDownload(source: Source) {
    setFailure(""); setStatus("");
    if (source.raw === null) { setFailure("There is nothing to export: no legacy workspace was stored."); return; }
    try {
      const file = prepareArchiveExport(source.raw, source.id === "preserved" ? "preserved-copy" : "current-workspace");
      download(file);
      setStatus(`Download requested: ${file.filename}, ${file.bytes} bytes. ${file.note} Check your downloads folder to confirm the file was saved.`);
    } catch (error) { setFailure(`The export could not be prepared: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`); }
  }
  return (
    <section style={heading.tone === "alert" ? alertBox : box} aria-labelledby="recovery-archive-heading" data-testid="recovery-archive">
      <h2 id="recovery-archive-heading" style={{ margin: "0 0 6px", fontSize: 18 }}>{heading.title}</h2>
      <p style={{ margin: "0 0 8px" }}>{heading.body}</p>
      <p style={{ margin: "0 0 8px" }}><strong>What you can safely do next:</strong> {heading.next}</p>
      {loaded.problems.map((problem) => <p key={problem} role="alert" data-testid="archive-problem" style={{ margin: "0 0 8px" }}>{problem}</p>)}
      {loaded.sources.map((source) => {
        const view = source.raw === null ? null : summarizeArchive(source.raw);
        const listed = view && view.ok ? view : null;
        let remaining = MAX_LISTED_TASKS;
        return (
          <div key={source.id} data-testid={`archive-source-${source.id}`} style={{ margin: "12px 0 0", paddingTop: 10, borderTop: "1px solid #c9d3e6" }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>{source.title}</h3>
            <p style={{ margin: "0 0 6px" }}>{source.note}</p>
            {source.raw === null && <p style={{ margin: 0 }}>No legacy workspace was stored, so there is nothing to list or export.</p>}
            {view && !view.ok && <p role="alert" style={{ margin: "0 0 6px" }}>{view.message}</p>}
            {listed && (
              <details>
                <summary>{listed.projects.length} {listed.projects.length === 1 ? "project" : "projects"}, {listed.taskCount} {listed.taskCount === 1 ? "task" : "tasks"} (read-only)</summary>
                <ul aria-label={`${source.title}: read-only task list`} style={{ paddingLeft: 18, margin: "6px 0" }}>
                  {listed.projects.map((project, pIndex) => (
                    <li key={`${project.id}-${pIndex}`}><strong>{project.name}</strong>
                      <ul style={{ paddingLeft: 18 }}>{project.tasks.map((task, tIndex) => {
                        if (remaining <= 0) return null; remaining -= 1;
                        return <li key={`${task.id}-${tIndex}`}>{task.title} <span>({task.done ? "done" : "open"})</span></li>;
                      })}</ul>
                    </li>
                  ))}
                </ul>
                {listed.taskCount > MAX_LISTED_TASKS && <p>Showing the first {MAX_LISTED_TASKS} tasks. The raw download contains everything.</p>}
              </details>
            )}
            {source.raw !== null && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "8px 0 0" }}>
                <button type="button" className="secondary-button" onClick={() => doDownload(source)}>Download raw data ({source.title.toLowerCase()})</button>
                <button type="button" className="secondary-button" aria-expanded={shown === source.id} onClick={() => setShown(shown === source.id ? null : source.id)}>{shown === source.id ? "Hide" : "Show"} raw text ({source.title.toLowerCase()})</button>
              </div>
            )}
            {shown === source.id && source.raw !== null && (
              <textarea readOnly aria-label={`${source.title}: raw stored text (read-only)`} value={source.raw} rows={8} style={{ width: "100%", boxSizing: "border-box", marginTop: 8, fontFamily: "monospace", fontSize: 12 }} />
            )}
          </div>
        );
      })}
      <p role="status" aria-live="polite" data-testid="archive-status" style={{ margin: "10px 0 0" }}>{status}</p>
      <p role="alert" data-testid="archive-failure" style={{ margin: "4px 0 0" }}>{failure}</p>
    </section>
  );
}
