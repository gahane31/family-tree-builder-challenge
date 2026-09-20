// SQLite open + migrate. Synchronous (better-sqlite3).
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, "..", "..", "data", "family-tree.db");

export const TABLES = ["people", "parent_edges", "spouse_edges"];

export function openDatabase() {
  const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
      context    TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS parent_edges (
      parent_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      child_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (parent_id, child_id),
      CHECK (parent_id != child_id)
    );

    CREATE TABLE IF NOT EXISTS spouse_edges (
      person_a_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      person_b_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (person_a_id, person_b_id),
      CHECK (person_a_id < person_b_id)
    );

    CREATE TRIGGER IF NOT EXISTS parent_edges_no_cycle
    BEFORE INSERT ON parent_edges
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'Cannot add this parent-child link: it would create a cycle')
      WHERE EXISTS (
        WITH RECURSIVE descendants(id) AS (
          SELECT NEW.child_id
          UNION
          SELECT pe.child_id
          FROM parent_edges pe
          INNER JOIN descendants d ON pe.parent_id = d.id
        )
        SELECT 1 FROM descendants WHERE id = NEW.parent_id
      );
    END;
  `);
}

export function dropSchema(db) {
  db.pragma("foreign_keys = OFF");
  db.exec(`
    DROP TRIGGER IF EXISTS parent_edges_no_cycle;
    DROP TABLE IF EXISTS spouse_edges;
    DROP TABLE IF EXISTS parent_edges;
    DROP TABLE IF EXISTS people;
  `);
  db.pragma("foreign_keys = ON");
}

export function recreateSchema(db) {
  dropSchema(db);
  migrate(db);
}
