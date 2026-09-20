import "dotenv/config";
import express from "express";
import cors from "cors";
import { chatRouter } from "./routes/chat.js";
import { graphRouter } from "./routes/graph.js";
import { metrics } from "./helpers/metrics.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use("/api/chat", chatRouter);
app.use("/api/graph", graphRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/metrics", (_req, res) => res.json({result: metrics.snapshot()}));

app.listen(PORT, () => {
  console.log(`family-tree-builder server listening on http://localhost:${PORT}`);
});
