import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import BackupManager, { isRestoreSafeToResume } from "./BackupManager";
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
  async function mount(onRestored: (safeToResume?: boolean) => void | Promise<void> = () => undefined, refreshKey = 0) {
    host = document.createElement("div"); document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<StrictMode><BackupManager onRestored={onRestored} refreshKey={refreshKey} /></StrictMode>); await new Promise((r) => setTimeout(r, 0)); });
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
  it("refreshes the backup list when the parent refresh key changes", async () => {
    const storage = new FakeStorage();
    useStorage(storage);
    await mount();
    expect(host!.textContent).toContain("No backups yet");
    storage.setItem(BACKUP_KEY, "{broken");
    await act(async () => {
      root!.render(<StrictMode><BackupManager onRestored={() => undefined} refreshKey={1} /></StrictMode>);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host!.textContent).toContain("Slot 1");
  });

  it("offers raw export for an unreadable backup", async () => {
    const storage = new FakeStorage();
    storage.setItem(BACKUP_KEY, "{broken");
    useStorage(storage);
    await mount();
    expect(buttons("Export raw")).toHaveLength(1);
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
  it("disables restore for parseable but structurally invalid backups", async () => {
    const storage = new FakeStorage();
    storage.setItem(BACKUP_KEY, JSON.stringify([{ id: "p1", name: "P", tasks: [{ id: "t1", title: 9, done: false, createdAt: 1 }] }]));
    useStorage(storage); await mount();
    const restore = buttons("Restore")[0];
    expect(restore.disabled).toBe(true);
    expect(host!.textContent).toContain("Invalid or incomplete backup");
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
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


describe("restore resume safety", () => {
  it("resumes after a confirmed restore", () => {
    expect(isRestoreSafeToResume({ ok: true, snapshotKey: null })).toBe(true);
  });
  it("resumes after a failed restore only when rollback was verified", () => {
    expect(isRestoreSafeToResume({ ok: false, reason: "verify", message: "failed", rollbackVerified: true })).toBe(true);
    expect(isRestoreSafeToResume({ ok: false, reason: "verify", message: "failed", rollbackVerified: false })).toBe(false);
    expect(isRestoreSafeToResume({ ok: false, reason: "write-failed", message: "failed" })).toBe(false);
  });
});
