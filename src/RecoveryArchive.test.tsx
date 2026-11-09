import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import RecoveryArchive, { archiveHeading, loadArchiveSources } from "./RecoveryArchive";
import { isWellFormedUtf16, prepareArchiveExport, summarizeArchive, type ExportFile } from "./archiveExport";
import { CUTOVER_MARKER_KEY, CUTOVER_SOURCE_COPY_PREFIX, fingerprintSource, inspectCutoverState, serializeMarker, type CutoverPhase, type CutoverState } from "./cutoverState";
import { STORAGE_KEY } from "./storage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class Mem {
  values = new Map<string, string>(); writes: string[] = []; removes: string[] = []; failReads = false;
  getItem(key: string) { if (this.failReads) throw new DOMException("blocked", "SecurityError"); return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.writes.push(key); this.values.set(key, value); }
  removeItem(key: string) { this.removes.push(key); this.values.delete(key); }
}
const RAW = JSON.stringify([{ id: "p1", name: "Archived legacy project", tasks: [{ id: "t1", title: "Legacy task one", done: false, createdAt: 1 }, { id: "t2", title: "Legacy task two", done: true, createdAt: 2 }] }, { id: "p2", name: "Second", tasks: [] }]);
const marker = (raw: string | null, phase: CutoverPhase) => serializeMarker({ version: 1, sourceFingerprint: fingerprintSource(raw), startedAt: 1, phase, profileSchemaVersion: 1, ledgerSchemaVersion: 1 });
function seeded(phase: CutoverPhase, opts: { legacy?: string | null; copy?: string | null; fp?: string | null } = {}) {
  const s = new Mem(); const fpSource = opts.fp === undefined ? RAW : opts.fp;
  const legacy = opts.legacy === undefined ? RAW : opts.legacy; const copy = opts.copy === undefined ? RAW : opts.copy;
  if (legacy !== null) s.values.set(STORAGE_KEY, legacy);
  if (copy !== null && fpSource !== null) s.values.set(CUTOVER_SOURCE_COPY_PREFIX + fingerprintSource(fpSource), copy);
  s.values.set(CUTOVER_MARKER_KEY, marker(fpSource, phase));
  return s;
}
let host: HTMLElement | null = null; let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); host = null; root = null; });
async function mount(storage: Mem, download: (file: ExportFile) => void = () => undefined, state?: CutoverState) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const s = state ?? inspectCutoverState(storage);
  await act(async () => { root!.render(<RecoveryArchive state={s} storage={storage} download={download} />); });
  return s;
}
const q = (sel: string) => host!.querySelector(sel) as HTMLElement | null;
const buttons = () => Array.from(host!.querySelectorAll("button")) as HTMLButtonElement[];
const button = (text: string) => buttons().find((b) => b.textContent?.startsWith(text));
const click = async (el: HTMLElement | undefined | null) => { await act(async () => { el!.click(); }); };

describe("export helpers (pure)", () => {
  it("writes a well-formed stored value as exactly its UTF-8 bytes", () => {
    const raw = RAW + "é€😀\n  trailing  "; const file = prepareArchiveExport(raw, "x");
    expect(file.kind).toBe("raw-utf8"); expect(file.text).toBe(raw);
    expect(file.bytes).toBe(new TextEncoder().encode(raw).length);
    expect(new TextDecoder().decode(new TextEncoder().encode(file.text))).toBe(raw);
  });
  it("keeps unpaired surrogates exact by writing one JSON string literal", () => {
    for (const raw of ["a\uD800b", "\uDC00", "x\uD83D"]) {
      expect(isWellFormedUtf16(raw)).toBe(false);
      const file = prepareArchiveExport(raw, "x");
      expect(file.kind).toBe("json-string-literal"); expect(JSON.parse(file.text)).toBe(raw);
      expect(file.note).toContain("exactly");
    }
    expect(isWellFormedUtf16("😀")).toBe(true);
  });
  it("lists projects and tasks tolerantly and reports unparseable data without inventing a list", () => {
    const view = summarizeArchive(RAW); expect(view.ok && view.taskCount).toBe(2);
    expect(summarizeArchive("{nope").ok).toBe(false); expect(summarizeArchive("{}").ok).toBe(false);
    const odd = summarizeArchive(JSON.stringify([1, null, { name: 5, tasks: [{ title: 1 }, 3] }]));
    expect(odd.ok && odd.projects[0]?.name).toBe("(unnamed project)");
  });
});

