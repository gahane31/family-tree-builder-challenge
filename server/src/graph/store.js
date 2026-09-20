// GraphStore — the core. All validation lives here.
// In-memory graph, write-through to SQLite via db/queries.js. Reads come from memory.
// All methods are SYNCHRONOUS by design (sync driver => atomic mutations, no locks). See README.
import { migrate } from "../db/db.js";
import {
  getAllPeople,
  getAllParentEdges,
  getAllSpouseEdges,
  insertPerson,
  updatePersonRow,
  insertParentEdge,
  deleteParentEdge,
  insertSpouseEdge,
  deleteSpouseEdge,
} from "../db/queries.js";

// SQLite INTEGER PKs come back as numbers. Canonical JS/API id is the
// decimal string so React Flow and tool schemas can use them as-is.
function toPersonId(id) {
  const personId = Number(id);
  if (!Number.isInteger(personId) || personId <= 0) return null;
  return String(personId);
}

function canonicalSpouseIds(personAId, personBId) {
  return Number(personAId) < Number(personBId)
    ? [personAId, personBId]
    : [personBId, personAId];
}

export class GraphStore {
  constructor(db) {
    this.db = db;
    migrate(db);
    this.people = new Map();   // id -> { id, name, context, createdAt, updatedAt }
    this.parents = new Map();   // childId -> Set<parentId>
    this.children = new Map();  // parentId -> Set<childId>
    this.spouses = new Map();   // personId -> Set<otherPersonId>
    this.#load();
  }

  #load() {
    for (const row of getAllPeople(this.db)) {
      const id = toPersonId(row.id);
      this.people.set(id, {
        id,
        name: row.name,
        context: row.context ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
    for (const row of getAllParentEdges(this.db)) {
      this.#linkParent(toPersonId(row.parent_id), toPersonId(row.child_id));
    }
    for (const row of getAllSpouseEdges(this.db)) {
      this.#linkSpouse(toPersonId(row.person_a_id), toPersonId(row.person_b_id));
    }
  }

  // --- internal helpers ---

  #linkParent(parentId, childId) {
    if (!this.parents.has(childId)) this.parents.set(childId, new Set());
    if (!this.children.has(parentId)) this.children.set(parentId, new Set());
    this.parents.get(childId).add(parentId);
    this.children.get(parentId).add(childId);
  }

  #unlinkParent(parentId, childId) {
    this.parents.get(childId)?.delete(parentId);
    this.children.get(parentId)?.delete(childId);
  }

