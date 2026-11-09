/** Read-only archive export helpers (S3). Nothing here writes browser storage. */
export type ExportFile = {
  kind: "raw-utf8" | "json-string-literal";
  filename: string;
  mime: string;
  text: string;
  /** Size of the bytes that will be written to the file (UTF-8). */
  bytes: number;
  note: string;
};
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const isWellFormedUtf16 = (value: string): boolean => !UNPAIRED_SURROGATE.test(value);

/**
 * Byte-preserving export. A well-formed string is written as-is (UTF-8, no BOM, no normalisation), so the file
 * bytes are exactly the UTF-8 encoding of the stored value. A stored value with unpaired surrogates cannot be
 * represented in UTF-8 without replacement characters, so it is written as one JSON string literal instead:
 * JSON.parse of the file returns the stored value exactly, and the note says so.
 */
export function prepareArchiveExport(raw: string, label: string): ExportFile {
  const encoder = new TextEncoder();
  if (isWellFormedUtf16(raw)) {
    return { kind: "raw-utf8", filename: `devmate-legacy-${label}.txt`, mime: "text/plain;charset=utf-8", text: raw, bytes: encoder.encode(raw).length,
      note: "The file contains the stored text exactly as saved." };
  }
  const text = JSON.stringify(raw);
  return { kind: "json-string-literal", filename: `devmate-legacy-${label}.json`, mime: "application/json;charset=utf-8", text, bytes: encoder.encode(text).length,
    note: "The stored text contains characters that cannot be written as plain UTF-8, so it is saved as one JSON string. Parsing the file as JSON returns the stored text exactly." };
}

export function browserDownload(file: ExportFile): void {
  const blob = new Blob([file.text], { type: file.mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = file.filename;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type ArchiveProject = { id: string; name: string; tasks: { id: string; title: string; done: boolean }[] };
export type ArchiveView = { ok: true; projects: ArchiveProject[]; taskCount: number } | { ok: false; message: string };
/** Tolerant, read-only parse for display only. The raw export is always the authoritative copy. */
export function summarizeArchive(raw: string): ArchiveView {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ok: false, message: "The saved data is not valid JSON, so it cannot be listed. The raw export still contains it exactly." }; }
  if (!Array.isArray(value)) return { ok: false, message: "The saved data is not a list of projects, so it cannot be listed. The raw export still contains it exactly." };
  const projects: ArchiveProject[] = []; let taskCount = 0;
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const tasks = Array.isArray(record.tasks) ? record.tasks : [];
    const listed = tasks.flatMap((task) => {
      if (typeof task !== "object" || task === null) return [];
      const t = task as Record<string, unknown>;
      return [{ id: typeof t.id === "string" ? t.id : "", title: typeof t.title === "string" ? t.title : "(untitled task)", done: t.done === true }];
    });
    taskCount += listed.length;
    projects.push({ id: typeof record.id === "string" ? record.id : "", name: typeof record.name === "string" ? record.name : "(unnamed project)", tasks: listed });
  }
  return { ok: true, projects, taskCount };
}
