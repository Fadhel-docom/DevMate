declare module "*?raw" {
  const source: string;
  export default source;
}

/** Subset of Vite's import.meta.glob used by productionIsolation.test.ts (no vite/client types are loaded in this project). */
interface ImportMeta {
  glob(pattern: string | string[], options: { query: string; import: string; eager: true }): Record<string, string>;
}
