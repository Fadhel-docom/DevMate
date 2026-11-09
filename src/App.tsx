import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { getBrowserStorage, readProjectsLocked, saveProjectsLocked, type LoadResult, type Project, type SaveResult } from "./storage";
import { inspectCutoverState, type CutoverState } from "./cutoverState";
import BackupManager from "./BackupManager";
import RecoveryArchive from "./RecoveryArchive";

type Message = { id: string; role: "user" | "assistant"; text: string };
const noticeStyle: CSSProperties = {
  margin: "16px 0 0", padding: "12px 14px", border: "1px solid #f0d9a8",
  background: "#fff8e8", color: "#6b4a0a", borderRadius: 12, fontSize: 13, lineHeight: 1.5
};
const errorStyle: CSSProperties = { ...noticeStyle, border: "1px solid #f1b5b5", background: "#fff1f1", color: "#7a1f1f" };
function skippedSummary(result: LoadResult): string {
  return [
    result.droppedProjects > 0 ? `${result.droppedProjects} projects` : "",
    result.droppedTasks > 0 ? `${result.droppedTasks} tasks` : "",
    result.repairedProjects > 0 ? `${result.repairedProjects} projects with a missing task list` : ""
  ].filter(Boolean).join(", ");
}
const STORAGE_NOT_SAFE = "New changes stay on this page only and will not be saved, so browser storage cannot be treated as safe right now.";
const UNAVAILABLE_NOTICE = "Browser storage is unavailable. Your changes will not be saved after you close this page.";
export function loadNotice(result: LoadResult): string | null {
  switch (result.status) {
    case "corrupt":
    case "invalid":
      return result.backedUp
        ? "Your saved workspace could not be read, so a new one was started. A copy of the unreadable data was saved in this browser."
        : `Your saved workspace could not be read, so a new one was started. A backup copy could not be saved, so the original data was left untouched. ${STORAGE_NOT_SAFE}`;
    case "recovered": {
      const skipped = `Part of your saved workspace could not be read and was skipped (${skippedSummary(result)}).`;
      return result.backedUp
        ? `${skipped} A copy of the original data was saved in this browser.`
        : `${skipped} A backup copy could not be saved, so the original data was left untouched. ${STORAGE_NOT_SAFE}`;
    }
    case "unavailable": return UNAVAILABLE_NOTICE;
    default: return null;
  }
}
/** Explicit, truthful cutover states. Legacy mode (no marker) shows nothing; every other state locks editing. */
export function cutoverNotice(state: CutoverState): { tone: "status" | "alert"; text: string } | null {
  switch (state.mode) {
    case "legacy": return null;
    case "recovery":
      return { tone: "status", text: `A storage cutover was started and is not finished (phase: ${state.phase}). Legacy writes are blocked across tabs and restarts, and editing is disabled. Your legacy workspace is preserved and still readable. Open the recovery panel below to inspect and download your data; this version cannot finish or undo the cutover, and no data has been changed.` };
    case "durable":
      return { tone: "status", text: "Durable storage mode is recorded for this browser. The legacy workspace is kept as a read-only archive, and legacy tasks are not governed or executable. Editing is disabled until the durable workspace interface is available." };
    case "indeterminate":
      return { tone: "alert", text: `The cutover state cannot be verified (${state.reason}). All writes are blocked until the stored state is inspected. ${state.message}` };
  }
}
export function canEditWorkspace(loaded: boolean, recoveryRequired: boolean, initialStatus: LoadResult["status"] | undefined, saveFailureReason?: string, cutoverMode: CutoverState["mode"] = "legacy"): boolean {
  return loaded && !recoveryRequired && initialStatus !== "unavailable" && cutoverMode === "legacy" &&
    saveFailureReason !== "conflict" && saveFailureReason !== "verify" &&
    saveFailureReason !== "cutover-active" && saveFailureReason !== "cutover-indeterminate";
}
export function noticeAfterSave(current: string | null, initial: LoadResult, backupKey?: string): string | null {
  if (backupKey) {
    const status = initial.status === "unavailable" ? "corrupt" : initial.status;
    return loadNotice({ ...initial, status, backedUp: true, backupKey });
  }
  return current === UNAVAILABLE_NOTICE ? null : current;
}
export function saveMessage(failure: Extract<SaveResult, { ok: false }>): string {
  const detail =
    failure.reason === "protect-original" ? `The stored data could not be copied to a backup, so it was left untouched. ${failure.message}` :
    failure.reason === "quota" ? "Browser storage is full." :
    failure.reason === "unavailable" ? "Browser storage is unavailable or blocked." :
    failure.reason === "verify" ? "The data could not be read back after writing." :
    failure.reason === "lock-unavailable" ? "The cross-tab lock is unavailable, so the write was refused." :
    failure.reason === "lock-timeout" ? "The cross-tab lock could not be acquired in time, so the write was refused." :
    failure.reason === "lock-error" ? "The cross-tab lock failed, so the write was refused." :
    failure.reason === "cutover-active" ? "A storage cutover is in progress. Legacy writes are blocked; inspect recovery state before continuing." :
    failure.reason === "cutover-indeterminate" ? "The cutover marker could not be verified. Legacy writes are blocked until storage state can be inspected." :
    failure.reason === "invalid-data" ? "The project data did not pass validation." :
    failure.reason === "conflict" ? "Another tab or session saved newer data. Reload the saved workspace before continuing." :
    "The data could not be written.";
  return `Your latest changes were not saved. ${detail} They are still visible here but may be lost when you close or reload this page.`;
}
export default function App() {
  const [initial, setInitial] = useState<LoadResult | null>(null);
  const baselineRaw = useRef<string | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const [projects, setProjects] = useState<Project[]>([{ id: "starter", name: "My first project", tasks: [] }]);
  const [loaded, setLoaded] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [backupRefreshKey, setBackupRefreshKey] = useState(0);
  const [startupNotice, setStartupNotice] = useState<string | null>(null);
  const [saveFailure, setSaveFailure] = useState<Extract<SaveResult, { ok: false }> | null>(null);
  const [cutover, setCutover] = useState<CutoverState>({ mode: "legacy" });
  const [activeId, setActiveId] = useState("starter");
  const [newProject, setNewProject] = useState("");
  const [newTask, setNewTask] = useState("");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    { id: "welcome", role: "assistant", text: "Hi! I’m DevMate. Tell me what you want to build, fix, or understand. This preview uses a local demo assistant and does not call an AI service." }
  ]);

  useEffect(() => {
    let active = true;
    void readProjectsLocked().then((result) => {
      if (!active) return;
      baselineRaw.current = result.storageRaw;
      if (result.backedUp) setBackupRefreshKey((value) => value + 1);
      setCutover(inspectCutoverState(getBrowserStorage()));
      setInitial(result);
      setProjects(result.projects);
      setActiveId(result.projects[0]?.id ?? "starter");
      setStartupNotice(loadNotice(result));
      setLoaded(true);
    }).catch((error: unknown) => {
      if (!active) return;
      const fallback: LoadResult = { projects: [{ id: "starter", name: "My first project", tasks: [] }], status: "unavailable", droppedProjects: 0, droppedTasks: 0, repairedProjects: 0, backedUp: false, backupKey: null, storageRaw: null };
      setInitial(fallback);
      setStartupNotice(loadNotice(fallback));
      setSaveFailure({ ok: false, reason: "unknown", message: error instanceof Error ? error.message : String(error) });
      setLoaded(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!loaded || !initial || projects === initial.projects) return;
    let active = true;
    const snapshot = projects;
    // Serialize this tab's saves and read the latest baseline only when this
    // save reaches the front of the queue. A prior effect may have been
    // cleaned up by a newer render, but its successful write must still
    // advance the baseline used by the next queued save.
    const save = saveQueue.current.then(async () => {
      const result = await saveProjectsLocked(snapshot, undefined, baselineRaw.current);
      if (result.ok) baselineRaw.current = result.raw;
      if (!active) return;
      if (result.ok) {
        if (result.backupKey) setBackupRefreshKey((value) => value + 1);
        setSaveFailure(null);
        setStartupNotice((current) => noticeAfterSave(current, initial, result.backupKey));
      } else setSaveFailure(result);
    }).catch((error: unknown) => {
      if (active) setSaveFailure({ ok: false, reason: "unknown", message: error instanceof Error ? error.message : String(error) });
    });
    saveQueue.current = save.then(() => undefined, () => undefined);
    return () => { active = false; };
  }, [projects, initial, loaded]);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeId) ?? projects[0],
    [projects, activeId]
  );
  async function reloadFromStorage(safeToResume = true) {
    setLoaded(false);
    if (!safeToResume) setRecoveryRequired(true);
    try {
      const result = await readProjectsLocked();
      baselineRaw.current = result.storageRaw;
      if (result.backedUp) setBackupRefreshKey((value) => value + 1);
      setCutover(inspectCutoverState(getBrowserStorage()));
      setRecoveryRequired(!safeToResume);
      setInitial(safeToResume ? result : { ...result, status: "unavailable" });
      setProjects(result.projects);
      setActiveId(result.projects[0]?.id ?? "starter");
      setStartupNotice(safeToResume
        ? loadNotice(result)
        : "Restore rollback could not be verified. Editing is locked; use the retained pre-restore backup in the Backups panel to recover.");
      setSaveFailure(safeToResume ? null : {
        ok: false, reason: "verify",
        message: "Do not edit this workspace until the pre-restore backup has been restored successfully."
      });
    } catch (error) {
      baselineRaw.current = null;
      setInitial({
        projects, status: "unavailable", droppedProjects: 0, droppedTasks: 0,
        repairedProjects: 0, backedUp: false, backupKey: null, storageRaw: null
      });
      setSaveFailure({ ok: false, reason: "unknown", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoaded(true);
    }
  }
  const canEdit = canEditWorkspace(loaded, recoveryRequired, initial?.status, saveFailure?.reason, cutover.mode);
  // When storage itself is unavailable that notice already explains the lock; do not stack a second, redundant one.
  const cutoverBanner = loaded && initial?.status !== "unavailable" ? cutoverNotice(cutover) : null;
  function addProject(event: FormEvent) {
    event.preventDefault();
    if (!canEdit) return;
    const name = newProject.trim();
    if (!name) return;
    const project = { id: crypto.randomUUID(), name, tasks: [] };
    setProjects((current) => [...current, project]);
    setActiveId(project.id);
    setNewProject("");
  }
  function addTask(event: FormEvent) {
    event.preventDefault();
    if (!canEdit) return;
    const title = newTask.trim();
    if (!title || !activeProject) return;
    const task = { id: crypto.randomUUID(), title, done: false, createdAt: Date.now() };
    setProjects((current) => current.map((project) =>
      project.id === activeProject.id ? { ...project, tasks: [...project.tasks, task] } : project
    ));
    setNewTask("");
  }
  function toggleTask(taskId: string) {
    if (!canEdit) return;
    setProjects((current) => current.map((project) => project.id === activeProject.id
      ? { ...project, tasks: project.tasks.map((task) => task.id === taskId ? { ...task, done: !task.done } : task) }
      : project
    ));
  }
  function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text) return;
    const response = "I’ve saved your message in this demo conversation. AI connection is intentionally disabled in Phase 1, so no API is called and no usage quota is consumed. The next step is to connect a free/approved model provider safely.";
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text }, { id: crypto.randomUUID(), role: "assistant", text: response }]);
    setPrompt("");
  }
  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="DevMate home"><span className="brand-mark">D</span><span>DevMate</span></a>
        <span className="top-note">Your coding workspace</span>
      </header>
      {!loaded && <p role="status" style={noticeStyle}>Loading your workspace safely…</p>}
      {startupNotice && <p role="status" style={noticeStyle}>{startupNotice}</p>}
      {cutoverBanner && <p role={cutoverBanner.tone} data-testid="cutover-banner" style={cutoverBanner.tone === "alert" ? errorStyle : noticeStyle}>{cutoverBanner.text}</p>}
      {loaded && <RecoveryArchive state={cutover} />}
      {saveFailure && <p role="alert" style={errorStyle}>{saveMessage(saveFailure)}</p>}
      {recoveryRequired && <p role="alert" style={errorStyle}>Editing is locked. Restore the retained pre-restore backup from the Backups panel before continuing.</p>}
      {loaded && !recoveryRequired && (initial?.status === "unavailable" || saveFailure?.reason === "conflict") && (
        <button type="button" className="secondary-button" onClick={() => { void reloadFromStorage(); }}>
          Reload saved workspace
        </button>
      )}
      <section className="intro">
        <p className="eyebrow">BUILD WITH CLARITY</p>
        <h1>Your projects.<br /><span>Your next step.</span></h1>
        <p className="intro-copy">Organize coding work, keep notes, and prepare changes for GitHub — in one simple place.</p>
        <div className="status"><span className="status-dot" /> Phase 1 · Local demo · No AI API calls</div>
      </section>
      <div className="workspace">
        <aside className="panel project-panel">
          <div className="section-heading"><div><p className="eyebrow">WORKSPACE</p><h2>Projects</h2></div><span className="count">{projects.length}</span></div>
          <form className="inline-form" onSubmit={addProject}>
            <input aria-label="New project name" disabled={!canEdit} value={newProject} onChange={(event) => setNewProject(event.target.value)} placeholder="New project name" />
            <button className="icon-button" type="submit" aria-label="Add project" disabled={!canEdit}>+</button>
          </form>
          <nav className="project-list" aria-label="Projects">
            {projects.map((project) => (
              <button key={project.id} disabled={!loaded} className={project.id === activeProject?.id ? "project-link active" : "project-link"} onClick={() => setActiveId(project.id)}>
                <span className="project-symbol">▦</span><span>{project.name}</span>
              </button>
            ))}
          </nav>
        </aside>
        <section className="panel tasks-panel">
          <div className="section-heading"><div><p className="eyebrow">PLAN THE WORK</p><h2>{activeProject?.name ?? "Tasks"}</h2></div><span className="count">{activeProject?.tasks.filter((task) => !task.done).length ?? 0} open</span></div>
          <form className="task-form" onSubmit={addTask}>
            <input aria-label="New task" disabled={!canEdit} value={newTask} onChange={(event) => setNewTask(event.target.value)} placeholder="Add a coding task…" />
            <button type="submit" className="primary-button" disabled={!canEdit}>Add task</button>
          </form>
          <div className="task-list">
            {activeProject?.tasks.length ? activeProject.tasks.map((task) => (
              <label className={task.done ? "task done" : "task"} key={task.id}>
                <input type="checkbox" disabled={!canEdit} checked={task.done} onChange={() => toggleTask(task.id)} /><span>{task.title}</span>
              </label>
            )) : <div className="empty-state"><span className="empty-icon">✓</span><strong>A clear space to start</strong><p>Add your first task. Your project data stays in this browser.</p></div>}
          </div>
        </section>
        <section className="panel chat-panel">
          <div className="section-heading"><div><p className="eyebrow">THINK IT THROUGH</p><h2>DevMate chat</h2></div><span className="demo-pill">DEMO</span></div>
          <div className="messages" aria-live="polite">
            {messages.map((message) => <div key={message.id} className={message.role === "user" ? "message user-message" : "message assistant-message"}><span className="message-role">{message.role === "user" ? "YOU" : "DEVMATE"}</span><p>{message.text}</p></div>)}
          </div>
          <form className="chat-form" onSubmit={sendMessage}>
            <input aria-label="Message DevMate" disabled={!loaded} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe what you want to work on…" />
            <button type="submit" className="send-button" aria-label="Send message" disabled={!loaded}>↑</button>
          </form>
          <p className="privacy-note">Demo mode · Messages are not sent to an AI provider.</p>
        </section>
        <BackupManager onRestoreStart={() => setLoaded(false)} onRestored={reloadFromStorage} refreshKey={backupRefreshKey} writesBlocked={cutover.mode !== "legacy"} />
      </div>
      <footer><span>DEVMATE</span><span>Built to make focused progress easier.</span></footer>
    </main>
  );
}
