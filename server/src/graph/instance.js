// Single GraphStore instance for the process. Import this when you need the
// live tree (routes, agent loop, tools). Tests can still `new GraphStore(db)`.
import { openDatabase } from "../db/db.js";
import { GraphStore } from "./store.js";

export const store = new GraphStore(openDatabase());
