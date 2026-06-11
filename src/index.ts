import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { churchesRouter } from "./routes/churches.js";
import { outreachRouter } from "./routes/outreach.js";

const app = new Hono();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

app.get("/health", (c) => c.json({ status: "ok", agent: "Sister Clark" }));

app.route("/churches", churchesRouter);
app.route("/outreach", outreachRouter);

const port = Number(process.env.PORT) || 3000;

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`Sister Clark agent running on port ${port}`);
});

process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
