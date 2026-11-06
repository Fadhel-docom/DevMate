import { describe, expect, it } from "vitest";
import { BACKUP_KEY, STORAGE_KEY, getBrowserStorage, loadProjects, readProjects, saveProjects, type Project } from "./storage";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  };
}

function domError(name: string, code = 0) {
  const error = new Error(name);
  error.name = name;
  (error as Error & { code: number }).code = code;
  return error;
}

const sample: Project[] = [
  { id: "p1", name: "RateNest sandbox", tasks: [{ id: "t1", title: "Write tests", done: true, createdAt: 1700000000000 }] },
  { id: "p2", name: "Second", tasks: [] }
];

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

describe("valid data", () => {
  it("round-trips projects with tasks unchanged and reports ok", () => {
    const storage = memoryStorage();
    expect(saveProjects(sample, storage)).toEqual({ ok: true });
    const result = readProjects(storage);
    expect(result.status).toBe("ok");
    expect(result.projects).toEqual(sample);
    expect(result.backedUp).toBe(false);
  });

  it("loads data written by the previous version of the app", () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify(sample));
    expect(readProjects(storage).status).toBe("ok");
    expect(loadProjects(storage)).toEqual(sample);
  });

  it("treats an empty stored list as empty and returns the starter project", () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, "[]");
    const result = readProjects(storage);
    expect(result.status).toBe("empty");
    expect(result.projects[0].id).toBe("starter");
  });
});

describe("storage unavailable", () => {
  it("does not throw when getItem throws", () => {
    const storage = { getItem: () => { throw domError("SecurityError"); } };
    const result = readProjects(storage);
    expect(result.status).toBe("unavailable");
    expect(result.projects[0].id).toBe("starter");
    expect(loadProjects(storage)[0].id).toBe("starter");
  });

  it("handles missing storage on load and save", () => {
    expect(readProjects(null).status).toBe("unavailable");
    expect(loadProjects(null)[0].id).toBe("starter");
    const saved = saveProjects(sample, null);
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.reason).toBe("unavailable");
  });

  it("returns null when reading window.localStorage itself throws", () => {
    const host = {
      get localStorage(): Storage {
        throw domError("SecurityError");
      }
    };
    expect(getBrowserStorage(host)).toBeNull();
    expect(getBrowserStorage({})).toBeNull();
  });
});

describe("corrupt JSON", () => {
  it("returns the starter project, reports corrupt, and keeps the raw text in a backup", () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, "{broken");
    const result = readProjects(storage);
    expect(result.status).toBe("corrupt");
    expect(result.projects[0].id).toBe("starter");
    expect(result.backedUp).toBe(true);
    expect(storage.getItem(BACKUP_KEY)).toBe("{broken");
  });

  it("never overwrites an existing backup", () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, "{first");
    readProjects(storage);
    storage.setItem(STORAGE_KEY, "{second");
    const result = readProjects(storage);
    expect(result.backedUp).toBe(false);
    expect(storage.getItem(BACKUP_KEY)).toBe("{first");
  });

  it("still loads when the backup cannot be written", () => {
    const storage = {
      getItem: (key: string) => (key === STORAGE_KEY ? "{broken" : null),
      setItem: () => { throw domError("QuotaExceededError", 22); }
    };
    const result = readProjects(storage);
    expect(result.status).toBe("corrupt");
    expect(result.backedUp).toBe(false);
  });
});

