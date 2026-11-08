import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import App, { canEditWorkspace, loadNotice, noticeAfterSave } from "./App";
import { BACKUP_KEY, STORAGE_KEY, type LoadResult } from "./storage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let lockRequestCount = 0;
function installFakeLocks() {
  const chains = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request(name: string, opts: { mode?: string; signal?: AbortSignal }, cb: () => Promise<unknown>) {
        lockRequestCount++;
        if (opts.mode !== "exclusive") throw new Error("Storage operations must request an exclusive lock.");
        if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const prev = chains.get(name) ?? Promise.resolve();
        const next = prev.then(() => cb());
        chains.set(name, next.catch(() => undefined));
        return next;
      }
    }
  });
}
function uninstallLocks() {
  delete (navigator as unknown as { locks?: unknown }).locks;
}


/** In-memory storage. While `failReads` is true every read throws, like a blocked or temporarily unavailable localStorage. */
class FakeStorage {
  values = new Map<string, string>();
  failReads = false;
  getItem(key: string): string | null {
    if (this.failReads) throw new DOMException("blocked", "SecurityError");
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function loadResult(status: LoadResult["status"], extra: Partial<LoadResult> = {}): LoadResult {
  return {
    projects: [{ id: "starter", name: "My first project", tasks: [] }],
    status,
    droppedProjects: 0,
    droppedTasks: 0,
    repairedProjects: 0,
    backedUp: false,
    backupKey: null,
    storageRaw: null,
    ...extra
  };
}

describe("startup notice after a successful save (pure)", () => {
  const unavailable = loadResult("unavailable");

  it("removes the stale 'storage unavailable' warning once a save has worked", () => {
    const current = loadNotice(unavailable);
    expect(current).toContain("unavailable");
    expect(noticeAfterSave(current, unavailable)).toBeNull();
  });

  it("keeps any other notice when a save works without a backup", () => {
    const corrupt = loadResult("corrupt", { backedUp: true, backupKey: BACKUP_KEY });
    const current = loadNotice(corrupt);
    expect(noticeAfterSave(current, corrupt)).toBe(current);
    expect(noticeAfterSave(null, loadResult("ok"))).toBeNull();
  });

  it("reports a backup made by the save as a data-corruption notice, even after an 'unavailable' start", () => {
    const text = noticeAfterSave(loadNotice(unavailable), unavailable, BACKUP_KEY) ?? "";
    expect(text).toContain("could not be read");
    expect(text).toContain("A copy of the unreadable data was saved");
    expect(text).not.toContain("unavailable");
  });

  it("keeps the earlier behaviour for a start that was not 'unavailable'", () => {
    const recovered = loadResult("recovered", { droppedTasks: 1 });
    expect(noticeAfterSave(loadNotice(recovered), recovered, BACKUP_KEY)).toBe(
      loadNotice({ ...recovered, backedUp: true, backupKey: BACKUP_KEY })
    );
    expect(noticeAfterSave(null, loadResult("ok"), BACKUP_KEY)).toBeNull();
  });
});

describe("App notices when storage comes back", () => {
  const ownDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => { installFakeLocks(); });
  function useStorage(storage: FakeStorage) {
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => storage });
  }

