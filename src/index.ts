import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { churchesRouter } from "./routes/churches.js";
import { outreachRouter } from "./routes/outreach.js";
import { pipelineRouter } from "./routes/pipeline.js";

const app = new Hono();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

app.get("/health", (c) => c.json({ status: "ok", agent: "Sister Clark" }));

app.route("/churches", churchesRouter);
app.route("/outreach", outreachRouter);
app.route("/pipeline", pipelineRouter);

const port = Number(process.env.PORT) || 3000;

const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`Sister Clark agent running on port ${port}`);
});

process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
