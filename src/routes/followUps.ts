import { Hono } from "hono";
import { processFollowUps, getFollowUpStatus } from "../agents/followUpAgent.js";

export const followUpsRouter = new Hono();

// POST /follow-ups/process — trigger follow-up agent (called by cron or manually)
followUpsRouter.post("/process", async (c) => {
  const result = await processFollowUps();
  return c.json(result);
});

// GET /follow-ups/status — dashboard summary
followUpsRouter.get("/status", async (c) => {
  const status = await getFollowUpStatus();
  return c.json(status);
});
