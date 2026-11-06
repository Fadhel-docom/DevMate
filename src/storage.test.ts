import { describe, expect, it } from "vitest";
import { BACKUP_KEY, MAX_BACKUPS, STORAGE_KEY, backupKey, getBrowserStorage, loadProjects, readProjects, saveProjects, type LoadResult, type Project, type SaveResult } from "./storage";
import { loadNotice, saveMessage } from "./App";

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

  it("never overwrites an existing backup: the new unreadable data goes to the next slot", () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, "{first");
    readProjects(storage);
    storage.setItem(STORAGE_KEY, "{second");
    const result = readProjects(storage);
    expect(result.backedUp).toBe(true);
    expect(result.backupKey).toBe(backupKey(2));
    expect(storage.getItem(BACKUP_KEY)).toBe("{first");
    expect(storage.getItem(backupKey(2))).toBe("{second");
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

/** Storage whose keys can be made to fail on write, backed by a plain in-memory map. */
function controllableStorage(failWrite: (key: string) => boolean) {
  const base = memoryStorage();
  return {
    base,
    storage: {
      getItem: base.getItem,
      setItem: (key: string, value: string) => {
        if (failWrite(key)) throw domError("QuotaExceededError", 22);
        base.setItem(key, value);
      }
    }
  };
}

const isBackupKey = (key: string) => key.startsWith(BACKUP_KEY);

