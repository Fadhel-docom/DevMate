import { describe, expect, it } from "vitest";
import {
  migrateLegacyProjectsToProfiles,
  validateProjectProfilesStore,
  type ProjectProfilesStore
} from "./projectProfiles";

describe("project profile schema v1", () => {
  it("creates a versioned, unapproved draft without inferring repository facts", () => {
    const migrated = migrateLegacyProjectsToProfiles([{ id: "p1", name: "RateNest" }], 1234);
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.records[0]).toMatchObject({
      projectId: "p1",
      identity: { name: "RateNest", purpose: "" },
      lifecycle: "draft",
      repositories: [],
      dataClassification: "unknown",
      approval: { status: "unapproved", approvedRevision: null, evidence: null, approvedAt: null }
    });
    expect(migrated.records[0].unknownFields).toContain("repositories");
  });

  it("is deterministic and idempotent for the same legacy input and timestamp", () => {
    const legacy = [{ id: "p1", name: "Project one" }];
    expect(migrateLegacyProjectsToProfiles(legacy, 1234)).toEqual(
      migrateLegacyProjectsToProfiles(legacy, 1234)
    );
  });

  it("rejects duplicate legacy project IDs", () => {
    expect(() => migrateLegacyProjectsToProfiles([
      { id: "p1", name: "One" },
      { id: "p1", name: "Duplicate" }
    ], 1234)).toThrow(/unique/);
  });

  it("accepts a valid generated store", () => {
    const store = migrateLegacyProjectsToProfiles([{ id: "p1", name: "One" }], 1234);
    expect(validateProjectProfilesStore(store)).toMatchObject({ ok: true });
  });

  it("rejects future schema versions without interpreting them as v1", () => {
    const result = validateProjectProfilesStore({ schemaVersion: 2, revision: 1, updatedAt: 1, records: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].path).toBe("schemaVersion");
  });

  it("rejects duplicate profile IDs", () => {
    const profile = migrateLegacyProjectsToProfiles([{ id: "p1", name: "One" }], 1234).records[0];
    const store: ProjectProfilesStore = {
      schemaVersion: 1,
      revision: 1,
      updatedAt: 1234,
      records: [profile, { ...profile }]
    };
    const result = validateProjectProfilesStore(store);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((error) => error.message.includes("Duplicate"))).toBe(true);
  });

  it("rejects approval metadata that does not match the current profile revision", () => {
    const store = migrateLegacyProjectsToProfiles([{ id: "p1", name: "One" }], 1234);
    const profile = store.records[0];
    profile.approval = {
      status: "approved",
      approvedRevision: 1,
      evidence: { kind: "owner-decision", reference: "decision-1", commitSha: null },
      approvedAt: 1234
    };
    profile.profileRevision = 2;
    const result = validateProjectProfilesStore(store);
    expect(result.ok).toBe(false);
  });

  it("rejects dangerous object keys in extension data", () => {
    const store = migrateLegacyProjectsToProfiles([{ id: "p1", name: "One" }], 1234);
    store.records[0].extensions = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(validateProjectProfilesStore(store).ok).toBe(false);
  });
});