  #linkSpouse(personAId, personBId) {
    if (!this.spouses.has(personAId)) this.spouses.set(personAId, new Set());
    if (!this.spouses.has(personBId)) this.spouses.set(personBId, new Set());
    this.spouses.get(personAId).add(personBId);
    this.spouses.get(personBId).add(personAId);
  }

  #unlinkSpouse(personAId, personBId) {
    this.spouses.get(personAId)?.delete(personBId);
    this.spouses.get(personBId)?.delete(personAId);
  }

  requirePerson(id) {
    const personId = toPersonId(id);
    const person = personId == null ? null : this.people.get(personId);
    if (!person) throw new Error(`Unknown person id: ${id}`);
    return person;
  }

  // Deterministic ambiguity guard: if the person referenced by `id` shares their
  // name with another person, refuse to mutate unless the caller passes
  // `confirmed: true` (meaning the user has explicitly picked this id).
  // The error lists the candidates so the LLM can relay them to the user.
  #requireUniqueOrConfirmed(id, confirmed) {
    const person = this.requirePerson(id);
    const peopleWithSameName = [];
    for (const candidate of this.people.values()) {
      if (candidate.name.trim().toLowerCase() === person.name.trim().toLowerCase()) {
        peopleWithSameName.push(candidate);
      }
    }
    if (peopleWithSameName.length > 1 && !confirmed) {
      const candidateSummaries = peopleWithSameName
        .map((candidate) => `${candidate.id} (${this.relationsSummary(candidate.id)})`)
        .join(", ");
      throw new Error(
        `Multiple people named "${person.name}" exist: ${candidateSummaries}. Ask the user which one they mean, then retry with confirmed: true and the chosen id.`
      );
    }
  }

  parentsOf(id) {
    return [...(this.parents.get(id) ?? [])];
  }

  childrenOf(id) {
    return [...(this.children.get(id) ?? [])];
  }

  spousesOf(id) {
    return [...(this.spouses.get(id) ?? [])];
  }

  #nameOf(id) {
    return this.people.get(id)?.name ?? id;
  }

  // --- public API ---

  findByName(name) {
    name = (name ?? "").trim().toLowerCase();
    if (!name) throw new Error("name is required");
    const matches = [];
    for (const person of this.people.values()) {
      if (person.name.trim().toLowerCase().includes(name)) {
        matches.push({
          id: person.id,
          name: person.name,
          context: person.context,
          relations: this.relationsSummary(person.id),
        });
      }
    }
    return matches;
  }

  relationsSummary(id) {
    id = this.requirePerson(id).id;
    const parentNames = this.parentsOf(id).map((parentId) => this.#nameOf(parentId));
    const spouseNames = this.spousesOf(id).map((spouseId) => this.#nameOf(spouseId));
    const childNames = this.childrenOf(id).map((childId) => this.#nameOf(childId));
    const parts = [];
    if (parentNames.length) parts.push(`parents: ${parentNames.join(", ")}`);
    if (spouseNames.length) parts.push(`spouse: ${spouseNames.join(", ")}`);
    if (childNames.length) parts.push(`children: ${childNames.join(", ")}`);
    if (!parts.length) return "no relationships recorded";
    return parts.join(" / ");
  }

  addPerson({ name, context, allowDuplicate } = {}) {
    name = (name ?? "").trim();
    if (!name) throw new Error("name is required");
    let existingPerson = null;
    for (const person of this.people.values()) {
      if (person.name.trim().toLowerCase() === name.toLowerCase()) {
        existingPerson = person;
        break;
      }
    }
    if (existingPerson && !allowDuplicate) {
      return {
        person: { id: existingPerson.id, name: existingPerson.name, context: existingPerson.context },
        warning: `A person named ${existingPerson.name} already exists (id ${existingPerson.id}). Ask the user whether this is the same person before creating a new one.`,
        changed: false,
      };
    }
    const now = new Date().toISOString();
    const id = insertPerson(this.db, { name, context: context ?? null, createdAt: now, updatedAt: now });
    const person = { id, name, context: context ?? null, createdAt: now, updatedAt: now };
    this.people.set(id, person);
    if (existingPerson && allowDuplicate) {
      return { person: { id, name, context: context ?? null }, note: "created as a separate person with the same name", changed: true };
    }
    return { person: { id, name, context: context ?? null }, changed: true };
  }

  #wouldCreateCycle(parentId, childId) {
    const stack = [childId];
    const visited = new Set();
    while (stack.length) {
      const currentId = stack.pop();
      if (currentId === parentId) return true;
      if (visited.has(currentId)) continue;
      visited.add(currentId);
      for (const descendantId of this.childrenOf(currentId)) stack.push(descendantId);
    }
    return false;
  }

  addParentEdge(parentId, childId, confirmed) {
    parentId = this.requirePerson(parentId).id;
    childId = this.requirePerson(childId).id;
    const parent = this.people.get(parentId);
    const child = this.people.get(childId);
    this.#requireUniqueOrConfirmed(parentId, confirmed);
    this.#requireUniqueOrConfirmed(childId, confirmed);
    if (parentId === childId) throw new Error("A person cannot be their own parent");
    if (this.parents.get(childId)?.has(parentId)) {
      return { parent: { id: parent.id, name: parent.name }, child: { id: child.id, name: child.name }, alreadyExisted: true, changed: false };
    }
    const existingParentIds = this.parentsOf(childId);
    const distinctParentIds = new Set(existingParentIds);
    if (distinctParentIds.size >= 2) {
      throw new Error(`${child.name} already has two parents recorded`);
    }
    if (this.#wouldCreateCycle(parentId, childId)) {
      throw new Error(`Cannot add this parent-child link: it would create a cycle (${parentId} is a descendant of ${childId})`);
    }
    const now = new Date().toISOString();
    insertParentEdge(this.db, { parentId, childId, createdAt: now });
    this.#linkParent(parentId, childId);
    return { parent: { id: parent.id, name: parent.name }, child: { id: child.id, name: child.name }, changed: true };
  }

  addSpouseEdge(personAId, personBId, confirmed) {
    personAId = this.requirePerson(personAId).id;
    personBId = this.requirePerson(personBId).id;
    this.#requireUniqueOrConfirmed(personAId, confirmed);
    this.#requireUniqueOrConfirmed(personBId, confirmed);
    if (personAId === personBId) throw new Error("A person cannot be married to themselves");
    const [canonicalAId, canonicalBId] = canonicalSpouseIds(personAId, personBId);
    if (this.spouses.get(canonicalAId)?.has(canonicalBId)) {
      return {
        personA: { id: canonicalAId, name: this.#nameOf(canonicalAId) },
        personB: { id: canonicalBId, name: this.#nameOf(canonicalBId) },
        alreadyExisted: true,
        changed: false,
      };
    }
    const now = new Date().toISOString();
    insertSpouseEdge(this.db, { personAId: canonicalAId, personBId: canonicalBId, createdAt: now });
    this.#linkSpouse(canonicalAId, canonicalBId);
    return {
      personA: { id: canonicalAId, name: this.#nameOf(canonicalAId) },
      personB: { id: canonicalBId, name: this.#nameOf(canonicalBId) },
      changed: true,
    };
  }

  updatePerson(id, { name, context } = {}, confirmed) {
    id = this.requirePerson(id).id;
    const person = this.people.get(id);
    this.#requireUniqueOrConfirmed(id, confirmed);
    const hasName = name !== undefined;
    const hasContext = context !== undefined;
    if (!hasName && !hasContext) throw new Error("Nothing to update: provide name and/or context");
    let updatedName = person.name;
    if (hasName) {
      name = String(name).trim();
      if (!name) throw new Error("name cannot be empty");
      updatedName = name;
    }
    const updatedContext = hasContext ? (context ?? null) : person.context;
    let warning = null;
    if (hasName) {
      for (const otherPerson of this.people.values()) {
        if (otherPerson.id === id) continue;
        if (otherPerson.name.trim().toLowerCase() === updatedName.toLowerCase()) {
          warning = `another person with this name exists (id ${otherPerson.id})`;
          break;
        }
      }
    }
    const now = new Date().toISOString();
    updatePersonRow(this.db, { id, name: updatedName, context: updatedContext, updatedAt: now });
    person.name = updatedName;
    person.context = updatedContext;
    person.updatedAt = now;
    const result = { id: person.id, name: person.name, context: person.context };
    return warning ? { person: result, warning, changed: true } : { person: result, changed: true };
  }

  removeRelationship(relationshipType, personAId, personBId, confirmed) {
    if (relationshipType !== "parent" && relationshipType !== "spouse") {
      throw new Error('relationship_type must be "parent" or "spouse"');
    }
    personAId = this.requirePerson(personAId).id;
    personBId = this.requirePerson(personBId).id;
    this.#requireUniqueOrConfirmed(personAId, confirmed);
    this.#requireUniqueOrConfirmed(personBId, confirmed);
    if (relationshipType === "parent") {
      const parentId = personAId;
      const childId = personBId;
      const edgeExists = this.parents.get(childId)?.has(parentId);
      if (!edgeExists) return { alreadyAbsent: true, changed: false };
      deleteParentEdge(this.db, { parentId, childId });
      this.#unlinkParent(parentId, childId);
      return { removed: `parent edge ${this.#nameOf(parentId)}→${this.#nameOf(childId)}`, changed: true };
    }
    const [canonicalAId, canonicalBId] = canonicalSpouseIds(personAId, personBId);
    const edgeExists = this.spouses.get(canonicalAId)?.has(canonicalBId);
    if (!edgeExists) return { alreadyAbsent: true, changed: false };
    deleteSpouseEdge(this.db, { personAId: canonicalAId, personBId: canonicalBId });
    this.#unlinkSpouse(canonicalAId, canonicalBId);
    return { removed: `spouse edge ${this.#nameOf(canonicalAId)}↔${this.#nameOf(canonicalBId)}`, changed: true };
  }

  getPerson(id) {
    const person = this.requirePerson(id);
    id = person.id;
    const toIdName = (personIds) => personIds.map((personId) => ({ id: personId, name: this.#nameOf(personId) }));
    return {
      id: person.id,
      name: person.name,
      context: person.context,
      parents: toIdName(this.parentsOf(id)),
      children: toIdName(this.childrenOf(id)),
      spouses: toIdName(this.spousesOf(id)),
    };
  }

  toJSON() {
    const people = [...this.people.values()].map((person) => ({
      id: person.id,
      name: person.name,
      context: person.context,
    }));
    const parentEdges = [];
    for (const [childId, parentIds] of this.parents.entries()) {
      for (const parentId of parentIds) parentEdges.push({ parentId, childId });
    }
    const spouseEdges = [];
    const seenSpousePairs = new Set();
    for (const [personAId, spouseIds] of this.spouses.entries()) {
      for (const personBId of spouseIds) {
        const pairKey = [personAId, personBId].sort().join("|");
        if (seenSpousePairs.has(pairKey)) continue;
        seenSpousePairs.add(pairKey);
        const [canonicalAId, canonicalBId] = canonicalSpouseIds(personAId, personBId);
        spouseEdges.push({ personAId: canonicalAId, personBId: canonicalBId });
      }
    }
    return { people, parentEdges, spouseEdges };
  }
}
