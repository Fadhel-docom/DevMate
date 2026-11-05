export type Task = { id: string; title: string; done: boolean; createdAt: number };
export type Project = { id: string; name: string; tasks: Task[] };

const STORAGE_KEY = "devmate-workspace-v1";
const starter: Project[] = [{ id: "starter", name: "My first project", tasks: [] }];

export function loadProjects(storage: Pick<Storage, "getItem"> = localStorage): Project[] {
  try {
    const value = storage.getItem(STORAGE_KEY);
    if (!value) return starter;
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0) return starter;
    return parsed as Project[];
  } catch {
    return starter;
  }
}

export function saveProjects(projects: Project[], storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(projects));
}