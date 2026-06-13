import { Hono } from "hono";
import {
  getPipeline,
  addToPipeline,
  updatePipelineRecord,
  deletePipelineRecord,
  getPipelineStats,
} from "../lib/supabase.js";
import type { PipelineStage } from "../lib/supabase.js";

export const pipelineRouter = new Hono();

// GET /pipeline — all records grouped by stage
pipelineRouter.get("/", async (c) => {
  const grouped = await getPipeline();
  return c.json({ pipeline: grouped });
});

// GET /pipeline/stats — counts, MRR, pipeline value
pipelineRouter.get("/stats", async (c) => {
  const stats = await getPipelineStats();
  return c.json(stats);
});

// POST /pipeline — add a church to the pipeline
pipelineRouter.post("/", async (c) => {
  const body = await c.req.json<{ church_id: string; stage?: PipelineStage }>();

  if (!body.church_id) {
    return c.json({ error: "church_id is required" }, 400);
  }

  const record = await addToPipeline(body.church_id, body.stage ?? "identified");
  return c.json({ record }, 201);
});

// PATCH /pipeline/:id — update a pipeline record
pipelineRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    stage?: PipelineStage;
    notes?: string;
    tier_interest?: number;
    expected_close_date?: string;
    monthly_revenue?: number;
    lost_reason?: string;
  }>();

  const record = await updatePipelineRecord(id, body);
  return c.json({ record });
});

// DELETE /pipeline/:id
pipelineRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await deletePipelineRecord(id);
  return c.json({ success: true });
});
