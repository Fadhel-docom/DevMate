/**
 * Isolated IndexedDB CAS spike.
 *
 * Intentionally not imported by the application. It owns only the
 * devmate-cas-spike-v1 database and never reads or writes localStorage.
 * This is an experiment, not a migration or production storage adapter.
 */

export const CAS_DB_NAME = "devmate-cas-spike-v1";
export const CAS_DB_VERSION = 1;
export const CAS_BACKUP_LIMIT = 20;

export type CasError = "unavailable" | "blocked" | "quota" | "backup-limit" | "tx-aborted" | "unknown";
export type CasReadResult =
  | { ok: true; version: number; raw: string }
  | { ok: false; error: CasError };
export type CasWriteResult =
  | { ok: true; version: number }
  | { ok: false; error: CasError }
  | { ok: false; conflict: true; actualVersion: number };

export interface CasStore {
  read(): Promise<CasReadResult>;
  write(input: { expectedVersion: number; raw: string; writer?: string }): Promise<CasWriteResult>;
  close(): void;
}

interface WorkspaceRecord {
  name: "workspace"; version: number; raw: string; updatedAt: number; writer: string;
}
interface BackupRecord {
  id?: number; raw: string; reason: "pre-write"; sourceVersion: number; createdAt: number; writer: string;
}

function classifyError(error: unknown): CasError {
  if (error == null) return "tx-aborted";
  const name = error && typeof error === "object" && "name" in error
    ? String((error as { name?: unknown }).name) : "";
  if (name === "QuotaExceededError") return "quota";
  if (name === "SecurityError" || name === "NotSupportedError") return "unavailable";
  if (name === "AbortError" || name === "TransactionInactiveError") return "tx-aborted";
  if (name === "BlockedError") return "blocked";
  return "unknown";
}
function requestError(request: IDBRequest): unknown {
  return request.error ?? new Error("IndexedDB request failed");
}

/** Opens a private test database. Failures never fall back to localStorage. */
export function openCasStore(options: { blockedTimeoutMs?: number } = {}): Promise<CasStore> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(Object.assign(new Error("IndexedDB unavailable"), { name: "NotSupportedError" }));
  }
  const timeoutMs = options.blockedTimeoutMs ?? 8000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    const request = indexedDB.open(CAS_DB_NAME, CAS_DB_VERSION);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (blockedTimer) clearTimeout(blockedTimer);
      reject(error);
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("records")) db.createObjectStore("records", { keyPath: "name" });
      if (!db.objectStoreNames.contains("backups")) db.createObjectStore("backups", { keyPath: "id", autoIncrement: true });
    };
    request.onblocked = () => {
      if (!blockedTimer) blockedTimer = setTimeout(() => {
        fail(Object.assign(new Error("IndexedDB upgrade blocked"), { name: "BlockedError" }));
      }, timeoutMs);
    };
    request.onerror = () => fail(requestError(request));
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      if (blockedTimer) clearTimeout(blockedTimer);
      const db = request.result;
      db.onversionchange = () => db.close();
      const store: CasStore = {
        close: () => db.close(),
        read: () => new Promise((readResolve) => {
          let result: CasReadResult = { ok: false, error: "unknown" };
          let tx: IDBTransaction;
          try {
            tx = db.transaction(["records"], "readonly");
            const get = tx.objectStore("records").get("workspace");
            get.onsuccess = () => {
              const record = get.result as WorkspaceRecord | undefined;
              result = record ? { ok: true, version: record.version, raw: record.raw } : { ok: true, version: 0, raw: "" };
            };
            get.onerror = () => {
              result = { ok: false, error: classifyError(requestError(get)) };
              try { tx.abort(); } catch { /* transaction may already be inactive */ }
            };
            tx.oncomplete = () => readResolve(result);
            tx.onabort = () => readResolve({ ok: false, error: classifyError(tx.error) });
            tx.onerror = () => { result = { ok: false, error: classifyError(tx.error) }; };
          } catch (error) { readResolve({ ok: false, error: classifyError(error) }); }
        }),
        write: ({ expectedVersion, raw, writer = "unknown" }) => new Promise((writeResolve) => {
          let result: CasWriteResult = { ok: false, error: "unknown" };
          let tx: IDBTransaction;
          try {
            tx = db.transaction(["records", "backups"], "readwrite", { durability: "strict" });
            const records = tx.objectStore("records");
            const backups = tx.objectStore("backups");
            const get = records.get("workspace");
            get.onsuccess = () => {
              const current = get.result as WorkspaceRecord | undefined;
              const actualVersion = current?.version ?? 0;
              if (actualVersion !== expectedVersion) {
                result = { ok: false, conflict: true, actualVersion };
                return;
              }
              const persist = () => {
                const nextVersion = actualVersion + 1;
                records.put({ name: "workspace", version: nextVersion, raw, updatedAt: Date.now(), writer } satisfies WorkspaceRecord);
                result = { ok: true, version: nextVersion };
              };
              if (!current) { persist(); return; }
              const count = backups.count();
              count.onsuccess = () => {
                if (count.result >= CAS_BACKUP_LIMIT) {
                  result = { ok: false, error: "backup-limit" };
                  try { tx.abort(); } catch { /* already inactive */ }
                  return;
                }
                const backup: BackupRecord = { raw: current.raw, reason: "pre-write", sourceVersion: current.version, createdAt: Date.now(), writer };
                backups.add(backup);
                persist();
              };
              count.onerror = () => {
                result = { ok: false, error: classifyError(requestError(count)) };
                try { tx.abort(); } catch { /* already inactive */ }
              };
            };
            get.onerror = () => {
              result = { ok: false, error: classifyError(requestError(get)) };
              try { tx.abort(); } catch { /* already inactive */ }
            };
            tx.oncomplete = () => writeResolve(result);
            tx.onabort = () => {
              if (result.ok === false && "conflict" in result) writeResolve(result);
              else writeResolve({ ok: false, error: result.ok === false ? result.error : classifyError(tx.error) });
            };
            tx.onerror = () => {
              if (!(result.ok === false && "conflict" in result)) result = { ok: false, error: classifyError(tx.error) };
            };
          } catch (error) { writeResolve({ ok: false, error: classifyError(error) }); }
        }),
      };
      resolve(store);
    };
  });
}
