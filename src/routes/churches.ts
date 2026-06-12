import { Hono } from "hono";
import { findChurches } from "../agents/churchFinder.js";
import type { Church, ChurchSearchParams } from "../agents/churchFinder.js";
import {
  saveChurches,
  getChurches,
  updateChurchEmail,
  deleteChurch,
} from "../lib/supabase.js";

export const churchesRouter = new Hono();

function parseSearchParams(body: Record<string, unknown>): ChurchSearchParams {
  return {
    city: String(body.city ?? "").trim(),
    state: String(body.state ?? "").trim(),
    congregationMin: body.congregationMin !== undefined ? Number(body.congregationMin) : undefined,
    congregationMax: body.congregationMax !== undefined ? Number(body.congregationMax) : undefined,
    targetTier: body.targetTier !== undefined ? (Number(body.targetTier) as 1 | 2 | 3) : undefined,
    hasWebsite: body.hasWebsite !== undefined ? Boolean(body.hasWebsite) : undefined,
    hasStaff: body.hasStaff !== undefined ? Boolean(body.hasStaff) : undefined,
    denomination: body.denomination !== undefined ? String(body.denomination) : undefined,
    growthStage: body.growthStage as ChurchSearchParams["growthStage"] | undefined,
  };
}

// Find churches via AI (no storage)
churchesRouter.post("/find", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();

  if (!body.city || !body.state) {
    return c.json({ error: "city and state are required" }, 400);
  }

  const params = parseSearchParams(body);
  const result = await findChurches(params);
  return c.json(result);
});

// Find churches via AI and save to DB
churchesRouter.post("/find-and-save", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();

  if (!body.city || !body.state) {
    return c.json({ error: "city and state are required" }, 400);
  }

  const params = parseSearchParams(body);
  const { city, state, churches } = await findChurches(params);

  const saved = await saveChurches(
    churches.map((ch: Church) => ({ ...ch, city, state }))
  );

  return c.json({ city, state, churches: saved });
});

// List saved churches (optionally filter by city/state)
churchesRouter.get("/", async (c) => {
  const city = c.req.query("city");
  const state = c.req.query("state");
  const churches = await getChurches(city, state);
  return c.json({ churches });
});

// Update a church's email address
churchesRouter.patch("/:id/email", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ email: string }>();

  if (!body.email) {
    return c.json({ error: "email is required" }, 400);
  }

  const church = await updateChurchEmail(id, body.email.trim());
  return c.json({ church });
});

// Delete a saved church
churchesRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await deleteChurch(id);
  return c.json({ success: true });
});