describe("recovery / archive panel (S3)", () => {
  it("renders nothing in legacy mode", async () => {
    const s = new Mem(); s.values.set(STORAGE_KEY, RAW);
    await mount(s); expect(q('[data-testid="recovery-archive"]')).toBeNull();
    expect(archiveHeading({ mode: "legacy" })).toBeNull();
  });
  it.each(["intent", "profiles-verified", "stores-verified"] as const)("recovery phase %s: explains the state, lists legacy tasks read-only, exports the exact bytes, writes nothing", async (phase) => {
    const s = seeded(phase); const files: ExportFile[] = []; await mount(s, (f) => files.push(f));
    expect(q("h2")?.textContent).toContain("Recovery"); expect(q('[data-testid="recovery-archive"]')?.textContent).toContain(`phase "${phase}"`);
    expect(q('[data-testid="recovery-archive"]')?.textContent).toContain("What you can safely do next");
    expect(q('[data-testid="archive-source-preserved"]')?.textContent).toContain("2 projects, 2 tasks");
    expect(q('[data-testid="archive-source-preserved"]')?.textContent).toContain("Legacy task one (open)");
    expect(q('[data-testid="archive-source-preserved"]')?.textContent).toContain("Legacy task two (done)");
    expect(q('[data-testid="archive-source-current"]')).toBeNull();
    await click(button("Download raw data"));
    expect(files).toHaveLength(1); expect(files[0]!.text).toBe(RAW); expect(files[0]!.kind).toBe("raw-utf8");
    expect(q('[data-testid="archive-status"]')?.textContent).toContain(`${files[0]!.bytes} bytes`);
    expect(q('[data-testid="archive-failure"]')?.textContent).toBe("");
    expect(s.writes).toEqual([]); expect(s.removes).toEqual([]); expect(s.values.get(STORAGE_KEY)).toBe(RAW);
  });
  it("durable: says the durable workspace screen does not exist, keeps the archive read-only and exportable", async () => {
    const s = seeded("committed"); const files: ExportFile[] = []; await mount(s, (f) => files.push(f));
    const text = q('[data-testid="recovery-archive"]')!.textContent!;
    expect(text).toContain("no durable workspace screen"); expect(text).toContain("read-only archive"); expect(text).toContain("nothing here can edit, restore or delete");
    await click(button("Download raw data")); expect(files[0]!.text).toBe(RAW); expect(s.writes).toEqual([]);
  });
  it("indeterminate (source changed): shows BOTH sources, flags the difference, exports each exactly", async () => {
    const changed = RAW.replace("Second", "Edited by an old tab");
    const s = seeded("intent", { legacy: changed }); const files: ExportFile[] = []; const st = await mount(s, (f) => files.push(f));
    expect(st.mode).toBe("indeterminate");
    expect(q('[data-testid="recovery-archive"]')?.getAttribute("aria-labelledby")).toBe("recovery-archive-heading");
    expect(q('[data-testid="archive-source-preserved"]')).not.toBeNull(); expect(q('[data-testid="archive-source-current"]')).not.toBeNull();
    expect(q('[data-testid="archive-source-current"]')?.textContent).toContain("differs from the preserved copy");
    await click(buttons().find((b) => b.textContent?.includes("preserved legacy copy") && b.textContent.startsWith("Download")));
    await click(buttons().find((b) => b.textContent?.includes("current legacy workspace") && b.textContent.startsWith("Download")));
    expect(files.map((f) => f.text)).toEqual([RAW, changed]); expect(new Set(files.map((f) => f.filename)).size).toBe(2);
    expect(s.writes).toEqual([]);
  });
  it.each([["malformed marker", () => { const s = seeded("intent"); s.values.set(CUTOVER_MARKER_KEY, "{broken"); return s; }],
          ["missing preserved copy", () => seeded("intent", { copy: null })]] as const)("indeterminate (%s): alert tone, honest problem text, still offers the readable legacy data", async (_n, make) => {
    const s = make(); await mount(s);
    expect(q("section")?.textContent).toContain("cannot be verified"); expect(q("section")?.textContent).toContain("Download the raw data below before doing anything else");
    expect(q('[data-testid="archive-problem"]')?.textContent).toMatch(/cannot be read/);
    expect(q('[data-testid="archive-source-current"]')).not.toBeNull();
    expect(s.writes).toEqual([]);
  });
  it("unreadable storage: reports the problem, offers no export, and never claims success", async () => {
    const s = seeded("intent"); const state = inspectCutoverState(s); s.failReads = true;
    const files: ExportFile[] = []; await mount(s, (f) => files.push(f), state);
    expect(q('[data-testid="archive-problem"]')).not.toBeNull(); expect(button("Download")).toBeUndefined(); expect(files).toEqual([]);
    expect(q('[data-testid="archive-status"]')?.textContent).toBe("");
  });
  it("absent legacy source (fingerprint 'absent'): says there is nothing to export instead of a fake file", async () => {
    const s = seeded("intent", { legacy: null, copy: null, fp: null }); await mount(s);
    expect(q('[data-testid="archive-source-preserved"]')?.textContent).toContain("nothing to list or export"); expect(button("Download")).toBeUndefined();
  });
  it("a failing download is reported as a failure; no success message is shown", async () => {
    const s = seeded("intent"); await mount(s, () => { throw new Error("blocked by browser"); });
    await click(button("Download raw data"));
    expect(q('[data-testid="archive-failure"]')?.textContent).toContain("could not be prepared"); expect(q('[data-testid="archive-failure"]')?.textContent).toContain("Nothing was changed");
    expect(q('[data-testid="archive-status"]')?.textContent).toBe("");
  });
  it("raw text view is read-only, labelled, and toggles with aria-expanded", async () => {
    const s = seeded("committed"); await mount(s);
    const toggle = button("Show raw text")!; expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle); const area = q("textarea") as HTMLTextAreaElement;
    expect(area.readOnly).toBe(true); expect(area.value).toBe(RAW); expect(area.getAttribute("aria-label")).toContain("read-only");
    expect(button("Hide raw text")?.getAttribute("aria-expanded")).toBe("true");
  });
  it("has accessible status/alert regions from first render and no edit, restore, delete or release controls", async () => {
    const s = seeded("intent"); await mount(s);
    expect(q('[data-testid="archive-status"]')?.getAttribute("role")).toBe("status"); expect(q('[data-testid="archive-status"]')?.getAttribute("aria-live")).toBe("polite");
    expect(q('[data-testid="archive-failure"]')?.getAttribute("role")).toBe("alert");
    expect(host!.querySelectorAll("input").length).toBe(0); expect(host!.querySelectorAll("form").length).toBe(0);
    for (const b of buttons()) expect(b.textContent).toMatch(/^(Download raw data|Show raw text|Hide raw text)/);
    expect(host!.textContent).not.toMatch(/\b(Restore|Delete|Release|Prune|Resume)\b/);
  });
  it("loadArchiveSources only reads", () => {
    const s = seeded("intent"); loadArchiveSources(s); expect(s.writes).toEqual([]); expect(s.removes).toEqual([]);
    expect(loadArchiveSources(null).problems[0]).toContain("unavailable");
  });
});
