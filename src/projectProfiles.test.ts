// Regression coverage for the accepted profile contract and additive migration.
import { describe, expect, it } from "vitest";
import {
  computeProfileContentHash,
  migrateLegacyProjectsToProfiles,
  validateProjectProfilesStore,
  validateProfileApprovalHistoryUpdate,
  validateProjectProfilesStoreUpdate,
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
    revokedAt: null, revokedRevision: null, revocationReason: null, revocationHistory: []
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
      approvedAt: 1234, approvedContentHash: computeProfileContentHash(badSha.records[0]),
      revokedAt: null, revokedRevision: null, revocationReason: null, revocationHistory: []
    };
    for (const malformedSha of ["a".repeat(39), "a".repeat(41), "a".repeat(64)]) {
      const invalidSha = draftStore();
      invalidSha.records[0].approval = {
        status: "approved", approvedRevision: 1,
        evidence: { kind: "approved-pull-request", reference: "PR #1", commitSha: malformedSha },
        approvedAt: 1234, approvedContentHash: computeProfileContentHash(invalidSha.records[0]),
        revokedAt: null, revokedRevision: null, revocationReason: null, revocationHistory: []
      };
      expect(validateProjectProfilesStore(invalidSha).ok).toBe(false);
    }
    const uppercaseSha = draftStore();
    uppercaseSha.records[0].approval = {
      status: "approved", approvedRevision: 1,
      evidence: { kind: "approved-pull-request", reference: "PR #1", commitSha: "A".repeat(40) },
      approvedAt: 1234, approvedContentHash: computeProfileContentHash(uppercaseSha.records[0]),
      revokedAt: null, revokedRevision: null, revocationReason: null, revocationHistory: []
    };
    expect(validateProjectProfilesStore(uppercaseSha).ok).toBe(true);
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
    const revoked = { ...oldApproval, status: "revoked" as const, revokedAt: 1400,
      revokedRevision: oldApproval.approvedRevision, revocationReason: "Policy changed" };
    store.records[0].approval = {
      ...revoked,
      status: "approved",
      approvedAt: 1500,
      approvedContentHash: computeProfileContentHash(store.records[0]),
      revokedAt: null, revokedRevision: null, revocationReason: null,
      revocationHistory: [{
        approvedRevision: oldApproval.approvedRevision!,
        evidence: oldApproval.evidence!,
        approvedAt: oldApproval.approvedAt!,
        approvedContentHash: oldApproval.approvedContentHash!,
        revokedAt: 1400,
        revocationReason: "Policy changed"
      }]
    };
    expect(validateProjectProfilesStore(store).ok).toBe(true);
    expect(validateProfileApprovalHistoryUpdate(revoked, store.records[0].approval)).toBe(true);
    expect(validateProfileApprovalHistoryUpdate(revoked, { ...store.records[0].approval, revocationHistory: [] })).toBe(false);
    expect(store.records[0].approval.revocationHistory).toHaveLength(1);
    expect(store.records[0].approval.revocationHistory[0].evidence).toEqual(oldApproval.evidence);
  });
  it("rejects unknown envelope and identity keys instead of silently accepting them", () => {
    const extraEnvelope = { ...draftStore(), hidden: true };
    expect(validateProjectProfilesStore(extraEnvelope).ok).toBe(false);
    const extraIdentity = draftStore();
    (extraIdentity.records[0].identity as unknown as Record<string, unknown>).hidden = true;
    expect(validateProjectProfilesStore(extraIdentity).ok).toBe(false);
  });
  it("rejects unsafe extension keys and non-plain objects", () => {
    const store = draftStore();
    store.records[0].extensions = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(validateProjectProfilesStore(store).ok).toBe(false);
    const withDate = draftStore() as unknown as { records: Array<Record<string, unknown>> };
    withDate.records[0].extensions = { date: new Date() };
    expect(validateProjectProfilesStore(withDate).ok).toBe(false);
  });

  it("guards every approval transition and prevents rewriting or dropping prior evidence", () => {
    const store = draftStore();
    approve(store.records[0]);
    const approved = JSON.parse(JSON.stringify(store.records[0].approval));
    const revoked = {
      ...approved, status: "revoked" as const, revokedAt: 1400,
      revokedRevision: approved.approvedRevision, revocationReason: "Policy changed"
    };
    expect(validateProfileApprovalHistoryUpdate(approved, revoked)).toBe(true);
    expect(validateProfileApprovalHistoryUpdate(approved, { ...revoked, evidence: { ...approved.evidence, reference: "forged" } })).toBe(false);
    expect(validateProfileApprovalHistoryUpdate(approved, { ...revoked, approvedContentHash: "ffffffffffffffff" })).toBe(false);
    expect(validateProfileApprovalHistoryUpdate(revoked, { ...revoked, revocationReason: "rewritten" })).toBe(false);
    const archived = {
      approvedRevision: approved.approvedRevision, evidence: approved.evidence,
      approvedAt: approved.approvedAt, approvedContentHash: approved.approvedContentHash,
      revokedAt: revoked.revokedAt, revocationReason: revoked.revocationReason
    };
    const unapproved = {
      status: "unapproved" as const, approvedRevision: null, evidence: null, approvedAt: null,
      approvedContentHash: null, revokedAt: null, revokedRevision: null, revocationReason: null,
      revocationHistory: [archived]
    };
    expect(validateProfileApprovalHistoryUpdate(revoked, unapproved)).toBe(true);
    expect(validateProfileApprovalHistoryUpdate(revoked, { ...unapproved, revocationHistory: [] })).toBe(false);
    expect(validateProfileApprovalHistoryUpdate(revoked, { ...revoked, status: "approved" as const })).toBe(false);
    expect(validateProfileApprovalHistoryUpdate(revoked, null as never)).toBe(false);
  });
  it("uses a per-profile validation budget so large collections remain valid", () => {
    const base = draftStore().records[0];
    const records = Array.from({ length: 300 }, (_, index) => ({
      ...JSON.parse(JSON.stringify(base)),
      projectId: `p${index}`,
      identity: { name: `Project ${index}`, purpose: "" }
    }));
    expect(validateProjectProfilesStore({ schemaVersion: 1, revision: 1, updatedAt: 1234, records }).ok).toBe(true);
  });
  it("rejects accessors, sparse arrays, cycles, non-finite numbers, and excessive depth", () => {
    const accessor = draftStore();
    Object.defineProperty(accessor.records[0].identity, "name", { enumerable: true, get: () => "One" });
    expect(validateProjectProfilesStore(accessor).ok).toBe(false);
    const sparse = draftStore();
    sparse.records[0].technology = new Array(1);
    expect(validateProjectProfilesStore(sparse).ok).toBe(false);
    const cyclic = draftStore();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    cyclic.records[0].extensions = { cycle } as never;
    expect(validateProjectProfilesStore(cyclic).ok).toBe(false);
    const nonFinite = draftStore();
    nonFinite.records[0].extensions = { bad: Number.NaN };
    expect(validateProjectProfilesStore(nonFinite).ok).toBe(false);
    let deep: unknown = "leaf";
    for (let index = 0; index < 120; index += 1) deep = { child: deep };
    const tooDeep = draftStore();
    tooDeep.records[0].extensions = { deep } as never;
    expect(validateProjectProfilesStore(tooDeep).ok).toBe(false);
    const tooLarge = draftStore();
    tooLarge.records[0].extensions = { values: Array(10001).fill("x") };
    expect(validateProjectProfilesStore(tooLarge).ok).toBe(false);
  });
  it("hashes controlled profile content, excludes approval and updatedAt, and rejects unsafe input", () => {
    const original = draftStore().records[0];
    const baseline = computeProfileContentHash(original);
    expect(computeProfileContentHash({ ...original, updatedAt: original.updatedAt + 1 })).toBe(baseline);
    expect(computeProfileContentHash({ ...original, approval: { ...original.approval, status: "revoked" } })).toBe(baseline);
    expect(computeProfileContentHash({ ...original, profileRevision: original.profileRevision + 1 })).not.toBe(baseline);
    expect(computeProfileContentHash({ ...original, createdAt: original.createdAt + 1 })).not.toBe(baseline);
    expect(computeProfileContentHash({ ...original, extensions: { source: "test" } })).not.toBe(baseline);
    expect(() => computeProfileContentHash({ ...original, extensions: { bad: Infinity } })).toThrow();
    const reordered = JSON.parse(JSON.stringify(original));
    reordered.identity = { purpose: reordered.identity.purpose, name: reordered.identity.name };
    expect(computeProfileContentHash(reordered)).toBe(baseline);
  });
  it("reports sparse legacy entries and rejects corrupt existing stores without replacing them", () => {
    const legacy: unknown[] = [{ id: "p1", name: "One" }, , { id: "p2", name: "Two" }];
    const result = migrateLegacyProjectsToProfiles(legacy, 1234);
    expect(result.store.records.map((record) => record.projectId)).toEqual(["p1", "p2"]);
    expect(result.rejected).toContainEqual({ index: 1, reason: "Sparse legacy project entry." });
    expect(() => migrateLegacyProjectsToProfiles([{ id: "p2", name: "Two" }], 1234,
      { schemaVersion: 1, revision: 1, updatedAt: 1234, records: [null] } as never)).toThrow();
  });
  it("rejects duplicate repository identifiers", () => {
    const store = draftStore();
    store.records[0].repositories = ["https://github.com/org/repo", "https://github.com/org/repo/"];
    expect(validateProjectProfilesStore(store).ok).toBe(false);
  });


  it("requires the profile-store update boundary to preserve project identity and approval history", () => {
    const previous = draftStore();
    const added = migrateLegacyProjectsToProfiles([{ id: "p1", name: "One" }, { id: "p2", name: "Two" }], 1300, previous).store;
    expect(validateProjectProfilesStoreUpdate(previous, added)).toBe(true);
    expect(validateProjectProfilesStoreUpdate(previous, { ...added, records: [] })).toBe(false);
    const approvedStore = draftStore();
    approve(approvedStore.records[0]);
    const nextProfile = JSON.parse(JSON.stringify(approvedStore.records[0]));
    nextProfile.approval = { ...nextProfile.approval, status: "revoked", revokedAt: 1400,
      revokedRevision: nextProfile.approval.approvedRevision, revocationReason: "Scope changed" };
    const revokedStore = { ...approvedStore, revision: approvedStore.revision + 1, updatedAt: 1400, records: [nextProfile] };
    expect(validateProjectProfilesStore(approvedStore).ok).toBe(true);
    expect(validateProjectProfilesStore(revokedStore).ok).toBe(true);
    expect(validateProfileApprovalHistoryUpdate(approvedStore.records[0].approval, nextProfile.approval)).toBe(true);
    expect(validateProjectProfilesStoreUpdate(approvedStore, revokedStore)).toBe(true);
    const forged = { ...revokedStore, records: [{ ...nextProfile,
      approval: { ...nextProfile.approval, evidence: { ...nextProfile.approval.evidence, reference: "forged" } } }] };
    expect(validateProjectProfilesStoreUpdate(approvedStore, forged)).toBe(false);
  });

});
