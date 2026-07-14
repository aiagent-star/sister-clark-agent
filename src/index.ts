import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import cron from "node-cron";
import { churchesRouter } from "./routes/churches.js";
import { outreachRouter } from "./routes/outreach.js";
import { pipelineRouter } from "./routes/pipeline.js";
import { followUpsRouter } from "./routes/followUps.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { processFollowUps } from "./agents/followUpAgent.js";

const app = new Hono();

// Webhooks bypass CORS — Resend calls from their servers, not a browser
app.route("/webhooks", webhooksRouter);

app.use("*", cors({
  origin: (origin) => {
    const allowed = [
      "https://outreach.sisterclark.com",
      "https://sisterclark.com",
    ];
    // Allow Lovable preview/staging origins and local dev
    if (!origin) return "*";
    if (allowed.includes(origin)) return origin;
    if (origin.endsWith(".lovable.app") || origin.endsWith(".lovableproject.com")) return origin;
    if (origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")) return origin;
    return allowed[0]; // default — CORS header still sent, browser blocks non-matching
  },
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

app.get("/health", (c) => c.json({ status: "ok", agent: "Sister Clark" }));

app.route("/churches", churchesRouter);
app.route("/outreach", outreachRouter);
app.route("/pipeline", pipelineRouter);
app.route("/follow-ups", followUpsRouter);

const port = Number(process.env.PORT) || 3000;

const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`Sister Clark agent running on port ${port}`);

  // Run follow-up agent every day at 9am
  cron.schedule("0 9 * * *", async () => {
    console.log("[cron] Running follow-up agent...");
    try {
      const result = await processFollowUps();
      console.log(`[cron] Follow-ups processed: ${result.sent} sent, ${result.failed} failed`);
    } catch (err) {
      console.error("[cron] Follow-up agent error:", err);
    }
  });
});

process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
