import { Router } from "express";
import { runAgentLoop } from "../agent/loop.js";
import { createLogger } from "../helpers/logger.js";
import { metrics } from "../helpers/metrics.js";

const log = createLogger("chat");
export const chatRouter = Router();

chatRouter.post("/", async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "messages must be an array" });
  }
  metrics.inc("chatRequests");
  try {
    const reply = await runAgentLoop(messages);
    res.json({ reply });
  } catch (err) {
    log.error("chat failed", { error: err.message });
    res.status(502).json({ error: "LLM request failed" });
  }
});
