// TOOLS (Anthropic format) + executeTool dispatcher.
import { createLogger } from "../helpers/logger.js";
import { metrics } from "../helpers/metrics.js";

const auditLog = createLogger("audit");

export const TOOLS = [
  {
    name: "find_people",
    description:
      "Search people by name (case-insensitive substring). Returns candidates with id, name, context, and a computed 'relations' summary (parents/spouse/children). ALWAYS call this before creating or linking anyone, to resolve who the user means.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "get_person",
    description: "Get one person with their parents, children, and spouses.",
    input_schema: {
      type: "object",
      properties: { person_id: { type: "string" } },
      required: ["person_id"],
    },
  },
  {
    name: "add_person",
    description:
      "Add a person by name. context = optional volunteered detail (e.g. 'born 1974'). Returns a warning if someone with this name already exists — then ask the user before retrying with allow_duplicate: true.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        context: { type: "string" },
        allow_duplicate: { type: "boolean" },
      },
      required: ["name"],
    },
  },
  {
    name: "add_parent_child",
    description:
      "Record that parent_id is a parent of child_id. Max 2 parents per child. Rejects edges that would create a cycle.",
    input_schema: {
      type: "object",
      properties: {
        parent_id: { type: "string" },
        child_id: { type: "string" },
        confirmed: {
          type: "boolean",
          description:
            "Pass true only after the user has explicitly confirmed which same-named person to use. Required when a referenced person's name is shared by another person.",
        },
      },
      required: ["parent_id", "child_id"],
    },
  },
  {
    name: "add_spouse",
    description:
      "Record that two people are spouses. Undirected. Never implies a parent-child relationship.",
    input_schema: {
      type: "object",
      properties: {
        person_a_id: { type: "string" },
        person_b_id: { type: "string" },
        confirmed: {
          type: "boolean",
          description:
            "Pass true only after the user has explicitly confirmed which same-named person to use. Required when a referenced person's name is shared by another person.",
        },
      },
      required: ["person_a_id", "person_b_id"],
    },
  },
  {
    name: "update_person",
    description:
      "Correct a person's name or context in place. Use this for corrections instead of creating a new person.",
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "string" },
        name: { type: "string" },
        context: { type: "string" },
        confirmed: {
          type: "boolean",
          description:
            "Pass true only after the user has explicitly confirmed which same-named person to update. Required when the person's name is shared by another person.",
        },
      },
      required: ["person_id"],
    },
  },
  {
    name: "remove_relationship",
    description:
      "Remove a wrong relationship. For 'parent', person_a_id is the parent and person_b_id is the child. Follow with re-adding the correct edge.",
    input_schema: {
      type: "object",
      properties: {
        relationship_type: { type: "string" },
        person_a_id: { type: "string" },
        person_b_id: { type: "string" },
        confirmed: {
          type: "boolean",
          description:
            "Pass true only after the user has explicitly confirmed which same-named person to use. Required when a referenced person's name is shared by another person.",
        },
      },
      required: ["relationship_type", "person_a_id", "person_b_id"],
    },
  },
  {
    name: "finish",
    description: "Call this exactly once, as your final action of every turn. reply = the message the user will see. applied = whether the tree actually changed this turn — true only if at least one tool result above shows changed: true.",
    input_schema: {
      type: "object",
      properties: {
        reply: { type: "string", description: "Your message to the user" },
        applied: { type: "boolean", description: "true only if some tool result had changed: true" },
      },
      required: ["reply", "applied"],
    },
  },
];

// dispatch is sync by design — deliberately not awaited. See note in tools.js.
function dispatch(store, name, input) {
  switch (name) {
    case "find_people":
      return store.findByName(input.name);
    case "get_person":
      return store.getPerson(input.person_id);
    case "add_person":
      return store.addPerson({ name: input.name, context: input.context, allowDuplicate: input.allow_duplicate });
    case "add_parent_child":
      return store.addParentEdge(input.parent_id, input.child_id, input.confirmed);
    case "add_spouse":
      return store.addSpouseEdge(input.person_a_id, input.person_b_id, input.confirmed);
    case "update_person":
      return store.updatePerson(input.person_id, { name: input.name, context: input.context }, input.confirmed);
    case "remove_relationship":
      return store.removeRelationship(input.relationship_type, input.person_a_id, input.person_b_id, input.confirmed);
    // no case for finish: unknown-name error is the safety net; the loop is its only handler
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// executeTool is SYNCHRONOUS by design: better-sqlite3 is a sync driver and every
// GraphStore method is sync, so a mutation (validate -> write -> memory update)
// completes atomically within one event-loop tick — that's why we need no locks.
// Do not make tools or the store async without revisiting runAgentLoop and the
// finish validator. See README.
export function executeTool(store, name, input) {
  const started = Date.now();
  metrics.toolCall(name);
  try {
    const result = dispatch(store, name, input ?? {});
    auditLog.info("tool_call", { tool: name, input, result, ok: true, durationMs: Date.now() - started });
    return { result, isError: false };
  } catch (err) {
    metrics.toolError(name);
    auditLog.error("tool_call", { tool: name, input, error: err.message, ok: false, durationMs: Date.now() - started });
    return { result: { error: err.message }, isError: true };
  }
}
