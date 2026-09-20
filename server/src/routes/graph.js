import { Router } from "express";
import { store } from "../graph/instance.js";

export const graphRouter = Router();

graphRouter.get("/", (_req, res) => {
  res.json(store.toJSON());
});
