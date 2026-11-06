import { useCallback, useEffect, useRef, useState } from "react";
import { deleteBackup, listBackups, restoreBackup, type BackupInfo } from "./storage";

type Props = { onRestoreStart?: () => void; onRestored: (safeToResume?: boolean) => void | Promise<void>; refreshKey?: number };
type Pending = { action: "restore" | "delete"; backup: BackupInfo } | null;

export default function BackupManager({ onRestoreStart, onRestored, refreshKey = 0 }: Props) {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const refresh = useCallback(() => {
    setBackups(listBackups());
  }, []);
  useEffect(() => { refresh(); }, [refresh, refreshKey]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (pending && dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!pending && dialog?.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [pending]);

  async function confirmRestore() {
    if (!pending || pending.action !== "restore" || !pending.backup.restorable) return;
    setBusy(true); setError(null); onRestoreStart?.();
    let safeToResume = true;
    try {
      const result = await restoreBackup(pending.backup.key);
      if (!result.ok) {
        if (result.rollbackVerified === false) safeToResume = false;
        setError(result.message || `Restore failed: ${result.reason}`);
      }
      else { setPending(null); refresh(); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Restore failed unexpectedly.");
    } finally { setBusy(false); refresh(); await onRestored(safeToResume); }
  }
  async function confirmDelete() {
    if (!pending || pending.action !== "delete") return;
    setBusy(true); setError(null);
    try {
      const result = await deleteBackup(pending.backup.key);
      if (!result.ok) setError(result.message || `Delete failed: ${result.reason}`);
      else { setPending(null); refresh(); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Delete failed unexpectedly.");
    } finally { setBusy(false); }
  }
  return (
    <section className="panel backups-panel" aria-labelledby="backups-heading">
      <div className="section-heading">
        <div><p className="eyebrow">RECOVERY</p><h2 id="backups-heading">Backups</h2></div>
        <span className="count">{backups.length}</span>
      </div>
      {error && !pending && <p className="backup-error" role="alert">{error}</p>}
      {backups.length === 0 ? (
        <div className="backup-empty"><strong>No backups yet</strong>When damaged or partially unreadable workspace data is preserved, it will appear here.</div>
      ) : (
        <ul className="backup-list">
          {backups.map((backup) => (
            <li className="backup-item" key={backup.key}>
              <div className="backup-meta">
                <strong>Slot {backup.slot} · {backup.reason ?? "Legacy backup"}</strong>
                <span>{backup.createdAt === null ? "Date unavailable" : new Date(backup.createdAt).toLocaleString()}</span>
                <span className="backup-detail">{backup.parseable ? `${backup.projectCount ?? 0} project entries` : "Unreadable raw data"} · {backup.key}</span>
                {!backup.restorable && <span className="backup-detail">Invalid or incomplete backup — restore disabled</span>}
              </div>
              <code className="backup-preview">{backup.preview || "(empty backup)"}</code>
              <div className="backup-actions">
                <button className="primary-button" type="button" disabled={busy || !backup.restorable} onClick={() => { setError(null); setPending({ action: "restore", backup }); }}>Restore</button>
                <button className="secondary-button" type="button" disabled={busy} onClick={() => { setError(null); setPending({ action: "delete", backup }); }}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="backup-note">Restoring first preserves the current workspace as another backup when possible. Backups are stored only in this browser.</p>
      {pending && (
        <dialog ref={dialogRef} className="confirm-dialog" aria-labelledby="backup-confirm-title" onCancel={(event) => { event.preventDefault(); if (!busy) setPending(null); }}>
            {error && <p className="backup-error" role="alert">{error}</p>}
            <h3 id="backup-confirm-title">{pending.action === "restore" ? "Restore this backup?" : "Delete this backup?"}</h3>
            <p>{pending.action === "restore"
              ? "The selected backup will replace the current workspace. The current workspace is snapshotted first when possible."
              : "This permanently removes the selected backup and its metadata from this browser."}</p>
            <div className="backup-actions">
              <button type="button" className="secondary-button" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
              <button type="button" className="primary-button" disabled={busy} onClick={pending.action === "restore" ? confirmRestore : confirmDelete}>{busy ? "Working…" : pending.action === "restore" ? "Restore" : "Delete"}</button>
            </div>
          </dialog>
      )}
    </section>
  );
}