describe("multiple unreadable backups", () => {
  it("keeps the first unreadable copy under the original backup key", () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, "{one");
    const result = readProjects(storage);
    expect(result.backedUp).toBe(true);
    expect(result.backupKey).toBe(BACKUP_KEY);
    expect(storage.getItem(BACKUP_KEY)).toBe("{one");
    expect(storage.getItem(backupKey(2))).toBeNull();
  });

  it("keeps a second copy without replacing the first", () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, "{one");
    readProjects(storage);
    storage.setItem(STORAGE_KEY, "{two");
    readProjects(storage);
    expect(storage.getItem(BACKUP_KEY)).toBe("{one");
    expect(storage.getItem(backupKey(2))).toBe("{two");
  });

  it("keeps a third copy without replacing the first two", () => {
    const storage = memoryStorage();
    for (const raw of ["{one", "{two", "{three"]) {
      storage.setItem(STORAGE_KEY, raw);
      expect(readProjects(storage).backedUp).toBe(true);
    }
    expect(storage.getItem(BACKUP_KEY)).toBe("{one");
    expect(storage.getItem(backupKey(2))).toBe("{two");
    expect(storage.getItem(backupKey(3))).toBe("{three");
  });

  it("keeps a backup written by the previous version and adds new ones beside it", () => {
    const storage = memoryStorage();
    storage.setItem(BACKUP_KEY, "{written by the old version");
    storage.setItem(STORAGE_KEY, "{new damage");
    const result = readProjects(storage);
    expect(result.backupKey).toBe(backupKey(2));
    expect(storage.getItem(BACKUP_KEY)).toBe("{written by the old version");
    expect(storage.getItem(backupKey(2))).toBe("{new damage");
  });

  it("does not lose or duplicate copies when the same data is read repeatedly", () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, "{one");
    readProjects(storage);
    storage.setItem(STORAGE_KEY, "{two");
    for (let i = 0; i < 4; i += 1) {
      const result = readProjects(storage);
      expect(result.backedUp).toBe(true);
      expect(result.backupKey).toBe(backupKey(2));
    }
    expect(storage.getItem(BACKUP_KEY)).toBe("{one");
    expect(storage.getItem(backupKey(2))).toBe("{two");
    expect(storage.getItem(backupKey(3))).toBeNull();
  });

  it("recognises an identical copy that is already stored in a later slot", () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, "{one");
    readProjects(storage);
    storage.setItem(STORAGE_KEY, "{two");
    readProjects(storage);
    storage.setItem(STORAGE_KEY, "{one");
    const result = readProjects(storage);
    expect(result.backupKey).toBe(BACKUP_KEY);
    expect(storage.getItem(backupKey(3))).toBeNull();
  });

  it("backs up partly recovered data too", () => {
    const storage = memoryStorage();
    const raw = JSON.stringify([sample[0], { id: "bad" }]);
    storage.setItem(STORAGE_KEY, raw);
    const result = readProjects(storage);
    expect(result.status).toBe("recovered");
    expect(result.backupKey).toBe(BACKUP_KEY);
    expect(storage.getItem(BACKUP_KEY)).toBe(raw);
  });

  it("reports no backup, and keeps every existing copy, when storage is full", () => {
    const { base, storage } = controllableStorage(isBackupKey);
    base.setItem(BACKUP_KEY, "{first");
    base.setItem(STORAGE_KEY, "{second");
    const result = readProjects(storage);
    expect(result.status).toBe("corrupt");
    expect(result.backedUp).toBe(false);
    expect(result.backupKey).toBeNull();
    expect(base.getItem(BACKUP_KEY)).toBe("{first");
    expect(base.getItem(backupKey(2))).toBeNull();
    expect(base.getItem(STORAGE_KEY)).toBe("{second");
  });

  it("does not claim a backup when the write silently stores nothing", () => {
    const base = memoryStorage();
    base.setItem(STORAGE_KEY, "{broken");
    const result = readProjects({ getItem: base.getItem, setItem: () => undefined });
    expect(result.backedUp).toBe(false);
    expect(result.backupKey).toBeNull();
  });

  it("does not throw or claim a backup when reading the backup slots fails", () => {
    const storage = {
      getItem: (key: string) => {
        if (key === STORAGE_KEY) return "{broken";
        throw domError("SecurityError");
      },
      setItem: () => undefined
    };
    const result = readProjects(storage);
    expect(result.status).toBe("corrupt");
    expect(result.backedUp).toBe(false);
  });

  it("does not claim a backup for a read-only storage", () => {
    const result = readProjects({ getItem: (key: string) => (key === STORAGE_KEY ? "{broken" : null) });
    expect(result.backedUp).toBe(false);
  });

  it("stops at the slot limit without overwriting any copy", () => {
    const storage = memoryStorage();
    for (let slot = 1; slot <= MAX_BACKUPS; slot += 1) storage.setItem(backupKey(slot), `{copy ${slot}`);
    storage.setItem(STORAGE_KEY, "{one more");
    const result = readProjects(storage);
    expect(result.backedUp).toBe(false);
    expect(result.backupKey).toBeNull();
    for (let slot = 1; slot <= MAX_BACKUPS; slot += 1) expect(storage.getItem(backupKey(slot))).toBe(`{copy ${slot}`);
    expect(storage.getItem(backupKey(MAX_BACKUPS + 1))).toBeNull();
    expect(storage.getItem(STORAGE_KEY)).toBe("{one more");
  });
});

