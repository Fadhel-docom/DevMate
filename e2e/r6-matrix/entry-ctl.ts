// Real production modules, bundled for a real browser page as window.ctl. The mutating controller is test-harness only.
export { createCutoverController, createCutoverStages, CUTOVER_MARKER_KEY, CUTOVER_PHASES, fingerprintSource, parseMarker } from "../../src/cutoverController";
export { inspectCutoverState, readCutoverState } from "../../src/cutoverState";
export { STORAGE_KEY, STORAGE_LOCK_NAME, saveProjectsLocked, withStorageLock } from "../../src/storage";
