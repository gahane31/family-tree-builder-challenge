import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { GraphStore } from "../src/graph/store.js";

function freshStore() {
  const db = new Database(":memory:");
  return new GraphStore(db);
}

test("addPerson returns ids 1, 2 in sequence", () => {
  const s = freshStore();
  const a = s.addPerson({ name: "Jon" });
  const b = s.addPerson({ name: "Rob" });
  assert.equal(a.person.id, "1");
  assert.equal(b.person.id, "2");
});

test("duplicate name returns existing + warning; allowDuplicate creates second", () => {
  const s = freshStore();
  const a = s.addPerson({ name: "Jon" });
  const dup = s.addPerson({ name: "jon" });
  assert.equal(dup.person.id, a.person.id);
  assert.match(dup.warning, /already exists/);
  assert.match(dup.warning, /id 1/);
  assert.equal(dup.changed, false);

  const second = s.addPerson({ name: "Jon", allowDuplicate: true });
  assert.equal(second.person.id, "2");
  assert.equal(second.note, "created as a separate person with the same name");
});

test("parent edge works; re-adding returns alreadyExisted: true", () => {
  const s = freshStore();
  s.addPerson({ name: "Rob" });
  s.addPerson({ name: "Jon" });
  const e1 = s.addParentEdge(1, 2);
  assert.equal(e1.parent.name, "Rob");
  assert.equal(e1.child.name, "Jon");
  const e2 = s.addParentEdge(1, 2);
  assert.equal(e2.alreadyExisted, true);
  assert.equal(e2.changed, false);
});

test("third parent on a child throws 'already has two parents recorded'", () => {
  const s = freshStore();
  s.addPerson({ name: "Rob" });
  s.addPerson({ name: "Sue" });
  s.addPerson({ name: "Joe" });
  s.addPerson({ name: "Jon" });
  s.addParentEdge(1, 4);
  s.addParentEdge(2, 4);
  assert.throws(() => s.addParentEdge(3, 4), /already has two parents recorded/);
});

test("direct cycle rejected (A->B then B->A)", () => {
  const s = freshStore();
  s.addPerson({ name: "A" });
  s.addPerson({ name: "B" });
  s.addParentEdge(1, 2);
  assert.throws(() => s.addParentEdge(2, 1), /would create a cycle/);
});

test("transitive cycle rejected (A->B->C then C->A)", () => {
  const s = freshStore();
  s.addPerson({ name: "A" });
  s.addPerson({ name: "B" });
  s.addPerson({ name: "C" });
  s.addParentEdge(1, 2);
  s.addParentEdge(2, 3);
  assert.throws(() => s.addParentEdge(3, 1), /would create a cycle/);
});

test("self-parent rejected", () => {
  const s = freshStore();
  s.addPerson({ name: "A" });
  assert.throws(() => s.addParentEdge(1, 1), /cannot be their own parent/);
});

test("spouse dedupe: (A,B) then (B,A) results in one edge", () => {
  const s = freshStore();
  s.addPerson({ name: "A" });
  s.addPerson({ name: "B" });
  s.addSpouseEdge(1, 2);
  s.addSpouseEdge(2, 1);
  const json = s.toJSON();
  assert.equal(json.spouseEdges.length, 1);
});

test("adding a spouse does NOT change parentEdges", () => {
  const s = freshStore();
  s.addPerson({ name: "A" });
  s.addPerson({ name: "B" });
  const before = s.toJSON().parentEdges;
  s.addSpouseEdge(1, 2);
  const after = s.toJSON().parentEdges;
  assert.deepEqual(after, before);
});

test("recording two parents of a child does NOT auto-create a spouse edge (no inference)", () => {
  const s = freshStore();
  s.addPerson({ name: "C" });
  s.addPerson({ name: "A" });
  s.addPerson({ name: "B" });
  s.addParentEdge(2, 1);
  s.addParentEdge(3, 1);
  assert.equal(s.toJSON().spouseEdges.length, 0);
});

