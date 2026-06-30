/**
 * Backend selection. STORAGE=db uses Postgres (remote server); anything else
 * (default) uses the file backend (stdio / local exe).
 *
 * The db backend is imported lazily so the stdio binary compiles and runs
 * without a Postgres driver or a live connection.
 */
import { FileSessionBackend, FileTrustBackend } from "./file.ts";
import type { SessionBackend, TrustBackend } from "./types.ts";

let _store: SessionBackend;
let _trust: TrustBackend;

function useDb(): boolean {
  return (process.env.STORAGE ?? "file").toLowerCase() === "db";
}

if (useDb()) {
  // Lazy require so file/stdio builds never load the pg driver.
  const { DbSessionBackend, DbTrustBackend } = await import("./db.ts");
  _store = new DbSessionBackend();
  _trust = new DbTrustBackend();
} else {
  _store = new FileSessionBackend();
  _trust = new FileTrustBackend();
}

export const store: SessionBackend = _store;
export const trust: TrustBackend = _trust;
export type {
  Session,
  SessionBackend,
  SessionPatch,
  TrustBackend,
  TrustRecord,
} from "./types.ts";