describe("valid JSON with the wrong structure", () => {
  const wrongShapes = ["{}", "42", "\"text\"", "null", "true", "[1,\"a\",null]", "[{\"id\":1,\"name\":\"x\",\"tasks\":[]}]", "[{\"name\":\"no id\",\"tasks\":[]}]"];
  for (const raw of wrongShapes) {
    it(`does not treat ${raw} as valid projects`, () => {
      const storage = memoryStorage();
      storage.setItem(STORAGE_KEY, raw);
      const result = readProjects(storage);
      expect(result.status).toBe("invalid");
      expect(result.projects[0].id).toBe("starter");
      expect(storage.getItem(BACKUP_KEY)).toBe(raw);
    });
  }

  it("keeps valid projects and drops invalid ones", () => {
    const storage = memoryStorage();
    const raw = JSON.stringify([sample[0], { id: "bad", tasks: [] }, 7, sample[1]]);
    storage.setItem(STORAGE_KEY, raw);
    const result = readProjects(storage);
    expect(result.status).toBe("recovered");
    expect(result.projects).toEqual(sample);
    expect(result.droppedProjects).toBe(2);
    expect(storage.getItem(BACKUP_KEY)).toBe(raw);
  });

  it("drops tasks with missing or wrongly typed fields", () => {
    const storage = memoryStorage();
    const good = { id: "t1", title: "ok", done: false, createdAt: 5 };
    const tasks = [
      good,
      { id: "t2", title: "no done", createdAt: 5 },
      { id: "t3", title: "done is a string", done: "yes", createdAt: 5 },
      { id: "t4", title: 123, done: false, createdAt: 5 },
      { id: "", title: "empty id", done: false, createdAt: 5 },
      { id: "t6", title: "no createdAt", done: false },
      { id: "t7", title: "createdAt null", done: false, createdAt: null },
      "not an object"
    ];
    storage.setItem(STORAGE_KEY, JSON.stringify([{ id: "p1", name: "P", tasks }]));
    const result = readProjects(storage);
    expect(result.status).toBe("recovered");
    expect(result.projects).toEqual([{ id: "p1", name: "P", tasks: [good] }]);
    expect(result.droppedTasks).toBe(7);
  });

  it("keeps a project with a missing tasks list and gives it an empty one", () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify([{ id: "p1", name: "No tasks field" }, { id: "p2", name: "Bad tasks", tasks: "x" }]));
    const result = readProjects(storage);
    expect(result.status).toBe("recovered");
    expect(result.projects).toEqual([{ id: "p1", name: "No tasks field", tasks: [] }, { id: "p2", name: "Bad tasks", tasks: [] }]);
    expect(result.repairedProjects).toBe(2);
  });

  it("drops duplicate project and task ids", () => {
    const storage = memoryStorage();
    const task = { id: "t1", title: "a", done: false, createdAt: 1 };
    storage.setItem(STORAGE_KEY, JSON.stringify([
      { id: "p1", name: "first", tasks: [task, { ...task, title: "dup" }] },
      { id: "p1", name: "duplicate project", tasks: [] }
    ]));
    const result = readProjects(storage);
    expect(result.projects).toEqual([{ id: "p1", name: "first", tasks: [task] }]);
    expect(result.droppedProjects).toBe(1);
    expect(result.droppedTasks).toBe(1);
  });

  it("copies only known fields and ignores a __proto__ key", () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, "[{\"id\":\"p1\",\"name\":\"P\",\"tasks\":[],\"extra\":1,\"__proto__\":{\"polluted\":true}}]");
    const result = readProjects(storage);
    expect(result.projects).toEqual([{ id: "p1", name: "P", tasks: [] }]);
    expect(({} as { polluted?: boolean }).polluted).toBe(undefined);
    expect((result.projects[0] as { polluted?: boolean }).polluted).toBe(undefined);
  });
});

describe("save failures", () => {
  it("reports quota errors and keeps the previously saved data", () => {
    const base = memoryStorage();
    expect(saveProjects(sample, base)).toEqual({ ok: true });
    const full = { getItem: base.getItem, setItem: () => { throw domError("QuotaExceededError", 22); } };
    const next: Project[] = [...sample, { id: "p3", name: "Third", tasks: [] }];
    const result = saveProjects(next, full);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("quota");
    expect(loadProjects(base)).toEqual(sample);
  });

  it("recognises the Firefox quota error name", () => {
    const storage = { setItem: () => { throw domError("NS_ERROR_DOM_QUOTA_REACHED", 1014); } };
    const result = saveProjects(sample, storage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("quota");
  });

  it("reports a blocked storage as unavailable", () => {
    const storage = { setItem: () => { throw domError("SecurityError"); } };
    const result = saveProjects(sample, storage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unavailable");
  });

  it("reports unknown errors without throwing", () => {
    const storage = { setItem: () => { throw new Error("boom"); } };
    const result = saveProjects(sample, storage);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unknown");
      expect(result.message).toBe("boom");
    }
  });

  it("does not report success when the data cannot be read back", () => {
    const storage = { getItem: () => null, setItem: () => undefined };
    const result = saveProjects(sample, storage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("verify");
  });

  it("succeeds with a storage that only offers setItem", () => {
    const values = new Map<string, string>();
    expect(saveProjects(sample, { setItem: (key: string, value: string) => values.set(key, value) })).toEqual({ ok: true });
    expect(values.get(STORAGE_KEY)).toBe(JSON.stringify(sample));
  });

  it("refuses to write data that does not match the project format", () => {
    const storage = memoryStorage();
    saveProjects(sample, storage);
    const bad = [{ id: "x", name: "bad", tasks: [{ id: "t", title: "t", done: "no", createdAt: 1 }] }] as unknown as Project[];
    const result = saveProjects(bad, storage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-data");
    expect(loadProjects(storage)).toEqual(sample);
  });
});