test("duplicate-name guard: mutation on a shared-name person without confirmed throws; with confirmed succeeds", () => {
  const s = freshStore();
  s.addPerson({ name: "Akshay" });
  s.addPerson({ name: "Bob" });
  s.addPerson({ name: "Akshay", allowDuplicate: true });
  assert.throws(
    () => s.addParentEdge(1, 2),
    /Multiple people named "Akshay" exist/
  );
  assert.throws(
    () => s.addSpouseEdge(1, 2),
    /Multiple people named "Akshay" exist/
  );
  assert.throws(
    () => s.updatePerson(1, { context: "x" }),
    /Multiple people named "Akshay" exist/
  );
  assert.equal(s.toJSON().parentEdges.length, 0);
  assert.equal(s.toJSON().spouseEdges.length, 0);
  const r = s.addParentEdge(1, 2, true);
  assert.equal(r.child.id, "2");
  assert.equal(s.toJSON().parentEdges.length, 1);
  try {
    s.addSpouseEdge(3, 2);
  } catch (e) {
    assert.match(e.message, /1 /);
    assert.match(e.message, /3 /);
  }
});

test("removeRelationship on absent edge returns alreadyAbsent: true", () => {
  const s = freshStore();
  s.addPerson({ name: "A" });
  s.addPerson({ name: "B" });
  const r = s.removeRelationship("parent", 1, 2);
  assert.equal(r.alreadyAbsent, true);
  const r2 = s.removeRelationship("spouse", 1, 2);
  assert.equal(r2.alreadyAbsent, true);
});

test("updatePerson renames; renaming to an existing other name includes a warning", () => {
  const s = freshStore();
  s.addPerson({ name: "Jon" });
  s.addPerson({ name: "Rob" });
  const r = s.updatePerson(1, { name: "Jonathan" });
  assert.equal(r.person.name, "Jonathan");
  const warn = s.updatePerson(2, { name: "Jonathan" });
  assert.match(warn.warning, /another person with this name exists/);
  assert.match(warn.warning, /id 1/);
});

test("findByName: case-insensitive substring; unknown -> empty array", () => {
  const s = freshStore();
  s.addPerson({ name: "Jonathan" });
  s.addPerson({ name: "Rob" });
  assert.equal(s.findByName("jon").length, 1);
  assert.equal(s.findByName("JON").length, 1);
  assert.deepEqual(s.findByName("zzz"), []);
  assert.throws(() => s.findByName(""), /name is required/);
});

test("relationsSummary contains 'parents: Rob' and 'no relationships recorded' for isolated", () => {
  const s = freshStore();
  s.addPerson({ name: "Rob" });
  s.addPerson({ name: "Sue" });
  s.addPerson({ name: "Jon" });
  s.addPerson({ name: "Kate" });
  s.addParentEdge(1, 3);
  s.addParentEdge(2, 3);
  const sum = s.relationsSummary(3);
  assert.match(sum, /parents: Rob, Sue/);
  const iso = s.relationsSummary(4);
  assert.equal(iso, "no relationships recorded");
});

test("ids resolve regardless of type the model sends", () => {
  const store = freshStore();
  const { person } = store.addPerson({ name: "Jon" });
  const canonical = store.getPerson(person.id).id;
  assert.equal(store.getPerson(String(person.id)).id, canonical);
  assert.equal(store.getPerson(Number(person.id)).id, canonical);
  assert.throws(() => store.getPerson("abc"), /Invalid person id/);
  assert.throws(() => store.getPerson(-1), /Invalid person id/);
});

test("persistence: second GraphStore on same file deep-equals first", () => {
  const tmp = path.join(os.tmpdir(), `ft-test-${Math.random().toString(36).slice(2)}.db`);
  try {
    const db1 = new Database(tmp);
    const s1 = new GraphStore(db1);
    s1.addPerson({ name: "Rob" });
    s1.addPerson({ name: "Sue" });
    s1.addPerson({ name: "Jon" });
    s1.addParentEdge(1, 3);
    s1.addParentEdge(2, 3);
    s1.addSpouseEdge(1, 2);
    const first = s1.toJSON();
    db1.close();

    const db2 = new Database(tmp);
    const s2 = new GraphStore(db2);
    const second = s2.toJSON();
    db2.close();

    assert.deepEqual(second, first);
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(tmp + "-wal", { force: true });
    fs.rmSync(tmp + "-shm", { force: true });
  }
});
