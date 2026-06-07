import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { mkdirSync } from "fs";
import { dirname } from "path";

let _db: Database.Database | null = null;

/**
 * Open (or return the cached) outreach DB. Idempotent: SCHEMA_SQL uses
 * CREATE TABLE IF NOT EXISTS, so it is safe to call on an existing DB.
 */
export function getDb(path: string = "./data/outreach.db"): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(path), { recursive: true });
  _db = new Database(path);
  _db.exec(SCHEMA_SQL);
  return _db;
}

/** For tests — pass :memory: (resets the singleton first). */
export function initDb(path: string): Database.Database {
  _db = null;
  return getDb(path);
}

export function resetDbSingleton(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
