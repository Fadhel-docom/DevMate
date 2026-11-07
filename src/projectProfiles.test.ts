import { describe, expect, it } from "vitest";
import {
  computeProfileContentHash,
  migrateLegacyProjectsToProfiles,
  validateProjectProfilesStore,
  type ProjectProfile,
  type ProjectProfilesStore
} from "./projectProfiles";

function draftStore(): ProjectProfilesStore {
  return migrateLegacyProjectsToProfiles([{ id: "p1", name: "One" }], 1234).store;
}
function approve(profile: ProjectProfile): void {
  profile.approval = {
    status: "approved", approvedRevision: profile.profileRevision,
    evidence: { kind: "approved-pull-request", reference: "https://github.com/org/repo/pull/1", commitSha: "a".repeat(40) },
    approvedAt: 1300, approvedContentHash: computeProfileContentHash(profile),
    revokedAt: null, revokedRevision: null, revocationReason: null
  };
}
describe("project profile schema v1", () => {
  it("creates a versioned, unapproved draft without inferring repository facts", () => {
    const migrated = draftStore();
    expect(migrated.records[0]).toMatchObject({
      projectId: "p1", identity: { name: "One", purpose: "" }, lifecycle: "draft",
      repositories: [], dataClassification: "unknown",
      approval: { status: "unapproved", approvedRevision: null, evidence: null, approvedContentHash: null }
    });
    expect(migrated.records[0].unknownFields).toContain("repositories");
  });
  it("adds only missing legacy profiles and preserves existing approved records byte-for-byte", () => {
    const existing = draftStore();
    approve(existing.records[0]);
    const before = JSON.stringify(existing.records[0]);
    const result = migrateLegacyProjectsToProfiles([{ id: "p1", name: "Changed name" }, { id: "p2", name: "Two" }], 2000, existing);
    expect(result.rejected).toEqual([]);
    expect(JSON.stringify(result.store.records[0])).toBe(before);
    expect(result.store.records.map((p) => p.projectId)).toEqual(["p1", "p2"]);
    expect(result.store.revision).toBe(existing.revision + 1);
  });
  it("is idempotent against an existing store even when the retry timestamp changes", () => {
    const first = draftStore();
    const second = migrateLegacyProjectsToProfiles([{ id: "p1", name: "One" }], 9999, first);
    expect(second.store).toEqual(first);
  });
  it("uses a deterministic fallback name for blank legacy names and reports malformed entries", () => {
    const result = migrateLegacyProjectsToProfiles([{ id: "p1", name: "" }, null, { id: 2, name: "Bad" }], 1234);
    expect(result.store.records[0].identity.name).toBe("Legacy project p1");
    expect(result.store.records[0].unknownFields).toContain("identity.name");
    expect(result.rejected).toHaveLength(2);
  });
  it("rejects unsafe legacy IDs and duplicate profile IDs", () => {
    const unsafe = migrateLegacyProjectsToProfiles([{ id: "__proto__", name: "Bad" }], 1234);
    expect(unsafe.rejected).toHaveLength(1);
    const profile = draftStore().records[0];
    const duplicate = { schemaVersion: 1, revision: 1, updatedAt: 1234, records: [profile, { ...profile }] };
    const result = validateProjectProfilesStore(duplicate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((item) => item.message.includes("Duplicate"))).toBe(true);
  });
  it("rejects a profile whose content changes without invalidating its approval", () => {
    const store = draftStore();
    approve(store.records[0]);
    store.records[0].allowedTools.push("shell");
    const result = validateProjectProfilesStore(store);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((item) => item.path === "records[0].approval")).toBe(true);
  });
  it("rejects invalid enum types, unknown keys, and malformed PR commit SHAs", () => {
    const store = draftStore();
    const malformed = JSON.parse(JSON.stringify(store));
    malformed.records[0].lifecycle = ["draft"];
    expect(validateProjectProfilesStore(malformed).ok).toBe(false);
    const unknown = JSON.parse(JSON.stringify(store));
    unknown.records[0].approval.hidden = true;
    expect(validateProjectProfilesStore(unknown).ok).toBe(false);
    const badSha = draftStore();
    badSha.records[0].approval = {
      status: "approved", approvedRevision: 1,
      evidence: { kind: "approved-pull-request", reference: "PR #1", commitSha: "bad" },
      approvedAt: 1234, approvedContentHash: "0000000000000000",
      revokedAt: null, revokedRevision: null, revocationReason: null
    };
    expect(validateProjectProfilesStore(badSha).ok).toBe(false);
  });
  it("preserves revoked approval evidence and revocation history", () => {
    const store = draftStore();
    approve(store.records[0]);
    const oldApproval = store.records[0].approval;
    store.records[0].approval = {
      ...oldApproval, status: "revoked", revokedAt: 1400,
      revokedRevision: oldApproval.approvedRevision, revocationReason: "Policy changed"
    };
    expect(validateProjectProfilesStore(store).ok).toBe(true);
  });
  it("rejects unsafe extension keys and non-plain objects", () => {
    const store = draftStore();
    store.records[0].extensions = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(validateProjectProfilesStore(store).ok).toBe(false);
    const withDate = draftStore() as unknown as { records: Array<Record<string, unknown>> };
    withDate.records[0].extensions = { date: new Date() };
    expect(validateProjectProfilesStore(withDate).ok).toBe(false);
  });
});