describe("protecting unreadable originals when saving", () => {
  const next: Project[] = [...sample, { id: "p3", name: "Third", tasks: [] }];

  function expectRefused(result: SaveResult) {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("protect-original");
  }

  it("refuses to replace corrupt JSON when the backup cannot be saved, and leaves the original untouched", () => {
    const { base, storage } = controllableStorage(isBackupKey);
    base.setItem(STORAGE_KEY, "{broken");
    expect(readProjects(storage).backedUp).toBe(false);
    expectRefused(saveProjects(next, storage));
    expect(base.getItem(STORAGE_KEY)).toBe("{broken");
    expect(base.getItem(BACKUP_KEY)).toBeNull();
  });

  it("refuses to replace partly recovered data when the backup cannot be saved", () => {
    const { base, storage } = controllableStorage(isBackupKey);
    const raw = JSON.stringify([sample[0], { id: "bad", tasks: [] }, 7]);
    base.setItem(STORAGE_KEY, raw);
    const loaded = readProjects(storage);
    expect(loaded.status).toBe("recovered");
    expect(loaded.backedUp).toBe(false);
    expectRefused(saveProjects(loaded.projects, storage));
    expect(base.getItem(STORAGE_KEY)).toBe(raw);
  });

  it("refuses to replace valid JSON with the wrong structure when the backup cannot be saved", () => {
    const { base, storage } = controllableStorage(isBackupKey);
    base.setItem(STORAGE_KEY, "{}");
    expectRefused(saveProjects(next, storage));
    expect(base.getItem(STORAGE_KEY)).toBe("{}");
  });

  it("refuses when the backup slots are full", () => {
    const base = memoryStorage();
    for (let slot = 1; slot <= MAX_BACKUPS; slot += 1) base.setItem(backupKey(slot), `{copy ${slot}`);
    base.setItem(STORAGE_KEY, "{broken");
    expectRefused(saveProjects(next, base));
    expect(base.getItem(STORAGE_KEY)).toBe("{broken");
  });

  it("backs the original up first on a later save when storage has room again, then saves", () => {
    let full = true;
    const { base, storage } = controllableStorage((key) => full && isBackupKey(key));
    base.setItem(STORAGE_KEY, "{broken");
    expectRefused(saveProjects(next, storage));
    expect(base.getItem(STORAGE_KEY)).toBe("{broken");
    full = false;
    expect(saveProjects(next, storage)).toEqual({ ok: true, backupKey: BACKUP_KEY });
    expect(base.getItem(BACKUP_KEY)).toBe("{broken");
    expect(loadProjects(base)).toEqual(next);
  });

  it("replaces the original only after the backup exists, and the backup keeps the original text", () => {
    const base = memoryStorage();
    const raw = JSON.stringify([sample[0], { id: "bad" }]);
    base.setItem(STORAGE_KEY, raw);
    readProjects(base);
    expect(saveProjects(next, base)).toEqual({ ok: true, backupKey: BACKUP_KEY });
    expect(base.getItem(BACKUP_KEY)).toBe(raw);
    expect(loadProjects(base)).toEqual(next);
  });

  it("keeps the original when the backup succeeds but the main write then fails", () => {
    const { base, storage } = controllableStorage((key) => key === STORAGE_KEY);
    base.setItem(STORAGE_KEY, "{broken");
    const result = saveProjects(next, storage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("quota");
    expect(base.getItem(STORAGE_KEY)).toBe("{broken");
    expect(base.getItem(BACKUP_KEY)).toBe("{broken");
  });

  it("refuses to write when the stored value cannot be read, and never calls setItem", () => {
    let writes = 0;
    const storage = {
      getItem: () => { throw domError("SecurityError"); },
      setItem: () => { writes += 1; }
    };
    const result = saveProjects(next, storage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unavailable");
    expect(writes).toBe(0);
  });

  it("does not create any backup when the stored data is valid", () => {
    const base = memoryStorage();
    expect(saveProjects(sample, base)).toEqual({ ok: true });
    expect(saveProjects(next, base)).toEqual({ ok: true });
    expect(base.getItem(BACKUP_KEY)).toBeNull();
  });

  it("does not create any backup when nothing meaningful is stored", () => {
    for (const stored of [null, "", "[]"]) {
      const base = memoryStorage();
      if (stored !== null) base.setItem(STORAGE_KEY, stored);
      expect(saveProjects(next, base)).toEqual({ ok: true });
      expect(base.getItem(BACKUP_KEY)).toBeNull();
    }
  });

  it("does not touch storage at all when the data to save is invalid", () => {
    const { base, storage } = controllableStorage(() => false);
    base.setItem(STORAGE_KEY, "{broken");
    const bad = [{ id: "x", name: "bad", tasks: "no" }] as unknown as Project[];
    const result = saveProjects(bad, storage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-data");
    expect(base.getItem(STORAGE_KEY)).toBe("{broken");
    expect(base.getItem(BACKUP_KEY)).toBeNull();
  });

  it("keeps the previous data and reports verify when the write does not stick", () => {
    const base = memoryStorage();
    expect(saveProjects(sample, base)).toEqual({ ok: true });
    const lossy = { getItem: base.getItem, setItem: () => undefined };
    const result = saveProjects(next, lossy);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("verify");
    expect(loadProjects(base)).toEqual(sample);
  });

  it("reports verify when reading the value back throws", () => {
    const base = memoryStorage();
    let reads = 0;
    const storage = {
      getItem: (key: string) => {
        reads += 1;
        if (reads > 1) throw domError("SecurityError");
        return base.getItem(key);
      },
      setItem: base.setItem
    };
    const result = saveProjects(sample, storage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("verify");
  });
});

describe("messages shown to the user", () => {
  const loaded = (overrides: Partial<LoadResult>): LoadResult => ({
    projects: [],
    status: "ok",
    droppedProjects: 0,
    droppedTasks: 0,
    repairedProjects: 0,
    backedUp: false,
    backupKey: null,
    ...overrides
  });

  it("shows nothing for healthy or empty storage", () => {
    expect(loadNotice(loaded({ status: "ok" }))).toBeNull();
    expect(loadNotice(loaded({ status: "empty" }))).toBeNull();
  });

  for (const status of ["corrupt", "invalid"] as const) {
    it(`says a copy was saved for ${status} data only when one exists`, () => {
      const saved = loadNotice(loaded({ status, backedUp: true, backupKey: BACKUP_KEY })) ?? "";
      expect(saved).toContain("A copy of the unreadable data was saved");
      const notSaved = loadNotice(loaded({ status })) ?? "";
      expect(notSaved).toContain("backup copy could not be saved");
      expect(notSaved).toContain("left untouched");
      expect(notSaved).toContain("will not be saved");
      expect(notSaved).not.toContain("copy of the unreadable data was saved");
    });
  }

  it("distinguishes partly recovered data with and without a saved copy", () => {
    const base = { status: "recovered" as const, droppedProjects: 2, droppedTasks: 1, repairedProjects: 0 };
    const saved = loadNotice(loaded({ ...base, backedUp: true, backupKey: BACKUP_KEY })) ?? "";
    expect(saved).toContain("2 projects, 1 tasks");
    expect(saved).toContain("A copy of the original data was saved");
    const notSaved = loadNotice(loaded(base)) ?? "";
    expect(notSaved).toContain("2 projects, 1 tasks");
    expect(notSaved).toContain("backup copy could not be saved");
    expect(notSaved).not.toContain("copy of the original data was saved");
  });

  it("says storage is unavailable without mentioning any saved copy", () => {
    const text = loadNotice(loaded({ status: "unavailable" })) ?? "";
    expect(text).toContain("unavailable");
    expect(text).not.toContain("copy");
  });

  it("explains each save failure and never says the changes were saved", () => {
    const reasons = ["quota", "unavailable", "protect-original", "verify", "invalid-data", "serialize", "unknown"] as const;
    const texts = reasons.map((reason) => saveMessage({ ok: false, reason, message: "x" }));
    for (const text of texts) {
      expect(text).toContain("Your latest changes were not saved.");
      expect(text).toContain("may be lost");
    }
    expect(saveMessage({ ok: false, reason: "quota", message: "x" })).toContain("full");
    expect(saveMessage({ ok: false, reason: "unavailable", message: "x" })).toContain("unavailable or blocked");
    const protectedText = saveMessage({ ok: false, reason: "protect-original", message: "x" });
    expect(protectedText).toContain("could not be copied to a backup");
    expect(protectedText).toContain("left untouched");
    expect(saveMessage({ ok: false, reason: "verify", message: "x" })).toContain("could not be read back");
  });
});
