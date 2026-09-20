import { TOOLS, executeTool } from "./tools.js";
import { callLLM as defaultCallLLM } from "../llm/client.js";
import { store as defaultStore } from "../graph/instance.js";
import { metrics } from "../helpers/metrics.js";
import { createLogger } from "../helpers/logger.js";

const log = createLogger("loop");

export const FALLBACK_NO_CHANGE = "I wasn't able to complete that change — could you rephrase?";
export const FALLBACK_CHANGED = "I updated the tree but had trouble summarizing — the graph view shows the current state.";

// maxRounds is 8 (was 6): bounces and nudges consume rounds.
export async function runAgentLoop(messages, { callLLM = defaultCallLLM, store = defaultStore, maxRounds = 8 } = {}) {
  const conversation = messages.map((m) => ({ ...m })); // never mutate caller's array
  let mutations = 0; // code's ground truth, never reset

  for (let round = 0; round < maxRounds; round++) {
    const response = await callLLM(conversation, TOOLS);
    conversation.push({ role: "assistant", content: response.content });

    const toolResults = [];
    let finishBlock = null;
    for (const block of response.content) {
      log.info("block", { block });
      if (block.type !== "tool_use") continue;
      if (block.name === "finish") { finishBlock = block; continue; } // intercepted, never dispatched
      const { result, isError } = executeTool(store, block.name, block.input);
      if (!isError && result && result.changed === true) mutations++;
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
        is_error: isError,
      });
    }

    if (finishBlock) {
      const claimed = Boolean(finishBlock.input?.applied);
      if (claimed === (mutations > 0)) {
        const reply = finishBlock.input.reply;
        log.info("finish", { applied: claimed, mutations, reply });
        return reply; // narrative matches reality → ship
      }
      metrics.inc("finishMismatches");
      log.warn("finish flag mismatch", { claimed, mutations });
      toolResults.push({
        type: "tool_result",
        tool_use_id: finishBlock.id,
        is_error: true,
        content: JSON.stringify({
          error: `Your applied flag (${claimed}) does not match reality: ${mutations} change(s) were made this turn. ` +
                 `Re-check the tool results above (changed: true means the tree changed), then call finish again ` +
                 `with the correct flag and a reply describing what actually happened.`,
        }),
      });
      conversation.push({ role: "user", content: toolResults });
      continue;
    }

    if (toolResults.length > 0) { // still working, no finish yet
      conversation.push({ role: "user", content: toolResults });
      continue;
    }

    metrics.inc("finishNudges"); // plain text with no finish → one nudge
    log.info("finish nudge", { mutations });
    conversation.push({
      role: "user",
      content: "End your turn by calling the finish tool with your reply and the applied flag.",
    });
  }

  return mutations > 0 ? FALLBACK_CHANGED : FALLBACK_NO_CHANGE;
}
