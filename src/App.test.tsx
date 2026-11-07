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