  async function mount() {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(<StrictMode><App /></StrictMode>);
    });
  }

  async function addProject(name: string) {
    const input = host.querySelector('input[aria-label="New project name"]') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, name);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (host.querySelector("form.inline-form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  const status = () => host.querySelector('[role="status"]')?.textContent ?? null;
  const alert = () => host.querySelector('[role="alert"]');

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    if (ownDescriptor) Object.defineProperty(window, "localStorage", ownDescriptor);
    else delete (window as { localStorage?: unknown }).localStorage;
  });

  it("does not enable edits after an unavailable startup until a successful reload", async () => {
    const storage = new FakeStorage();
    storage.failReads = true;
    storage.values.set(STORAGE_KEY, JSON.stringify([{ id: "saved", name: "Protected", tasks: [] }]));
    useStorage(storage);
    await mount();
    expect(status()).toContain("Browser storage is unavailable");
    const input = host.querySelector('input[aria-label="New project name"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(storage.values.get(STORAGE_KEY)).toContain("Protected");

    storage.failReads = false;
    const retry = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("Reload saved workspace")) as HTMLButtonElement;
    await act(async () => { retry.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(status()).toBeNull();
    expect((host.querySelector('input[aria-label="New project name"]') as HTMLInputElement).disabled).toBe(false);
    expect(host.textContent).toContain("Protected");
  });

  it("keeps editing disabled and preserves the original when startup reads keep failing", async () => {
    const storage = new FakeStorage();
    storage.failReads = true;
    storage.values.set(STORAGE_KEY, JSON.stringify([{ id: "saved", name: "Protected", tasks: [] }]));
    useStorage(storage);
    await mount();
    expect(status()).toContain("Browser storage is unavailable");
    expect((host.querySelector('input[aria-label="New project name"]') as HTMLInputElement).disabled).toBe(true);
    expect(storage.values.get(STORAGE_KEY)).toContain("Protected");
  });

  it("backs up unreadable data during an explicit successful reload before enabling edits", async () => {
    const storage = new FakeStorage();
    storage.values.set(STORAGE_KEY, "{broken");
    storage.failReads = true;
    useStorage(storage);
    await mount();
    expect(status()).toContain("Browser storage is unavailable");
    expect(storage.values.get(STORAGE_KEY)).toBe("{broken");

    storage.failReads = false;
    const retry = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("Reload saved workspace")) as HTMLButtonElement;
    await act(async () => { retry.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(storage.values.get(BACKUP_KEY)).toBe("{broken");
    expect(status()).toContain("A copy of the unreadable data was saved");
    expect((host.querySelector('input[aria-label="New project name"]') as HTMLInputElement).disabled).toBe(false);
  });

  it("keeps a data-corruption notice after a successful save", async () => {
    const storage = new FakeStorage();
    storage.values.set(STORAGE_KEY, "{broken");
    useStorage(storage);
    await mount();
    const before = status();
    expect(before).toContain("A copy of the unreadable data was saved");

    await addProject("After");
    expect(status()).toBe(before);
    expect(storage.values.get(BACKUP_KEY)).toBe("{broken");
    expect(storage.values.get(STORAGE_KEY)).toContain("After");
  });
});

describe("App startup storage locking", () => {
  const ownDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  let host: HTMLElement;
  let root: Root;
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    if (ownDescriptor) Object.defineProperty(window, "localStorage", ownDescriptor);
    else delete (window as { localStorage?: unknown }).localStorage;
  });
  it("loads the saved workspace through the exclusive Web Lock before enabling edits", async () => {
    installFakeLocks();
    lockRequestCount = 0;
    const storage = new FakeStorage();
    storage.values.set(STORAGE_KEY, JSON.stringify([{ id: "saved", name: "Locked startup project", tasks: [] }]));
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => storage });
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root.render(<StrictMode><App /></StrictMode>); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(lockRequestCount).toBeGreaterThan(0);
    expect(host.textContent).toContain("Locked startup project");
    expect((host.querySelector('input[aria-label="New project name"]') as HTMLInputElement).disabled).toBe(false);
  });
});

