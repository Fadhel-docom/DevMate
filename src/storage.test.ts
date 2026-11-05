import { describe, expect, it } from "vitest";
import { loadProjects, saveProjects, type Project } from "./storage";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  };
}

describe("project persistence", () => {
  it("returns a starter project when storage is empty", () => {
    expect(loadProjects(memoryStorage())[0].id).toBe("starter");
  });

  it("saves and restores projects", () => {
    const storage = memoryStorage();
    const projects: Project[] = [{ id: "p1", name: "RateNest sandbox", tasks: [] }];
    saveProjects(projects, storage);
    expect(loadProjects(storage)).toEqual(projects);
  });

  it("recovers safely from invalid stored JSON", () => {
    const storage = memoryStorage();
    storage.setItem("devmate-workspace-v1", "{broken");
    expect(loadProjects(storage)[0].id).toBe("starter");
  });
});