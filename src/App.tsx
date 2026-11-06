import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { readProjects, saveProjects, type LoadResult, type Project, type SaveResult, type Task } from "./storage";

type Message = { id: string; role: "user" | "assistant"; text: string };


const noticeStyle: CSSProperties = {
  margin: "16px 0 0",
  padding: "12px 14px",
  border: "1px solid #f0d9a8",
  background: "#fff8e8",
  color: "#6b4a0a",
  borderRadius: 12,
  fontSize: 13,
  lineHeight: 1.5
};

const errorStyle: CSSProperties = { ...noticeStyle, border: "1px solid #f1b5b5", background: "#fff1f1", color: "#7a1f1f" };

function loadNotice(result: LoadResult): string | null {
  switch (result.status) {
    case "corrupt":
    case "invalid":
      return result.backedUp
        ? "Your saved workspace could not be read, so a new one was started. A copy of the unreadable data was kept in this browser."
        : "Your saved workspace could not be read, so a new one was started.";
    case "recovered":
      return `Some saved items were invalid and were skipped (${result.droppedProjects} projects, ${result.droppedTasks} tasks, ${result.repairedProjects} projects with a missing task list).`;
    case "unavailable":
      return "Browser storage is unavailable. Your changes will not be saved after you close this page.";
    default:
      return null;
  }
}

function saveMessage(failure: Extract<SaveResult, { ok: false }>): string {
  const detail = failure.reason === "quota"
    ? "Browser storage is full."
    : failure.reason === "unavailable"
      ? "Browser storage is unavailable or blocked."
      : "The data could not be written.";
  return `Your latest changes were not saved. ${detail} They are still visible here but may be lost when you close or reload this page.`;
}

export default function App() {
  const [initial] = useState<LoadResult>(() => readProjects());
  const [projects, setProjects] = useState<Project[]>(initial.projects);
  const [saveFailure, setSaveFailure] = useState<Extract<SaveResult, { ok: false }> | null>(null);
  const [activeId, setActiveId] = useState("starter");
  const [newProject, setNewProject] = useState("");
  const [newTask, setNewTask] = useState("");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    { id: "welcome", role: "assistant", text: "Hi! I’m DevMate. Tell me what you want to build, fix, or understand. This preview uses a local demo assistant and does not call an AI service." }
  ]);

  useEffect(() => {
    // Nothing has changed yet: do not rewrite what is already stored (it may be an unreadable original).
    if (projects === initial.projects) return;
    const result = saveProjects(projects);
    setSaveFailure(result.ok ? null : result);
  }, [projects, initial]);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeId) ?? projects[0],
    [projects, activeId]
  );

  function addProject(event: FormEvent) {
    event.preventDefault();
    const name = newProject.trim();
    if (!name) return;
    const project = { id: crypto.randomUUID(), name, tasks: [] };
    setProjects((current) => [...current, project]);
    setActiveId(project.id);
    setNewProject("");
  }

  function addTask(event: FormEvent) {
    event.preventDefault();
    const title = newTask.trim();
    if (!title || !activeProject) return;
    const task = { id: crypto.randomUUID(), title, done: false, createdAt: Date.now() };
    setProjects((current) => current.map((project) =>
      project.id === activeProject.id ? { ...project, tasks: [...project.tasks, task] } : project
    ));
    setNewTask("");
  }

  function toggleTask(taskId: string) {
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
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", text },
      { id: crypto.randomUUID(), role: "assistant", text: response }
    ]);
    setPrompt("");
  }

  const startupNotice = loadNotice(initial);

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="DevMate home"><span className="brand-mark">D</span><span>DevMate</span></a>
        <span className="top-note">Your coding workspace</span>
      </header>

      {startupNotice && <p role="status" style={noticeStyle}>{startupNotice}</p>}
      {saveFailure && <p role="alert" style={errorStyle}>{saveMessage(saveFailure)}</p>}

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
            <input aria-label="New project name" value={newProject} onChange={(event) => setNewProject(event.target.value)} placeholder="New project name" />
            <button className="icon-button" type="submit" aria-label="Add project">+</button>
          </form>
          <nav className="project-list" aria-label="Projects">
            {projects.map((project) => (
              <button key={project.id} className={project.id === activeProject?.id ? "project-link active" : "project-link"} onClick={() => setActiveId(project.id)}>
                <span className="project-symbol">▦</span><span>{project.name}</span>
              </button>
            ))}
          </nav>
        </aside>

        <section className="panel tasks-panel">
          <div className="section-heading"><div><p className="eyebrow">PLAN THE WORK</p><h2>{activeProject?.name ?? "Tasks"}</h2></div><span className="count">{activeProject?.tasks.filter((task) => !task.done).length ?? 0} open</span></div>
          <form className="task-form" onSubmit={addTask}>
            <input aria-label="New task" value={newTask} onChange={(event) => setNewTask(event.target.value)} placeholder="Add a coding task…" />
            <button type="submit" className="primary-button">Add task</button>
          </form>
          <div className="task-list">
            {activeProject?.tasks.length ? activeProject.tasks.map((task) => (
              <label className={task.done ? "task done" : "task"} key={task.id}>
                <input type="checkbox" checked={task.done} onChange={() => toggleTask(task.id)} />
                <span>{task.title}</span>
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
            <input aria-label="Message DevMate" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe what you want to work on…" />
            <button type="submit" className="send-button" aria-label="Send message">↑</button>
          </form>
          <p className="privacy-note">Demo mode · Messages are not sent to an AI provider.</p>
        </section>
      </div>
      <footer><span>DEVMATE</span><span>Built to make focused progress easier.</span></footer>
    </main>
  );
}