describe("App cross-tab lock behaviour", () => {
  const ownDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  let host: HTMLElement;
  let root: Root | null = null;
  function useStorage(storage: FakeStorage) {
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => storage });
  }
  async function mount() {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<StrictMode><App /></StrictMode>); await new Promise((r) => setTimeout(r, 0)); });
  }
  afterEach(async () => {
    uninstallLocks();
    if (root) await act(async () => root!.unmount());
    root = null;
    host?.remove();
    if (ownDescriptor) Object.defineProperty(window, "localStorage", ownDescriptor);
    else delete (window as { localStorage?: unknown }).localStorage;
  });
  it("serializes rapid saves and uses the latest verified baseline", async () => {
    const storage = new FakeStorage();
    useStorage(storage);
    await mount();

    let releaseFirstSave!: () => void;
    let signalFirstSaveStarted!: () => void;
    const firstSaveGate = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
    const firstSaveStarted = new Promise<void>((resolve) => { signalFirstSaveStarted = resolve; });
    const chains = new Map<string, Promise<unknown>>();
    let blockNextCallback = true;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request(name: string, _options: unknown, callback: () => Promise<unknown>) {
          const previous = chains.get(name) ?? Promise.resolve();
          const next = previous.then(async () => {
            if (blockNextCallback) {
              blockNextCallback = false;
              signalFirstSaveStarted();
              await firstSaveGate;
            }
            return callback();
          });
          chains.set(name, next.catch(() => undefined));
          return next;
        }
      }
    });

    const input = host.querySelector('input[aria-label="New project name"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const submit = () => (host.querySelector("form.inline-form") as HTMLFormElement)
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await act(async () => {
      setter.call(input, "First rapid save");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      submit();
    });
    await firstSaveStarted;

    await act(async () => {
      const currentInput = host.querySelector('input[aria-label="New project name"]') as HTMLInputElement;
      setter.call(currentInput, "Second rapid save");
      currentInput.dispatchEvent(new Event("input", { bubbles: true }));
      submit();
    });
    releaseFirstSave();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const saved = JSON.parse(storage.values.get(STORAGE_KEY) ?? "[]") as Array<{ name: string }>;
    expect(saved.map((project) => project.name)).toContain("First rapid save");
    expect(saved.map((project) => project.name)).toContain("Second rapid save");
    expect(host.querySelector('[role="alert"]')?.textContent ?? "").not.toContain("Another tab or session");
  });

  it("refuses a save when Web Locks are unavailable", async () => {
    uninstallLocks();
    const storage = new FakeStorage();
    useStorage(storage);
    await mount();
    const input = host.querySelector('input[aria-label="New project name"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "Blocked"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => {
      (host.querySelector("form.inline-form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("cross-tab lock");
    expect(storage.values.has(STORAGE_KEY)).toBe(false);
  });
});


describe("keyboard accessibility and screen-reader semantics", () => {
  const ownDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  const TWO_PROJECTS = JSON.stringify([
    { id: "a", name: "Alpha", tasks: [{ id: "t1", title: "One", done: false, createdAt: 1 }] },
    { id: "b", name: "Beta", tasks: [] }
  ]);
  let host: HTMLElement;
  let root: Root;
  let storage: FakeStorage;
  beforeEach(() => { installFakeLocks(); storage = new FakeStorage(); });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    uninstallLocks();
    if (ownDescriptor) Object.defineProperty(window, "localStorage", ownDescriptor);
    else delete (window as { localStorage?: unknown }).localStorage;
  });
  async function mountApp() {
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => storage });
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root.render(<StrictMode><App /></StrictMode>); await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  function visibleText(node: Node): string {
    if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return "";
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    return Array.from(node.childNodes).map(visibleText).join("");
  }
  /** Simplified accessible-name computation: aria-labelledby, aria-label, wrapping label, then text without aria-hidden parts. */
  function accessibleName(element: Element): string {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) return labelledBy.split(/\s+/).map((id) => visibleText(document.getElementById(id) ?? document.createTextNode(""))).join(" ").trim();
    const label = element.getAttribute("aria-label");
    if (label) return label.trim();
    const wrapping = element instanceof HTMLInputElement ? element.closest("label") : null;
    return visibleText(wrapping ?? element).trim();
  }
  const announcer = () => host.querySelector('[data-testid="sr-announcer"]') as HTMLElement;
  async function setInput(label: string, value: string) {
    const input = host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  }
  async function submit(selector: string) {
    await act(async () => {
      (host.querySelector(selector) as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await tick();
    });
  }

  it("uses real landmarks with one main region, and the skip link is the first tab stop and targets it", async () => {
    await mountApp();
    expect(host.querySelectorAll("main")).toHaveLength(1);
    const main = host.querySelector("main")!;
    expect(main.id).toBe("main-content");
    expect(main.getAttribute("tabindex")).toBe("-1");
    expect(host.querySelector("header")).not.toBeNull();
    expect(host.querySelector("footer")).not.toBeNull();
    expect(main.querySelector("header")).toBeNull();
    expect(main.querySelector("footer")).toBeNull();
    const firstStop = Array.from(host.querySelectorAll<HTMLElement>("a[href],button,input,[tabindex]")).find((element) => !element.hasAttribute("disabled"))!;
    expect(firstStop.getAttribute("href")).toBe("#main-content");
    expect(accessibleName(firstStop)).toBe("Skip to main content");
    expect(host.querySelector(firstStop.getAttribute("href")!)).toBe(main);
    expect(accessibleName(host.querySelector(".brand")!)).toBe("DevMate home");
  });

  it("gives every button, link and field an accessible name, including the icon-only buttons, without reading decorative glyphs", async () => {
    storage.values.set(BACKUP_KEY, JSON.stringify([{ id: "old", name: "Old", tasks: [] }]));
    storage.values.set(STORAGE_KEY, TWO_PROJECTS);
    await mountApp();
    const controls = Array.from(host.querySelectorAll("button, input, a[href]"));
    expect(controls.length).toBeGreaterThan(8);
    for (const control of controls) expect(accessibleName(control), control.outerHTML).not.toBe("");
    const names = controls.map(accessibleName);
    expect(names).toEqual(expect.arrayContaining(["Add project", "Send message", "New project name", "New task", "Message DevMate", "DevMate home", "Alpha", "Beta", "Restore", "Delete"]));
    for (const glyph of ["▦", "✓", "↑"]) expect(names.some((name) => name.includes(glyph))).toBe(false);
  });

  it("marks the active project with aria-current, keeps project buttons focusable, and announces a change of project", async () => {
    storage.values.set(STORAGE_KEY, TWO_PROJECTS);
    await mountApp();
    const buttons = Array.from(host.querySelectorAll('nav[aria-label="Projects"] button')) as HTMLButtonElement[];
    expect(buttons.map(accessibleName)).toEqual(["Alpha", "Beta"]);
    expect(buttons.map((button) => button.getAttribute("aria-current"))).toEqual(["true", null]);
    buttons[1].focus();
    expect(document.activeElement).toBe(buttons[1]);
    await act(async () => { buttons[1].click(); await tick(); });
    expect(buttons.map((button) => button.getAttribute("aria-current"))).toEqual([null, "true"]);
    expect(document.activeElement).toBe(buttons[1]);
    expect(announcer().textContent).toBe("Showing Beta. 0 open tasks.");
    expect(host.querySelector("#tasks-heading")?.textContent).toBe("Tasks for Beta");
    expect(accessibleName(host.querySelector(".project-panel")!)).toBe("Projects");
    expect(host.querySelector(".project-panel .count")?.textContent).toBe("2 projects");
  });

  it("labels each task checkbox by its title, groups tasks under the project heading, and announces completion and reopening", async () => {
    storage.values.set(STORAGE_KEY, TWO_PROJECTS);
    await mountApp();
    const checkbox = host.querySelector('.task input[type="checkbox"]') as HTMLInputElement;
    expect(accessibleName(checkbox)).toBe("One");
    const group = host.querySelector('[role="group"][aria-labelledby="tasks-heading"]')!;
    expect(group.contains(checkbox)).toBe(true);
    expect(accessibleName(group)).toBe("Tasks for Alpha");
    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);
    await act(async () => { checkbox.click(); await tick(); });
    expect(announcer().textContent).toBe("Task completed: One");
    await act(async () => { checkbox.click(); await tick(); });
    expect(announcer().textContent).toBe("Task reopened: One");
  });

  it("announces successes and empty submissions instead of failing silently", async () => {
    await mountApp();
    await submit("form.inline-form");
    expect(announcer().textContent).toBe("Enter a project name first.");
    await setInput("New project name", "Gamma");
    await submit("form.inline-form");
    expect(announcer().textContent).toBe("Project added: Gamma. It is now selected.");
    await submit("form.task-form");
    expect(announcer().textContent).toBe("Enter a task description first.");
    await setInput("New task", "Write docs");
    await submit("form.task-form");
    expect(announcer().textContent).toBe("Task added: Write docs");
    await submit("form.chat-form");
    expect(announcer().textContent).toBe("Type a message first.");
  });

  it("keeps the announcer polite, atomic and free of status/alert roles, and re-announces an identical message in a fresh node", async () => {
    await mountApp();
    const live = announcer();
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.getAttribute("aria-atomic")).toBe("true");
    expect(live.getAttribute("role")).toBeNull();
    expect(live.className).toContain("sr-only");
    await submit("form.inline-form");
    const first = live.firstElementChild;
    await submit("form.inline-form");
    const second = live.firstElementChild;
    expect(second).not.toBe(first);
    expect(second?.textContent).toBe(first?.textContent);
  });

  it("exposes the chat as a named, keyboard-scrollable log that announces only additions and never re-creates old messages", async () => {
    await mountApp();
    const log = host.querySelector('[role="log"]') as HTMLElement;
    expect(accessibleName(log)).toBe("Conversation with DevMate");
    expect(log.getAttribute("tabindex")).toBe("0");
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(log.getAttribute("aria-atomic")).toBe("false");
    expect(log.getAttribute("aria-relevant")).toBe("additions");
    expect(accessibleName(log.closest("section")!)).toBe("DevMate chat");
    const input = host.querySelector('input[aria-label="Message DevMate"]') as HTMLInputElement;
    expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toContain("not sent to an AI provider");
    const welcome = log.firstElementChild;
    const before = log.children.length;
    await setInput("Message DevMate", "Hello");
    await submit("form.chat-form");
    expect(log.children.length).toBe(before + 2);
    expect(log.firstElementChild).toBe(welcome);
    expect(log.textContent).toContain("Hello");
  });

  it("shows a loading status and aria-busy while storage is pending, then clears both and announces readiness", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request(_name: string, _options: unknown, callback: () => Promise<unknown>) { return gate.then(() => callback()); } }
    });
    await mountApp();
    const main = host.querySelector("main")!;
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Loading your workspace safely");
    expect(main.getAttribute("aria-busy")).toBe("true");
    expect((host.querySelector('input[aria-label="New project name"]') as HTMLInputElement).disabled).toBe(true);
    await act(async () => { release(); await tick(); await tick(); });
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(main.getAttribute("aria-busy")).toBe("false");
    expect(announcer().textContent).toBe("Workspace ready. 1 project.");
  });

  it("keeps error messages as alerts and returns keyboard focus to the main region after reloading from unavailable storage", async () => {
    storage.failReads = true;
    storage.values.set(STORAGE_KEY, TWO_PROJECTS);
    await mountApp();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Browser storage is unavailable");
    const retry = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("Reload saved workspace")) as HTMLButtonElement;
    retry.focus();
    expect(document.activeElement).toBe(retry);
    storage.failReads = false;
    await act(async () => { retry.click(); await tick(); await tick(); });
    expect(host.contains(retry)).toBe(false);
    expect(document.activeElement).toBe(host.querySelector("main"));
    expect(host.textContent).toContain("Beta");
  });

  it("groups each backup's actions under its slot title and describes the confirmation dialog", async () => {
    storage.values.set(BACKUP_KEY, JSON.stringify([{ id: "old", name: "Old", tasks: [] }]));
    await mountApp();
    expect(host.querySelector(".backups-panel .count")?.textContent).toBe("1 backup");
    const actions = host.querySelector(".backup-list .backup-actions") as HTMLElement;
    expect(actions.getAttribute("role")).toBe("group");
    expect(accessibleName(actions)).toMatch(/^Slot \d/);
    const remove = Array.from(actions.querySelectorAll("button")).find((button) => button.textContent === "Delete") as HTMLButtonElement;
    await act(async () => { remove.click(); await tick(); });
    const dialog = host.querySelector("dialog") as HTMLElement;
    expect(accessibleName(dialog)).toBe("Delete this backup?");
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toContain("permanently removes");
    const cancel = Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Cancel") as HTMLButtonElement;
    await act(async () => { cancel.click(); await tick(); });
    expect(host.querySelector("dialog")).toBeNull();
  });

  it("static source check of styles.css: a visible focus ring overrides the old outline:none, plus skip-link and sr-only rules (not a rendered check)", async () => {
    // Vitest replaces imported CSS (including ?raw) with an empty string, so read the real file from disk.
    // The specifier is a variable and untyped on purpose: the project does not depend on @types/node.
    const nodeFs = "node:fs";
    const fs = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(path: string, encoding: string): string };
    const cwd = (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? ".";
    const css = fs.readFileSync(`${cwd}/src/styles.css`, "utf8");
    const base = css.indexOf(".inline-form input,.task-form input,.chat-form input{");
    const ring = css.indexOf("input:focus-visible");
    expect(base).toBeGreaterThanOrEqual(0);
    expect(css.slice(base, base + 400)).toContain("outline:none");
    expect(ring).toBeGreaterThan(base);
    expect(css).toMatch(/a:focus-visible,button:focus-visible,input:focus-visible[^{]*\{[^}]*outline:3px solid #3a2fb0/);
    expect(css).toContain(".skip-link{");
    expect(css).toContain(".sr-only{");
  });
});

describe("workspace edit safety gate", () => {
  it("blocks edits after an unverified storage write", () => {
    expect(canEditWorkspace(true, false, "ok", "verify")).toBe(false);
  });
  it("allows edits after a healthy load with no save failure", () => {
    expect(canEditWorkspace(true, false, "ok", undefined)).toBe(true);
  });
  it("continues blocking conflicts, unavailable storage, and recovery lockouts", () => {
    expect(canEditWorkspace(true, false, "ok", "conflict")).toBe(false);
    expect(canEditWorkspace(true, false, "unavailable", undefined)).toBe(false);
    expect(canEditWorkspace(true, true, "ok", undefined)).toBe(false);
  });
});
