// The unmodified base-revision (3c60a85) storage.ts, exposed as window.leg: what an already-loaded pre-barrier tab executes.
// The helpers below reproduce the base App's own call shapes (base App.tsx lines 82/111/134, BackupManager.tsx lines 47/61):
//   load:      readProjectsLocked()                                  -> baseline raw
//   autosave:  saveProjectsLocked(snapshot, undefined, baselineRaw)
//   restore:   restoreBackup(key, undefined, backup.fingerprint)
//   delete:    deleteBackup(key, undefined, backup.fingerprint)
import { deleteBackup, listBackups, readProjectsLocked, restoreBackup, saveProjectsLocked } from "../../src/__fixtures__/legacyStorage.base";
export * from "../../src/__fixtures__/legacyStorage.base";

type Hold = { __baseline?: string | null; __projects?: unknown[] };
const w = window as unknown as Hold;

export async function oldLoad() {
  const result = await readProjectsLocked();
  w.__baseline = result.storageRaw; w.__projects = result.projects;
  return { status: result.status, baselineLength: result.storageRaw?.length ?? null, backedUp: result.backedUp };
}
export async function oldAutosave(name: string) {
  const projects = JSON.parse(JSON.stringify(w.__projects ?? [])) as Array<{ name: string }>;
  if (projects[0]) projects[0].name = name;
  return saveProjectsLocked(projects as never, undefined, w.__baseline);
}
export async function oldDeleteAllBackupsUiShaped() {
  const out: Array<{ key: string; result: unknown }> = [];
  for (const backup of listBackups()) out.push({ key: backup.key, result: await deleteBackup(backup.key, undefined, backup.fingerprint) });
  return out;
}
export async function oldRestoreFirstBackupUiShaped() {
  const first = listBackups()[0];
  return first ? { key: first.key, result: await restoreBackup(first.key, undefined, first.fingerprint) } : null;
}
export const oldListBackups = () => listBackups().map((b) => ({ key: b.key, slot: b.slot, restorable: b.restorable, length: b.fingerprint.length }));
