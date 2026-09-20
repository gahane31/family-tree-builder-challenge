import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { GraphStore } from "../src/graph/store.js";
import { runAgentLoop, FALLBACK_NO_CHANGE, FALLBACK_CHANGED } from "../src/agent/loop.js";

function freshStore() {
  return new GraphStore(new Database(":memory:"));
}

function scriptedLLM(responses) {
  const calls = [];
  const fn = async (messages, _tools) => {
    calls.push(structuredClone(messages));
    return responses[calls.length - 1];
  };
  fn.calls = calls;
  return fn;
}

function textResponse(t) {
  return { stop_reason: "end_turn", content: [{ type: "text", text: t }] };
}

function toolUseResponse(id, name, input) {
  return {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id, name, input }],
  };
}

function finishResponse(id, reply, applied) {
  return toolUseResponse(id, "finish", { reply, applied });
}

test("ships on honest change: add_person then finish(true)", async () => {
  const store = freshStore();
  const llm = scriptedLLM([
    toolUseResponse("toolu_add_jon", "add_person", { name: "Jon" }),
    finishResponse("toolu_finish_ok", "Added Jon.", true),
  ]);

  const reply = await runAgentLoop([{ role: "user", content: "I am Jon" }], { callLLM: llm, store });

  assert.equal(reply, "Added Jon.");
  assert.ok(store.toJSON().people.some((p) => p.name === "Jon"));
  assert.equal(llm.calls.length, 2);
});

test("finish in the same response as its tools ships correctly", async () => {
  const store = freshStore();
  const llm = scriptedLLM([
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "toolu_add_jon", name: "add_person", input: { name: "Jon" } },
        { type: "tool_use", id: "toolu_finish_ok", name: "finish", input: { reply: "Added Jon.", applied: true } },
      ],
    },
  ]);

  const reply = await runAgentLoop([{ role: "user", content: "I am Jon" }], { callLLM: llm, store, maxRounds: 8 });

  assert.equal(reply, "Added Jon.");
  assert.equal(store.findByName("Jon").length, 1);
});

test("ships on honest no-change: find_people then finish(false)", async () => {
  const store = freshStore();
  const llm = scriptedLLM([
    toolUseResponse("toolu_find", "find_people", { name: "Jon" }),
    finishResponse("toolu_finish_none", "I don't have anyone named Jon yet.", false),
  ]);

  const reply = await runAgentLoop([{ role: "user", content: "Do you know Jon?" }], { callLLM: llm, store });

  assert.equal(reply, "I don't have anyone named Jon yet.");
  assert.equal(store.toJSON().people.length, 0);
  assert.equal(llm.calls.length, 2);

  const findTurn = llm.calls[1][llm.calls[1].length - 1];
  const tr = findTurn.content.find((b) => b.type === "tool_result" && b.tool_use_id === "toolu_find");
  // if the find itself errored, this test would silently test the wrong thing
  assert.ok(tr);
  assert.ok(!tr.is_error);
  assert.equal("error" in JSON.parse(tr.content), false);
});

test("hallucination bounced, then corrected", async () => {
  const store = freshStore();
  const finishId = "toolu_finish_halluc";
  const llm = scriptedLLM([
    finishResponse(finishId, "Added Jon.", true),
    toolUseResponse("toolu_add_jon", "add_person", { name: "Jon" }),
    finishResponse("toolu_finish_ok", "Added Jon.", true),
  ]);

  const reply = await runAgentLoop([{ role: "user", content: "I am Jon" }], { callLLM: llm, store });

  assert.equal(reply, "Added Jon.");
  assert.ok(store.toJSON().people.some((p) => p.name === "Jon"));
  assert.equal(llm.calls.length, 3);

  const secondCallMessages = llm.calls[1];
  const userTurn = secondCallMessages[secondCallMessages.length - 1];
  const tr = userTurn.content.find((b) => b.type === "tool_result" && b.tool_use_id === finishId);
  assert.ok(tr, "mismatch tool_result present for finish block");
  assert.equal(tr.is_error, true);
  assert.match(tr.content, /does not match reality/);
  assert.match(tr.content, /applied flag/);
});

test("under-claim bounced; mutation counter is not reset between rounds", async () => {
  const store = freshStore();
  const llm = scriptedLLM([
    toolUseResponse("toolu_add_jon", "add_person", { name: "Jon" }),
    finishResponse("toolu_finish_under", "Nothing changed.", false),
    finishResponse("toolu_finish_ok", "Added Jon.", true),
  ]);

  const reply = await runAgentLoop([{ role: "user", content: "I am Jon" }], { callLLM: llm, store });

  assert.equal(reply, "Added Jon.");
  assert.ok(store.toJSON().people.some((p) => p.name === "Jon"));
  assert.equal(llm.calls.length, 3);

  const bounceTurn = llm.calls[2][llm.calls[2].length - 1];
  const tr = bounceTurn.content.find((b) => b.type === "tool_result" && b.tool_use_id === "toolu_finish_under");
  assert.equal(tr.is_error, true);
  assert.match(tr.content, /does not match reality/);
});

test("pure no-op turn counts as zero: re-adding an existing edge then finish(false)", async () => {
  const store = freshStore();
  store.addPerson({ name: "Rob" });
  store.addPerson({ name: "Jon" });
  store.addParentEdge("1", "2");

  const llm = scriptedLLM([
    toolUseResponse("toolu_parent", "add_parent_child", { parent_id: "1", child_id: "2" }),
    finishResponse("toolu_finish_noop", "Already recorded.", false),
  ]);

  const reply = await runAgentLoop([{ role: "user", content: "Rob is Jon's father" }], { callLLM: llm, store });

  assert.equal(reply, "Already recorded.");
  assert.equal(store.toJSON().parentEdges.length, 1);
  assert.equal(llm.calls.length, 2);
});

test("never calls finish: text-only responses return FALLBACK_NO_CHANGE after maxRounds", async () => {
  const store = freshStore();
  let n = 0;
  const llm = async () => {
    n++;
    return textResponse("working on it");
  };

  const reply = await runAgentLoop([{ role: "user", content: "hi" }], { callLLM: llm, store, maxRounds: 6 });

  assert.equal(reply, FALLBACK_NO_CHANGE);
  assert.equal(n, 6);
  assert.equal(store.toJSON().people.length, 0);
});

test("budget exhausted with real mutations returns FALLBACK_CHANGED; change persisted", async () => {
  const store = freshStore();
  let n = 0;
  const llm = async () => {
    n++;
    if (n === 1) {
      return {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "toolu_add_jon", name: "add_person", input: { name: "Jon" } },
          { type: "tool_use", id: `toolu_finish_${n}`, name: "finish", input: { reply: "Added Jon.", applied: false } },
        ],
      };
    }
    return finishResponse(`toolu_finish_${n}`, "Added Jon.", false);
  };

  const reply = await runAgentLoop([{ role: "user", content: "I am Jon" }], { callLLM: llm, store, maxRounds: 4 });

  assert.equal(reply, FALLBACK_CHANGED);
  assert.ok(store.toJSON().people.some((p) => p.name === "Jon"));
  assert.equal(n, 4);
});
