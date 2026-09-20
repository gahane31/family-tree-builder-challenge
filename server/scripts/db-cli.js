#!/usr/bin/env node
// Testing helper — not imported by the app. Recreate/clear the SQLite file
// without going through GraphStore.
import "dotenv/config";
import { openDatabase, migrate, recreateSchema, TABLES } from "../src/db/db.js";

const USAGE = `Family-tree DB helper (testing only)

Usage:
  npm run db -- reset                         Drop tables and recreate empty schema
  npm run db -- clear                         Delete all rows, keep schema
  npm run db -- clear people                  Delete people (edges cascade)
  npm run db -- clear parent_edges
  npm run db -- clear spouse_edges
  npm run db -- schema                        Print table/trigger SQL
  npm run db -- stats                         Row counts
`;

function helpAndExit(code = 0) {
  console.log(USAGE);
  process.exit(code);
}

function resetSqliteSequence(db, table) {
  db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(table);
}

function clearTable(db, table) {
  if (!TABLES.includes(table)) {
    console.error(`Unknown table "${table}". Use: ${TABLES.join(", ")}`);
    process.exit(1);
  }
  db.prepare(`DELETE FROM ${table}`).run();
  if (table === "people") resetSqliteSequence(db, "people");
  console.log(`Cleared ${table}`);
}

function clearAll(db) {
  db.exec(`
    DELETE FROM spouse_edges;
    DELETE FROM parent_edges;
    DELETE FROM people;
  `);
  resetSqliteSequence(db, "people");
  console.log("Cleared all tables");
}

function printSchema(db) {
  const rows = db.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name"
  ).all();
  for (const row of rows) {
    console.log(`-- ${row.type}: ${row.name}`);
    console.log(row.sql + ";\n");
  }
}

function printStats(db) {
  for (const table of TABLES) {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    console.log(`${table}: ${n}`);
  }
}

const [command, table] = process.argv.slice(2);
if (!command || command === "help" || command === "-h" || command === "--help") {
  helpAndExit(0);
}

const db = openDatabase();
migrate(db);

try {
  if (command === "reset") {
    recreateSchema(db);
    console.log("Schema dropped and recreated (empty)");
  } else if (command === "clear") {
    if (table) clearTable(db, table);
    else clearAll(db);
  } else if (command === "schema") {
    printSchema(db);
  } else if (command === "stats") {
    printStats(db);
  } else {
    console.error(`Unknown command: ${command}\n`);
    helpAndExit(1);
  }
} finally {
  db.close();
}
