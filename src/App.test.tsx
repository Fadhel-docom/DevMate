import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import App, { loadNotice, noticeAfterSave } from "./App";
import { BACKUP_KEY, STORAGE_KEY, type LoadResult } from "./storage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function installFakeLocks() {
  const chains = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request(name: string, _opts: unknown, cb: () => Promise<unknown>) {
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

  it("removes the 'unavailable' warning after a later save succeeds", async () => {
    const storage = new FakeStorage();
    storage.failReads = true;
    useStorage(storage);
    await mount();
    expect(status()).toContain("Browser storage is unavailable");

    storage.failReads = false; // storage works again
    await addProject("Recovered");

    expect(status()).toBeNull();
    expect(alert()).toBeNull();
    expect(storage.values.get(STORAGE_KEY)).toContain("Recovered");
  });

  it("keeps the 'unavailable' warning, and shows the save alert, while saving keeps failing", async () => {
    const storage = new FakeStorage();
    storage.failReads = true;
    useStorage(storage);
    await mount();
    await addProject("Not saved");

    expect(status()).toContain("Browser storage is unavailable");
    expect(alert()?.textContent).toContain("were not saved");
    expect(storage.values.size).toBe(0);
  });

  it("replaces it with the data-corruption notice when the save had to back up unreadable data", async () => {
    const storage = new FakeStorage();
    storage.values.set(STORAGE_KEY, "{broken");
    storage.failReads = true;
    useStorage(storage);
    await mount();
    expect(status()).toContain("Browser storage is unavailable");

    storage.failReads = false;
    await addProject("First");
    expect(storage.values.get(BACKUP_KEY)).toBe("{broken");
    expect(status()).toContain("A copy of the unreadable data was saved");
    expect(status()).not.toContain("unavailable");

    await addProject("Second"); // a later save must not drop that notice
    expect(status()).toContain("A copy of the unreadable data was saved");
    expect(alert()).toBeNull();
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
    await act(async () => { root.render(<StrictMode><App /></StrictMode>); await new Promise((r) => setTimeout(r, 0)); });
  }
  afterEach(async () => {
    uninstallLocks();
    if (root) await act(async () => root!.unmount());
    root = null;
    host?.remove();
    if (ownDescriptor) Object.defineProperty(window, "localStorage", ownDescriptor);
    else delete (window as { localStorage?: unknown }).localStorage;
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
