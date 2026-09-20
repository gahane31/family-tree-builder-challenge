// LLM client: callLLM with retry on 429/5xx. SYSTEM_PROMPT/TOOLS live in agent/.
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "../agent/prompt.js";
import { createLogger } from "../helpers/logger.js";
import { metrics } from "../helpers/metrics.js";

const log = createLogger("llm");

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
});

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

const BACKOFF_MS = [500, 1500];

function isRetryable(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

export async function callLLM(messages, tools) {
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    metrics.inc("llmCalls");
    try {
      return await anthropic.messages.create({
        model: MODEL,
        //max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1 && isRetryable(err)) {
        metrics.inc("llmRetries");
        log.warn("llm retry", { attempt: attempt + 1, status: err?.status, message: err.message });
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
