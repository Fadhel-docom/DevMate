import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import BackupManager from "./BackupManager";
import { BACKUP_KEY, backupKey, backupMetaKey, listBackups, STORAGE_KEY } from "./storage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function installFakeLocks() {
  const chains = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, "locks", { configurable: true, value: {
    request(name: string, _opts: unknown, cb: () => Promise<unknown>) {
      const prev = chains.get(name) ?? Promise.resolve();
      const next = prev.then(() => cb());
      chains.set(name, next.catch(() => undefined));
      return next;
    }
  } });
}
function uninstallLocks() { delete (navigator as unknown as { locks?: unknown }).locks; }
class FakeStorage {
  values = new Map<string, string>();
  getItem(k: string) { return this.values.get(k) ?? null; }
  setItem(k: string, v: string) { this.values.set(k, v); }
  removeItem(k: string) { this.values.delete(k); }
}
describe("BackupManager UI", () => {
  let host: HTMLElement | null = null;
  let root: Root | null = null;
  const ownDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  function useStorage(storage: FakeStorage) {
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => storage });
  }
  async function mount(onRestored: () => void = () => undefined) {
    host = document.createElement("div"); document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<StrictMode><BackupManager onRestored={onRestored} /></StrictMode>); await new Promise((r) => setTimeout(r, 0)); });
  }
  function buttons(label: string): HTMLButtonElement[] {
    return Array.from(host!.querySelectorAll("button")).filter((b) => (b.textContent ?? "").trim().includes(label)) as HTMLButtonElement[];
  }
  function confirmButtons(label: string): HTMLButtonElement[] {
    return Array.from(host!.querySelectorAll(".confirm-dialog button")).filter((b) => (b.textContent ?? "").trim() === label) as HTMLButtonElement[];
  }
  beforeEach(() => installFakeLocks());
  afterEach(async () => {
    uninstallLocks();
    if (root) await act(async () => root!.unmount());
    host?.remove(); root = null; host = null;
    if (ownDescriptor) Object.defineProperty(window, "localStorage", ownDescriptor);
    else delete (window as { localStorage?: unknown }).localStorage;
  });
  it("shows the empty state when there are no backups", async () => {
    useStorage(new FakeStorage()); await mount();
    expect(host!.textContent).toContain("No backups yet");
  });
  it("lists backups with slot info", async () => {
    const storage = new FakeStorage();
    storage.setItem(BACKUP_KEY, "{broken");
    storage.setItem(backupKey(2), JSON.stringify([{ id: "p1", name: "P", tasks: [] }]));
    storage.setItem(backupMetaKey(2), JSON.stringify({ createdAt: 1700000000000, reason: "pre-restore" }));
    useStorage(storage); await mount();
    expect(host!.textContent).toContain("Slot 1");
    expect(host!.textContent).toContain("Slot 2");
  });
  it("restores after confirmation and snapshots the current workspace", async () => {
    const storage = new FakeStorage();
    storage.setItem(BACKUP_KEY, JSON.stringify([{ id: "p1", name: "P", tasks: [] }]));
    storage.setItem(STORAGE_KEY, JSON.stringify([{ id: "cur", name: "Current", tasks: [] }]));
    useStorage(storage); let restored = 0; await mount(() => { restored++; });
    await act(async () => { buttons("Restore")[0].click(); });
    expect(host!.textContent).toContain("Restore this backup?");
    await act(async () => { confirmButtons("Restore")[0].click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(restored).toBe(1);
    expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]")[0].id).toBe("p1");
    expect(listBackups(storage).some((b) => b.reason === "pre-restore")).toBe(true);
  });
  it("deletes only the selected backup after confirmation", async () => {
    const storage = new FakeStorage(); storage.setItem(BACKUP_KEY, "a"); storage.setItem(backupKey(2), "b");
    useStorage(storage); await mount();
    await act(async () => { buttons("Delete")[0].click(); });
    expect(host!.textContent).toContain("Delete this backup?");
    await act(async () => { confirmButtons("Delete")[0].click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(storage.values.has(BACKUP_KEY)).toBe(false);
    expect(storage.values.get(backupKey(2))).toBe("b");
  });
  it("cancels a delete without changing storage", async () => {
    const storage = new FakeStorage(); storage.setItem(BACKUP_KEY, "a");
    useStorage(storage); await mount();
    await act(async () => { buttons("Delete")[0].click(); });
    await act(async () => { confirmButtons("Cancel")[0].click(); });
    expect(storage.values.get(BACKUP_KEY)).toBe("a");
  });
  it("shows an error and keeps data when locks are unavailable", async () => {
    uninstallLocks();
    const storage = new FakeStorage(); storage.setItem(BACKUP_KEY, "a");
    useStorage(storage); await mount();
    await act(async () => { buttons("Delete")[0].click(); });
    await act(async () => { confirmButtons("Delete")[0].click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(host!.textContent).toContain("cross-tab lock");
    expect(storage.values.get(BACKUP_KEY)).toBe("a");
  });
});
