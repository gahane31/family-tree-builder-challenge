// All SQLite access for the family tree. GraphStore validates in memory,
// then calls these for durability. Reads at request time still come from memory.

export function getAllPeople(db) {
  return db.prepare(
    "SELECT id, name, context, created_at, updated_at FROM people"
  ).all();
}

export function getAllParentEdges(db) {
  return db.prepare("SELECT parent_id, child_id FROM parent_edges").all();
}

export function getAllSpouseEdges(db) {
  return db.prepare("SELECT person_a_id, person_b_id FROM spouse_edges").all();
}

export function insertPerson(db, { name, context, createdAt, updatedAt }) {
  const result = db.prepare(
    "INSERT INTO people (name, context, created_at, updated_at) VALUES (?, ?, ?, ?)"
  ).run(name, context, createdAt, updatedAt);
  return String(Number(result.lastInsertRowid));
}

export function updatePersonRow(db, { id, name, context, updatedAt }) {
  db.prepare(
    "UPDATE people SET name = ?, context = ?, updated_at = ? WHERE id = ?"
  ).run(name, context, updatedAt, id);
}

export function insertParentEdge(db, { parentId, childId, createdAt }) {
  db.prepare(
    "INSERT INTO parent_edges (parent_id, child_id, created_at) VALUES (?, ?, ?)"
  ).run(parentId, childId, createdAt);
}

export function deleteParentEdge(db, { parentId, childId }) {
  db.prepare(
    "DELETE FROM parent_edges WHERE parent_id = ? AND child_id = ?"
  ).run(parentId, childId);
}

export function insertSpouseEdge(db, { personAId, personBId, createdAt }) {
  db.prepare(
    "INSERT INTO spouse_edges (person_a_id, person_b_id, created_at) VALUES (?, ?, ?)"
  ).run(personAId, personBId, createdAt);
}

export function deleteSpouseEdge(db, { personAId, personBId }) {
  db.prepare(
    "DELETE FROM spouse_edges WHERE person_a_id = ? AND person_b_id = ?"
  ).run(personAId, personBId);
}
