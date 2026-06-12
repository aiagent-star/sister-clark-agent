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

async function parseBody(c: { req: { json: <T>() => Promise<T>; header: (k: string) => string | undefined } }): Promise<Record<string, unknown>> {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    return {};
  }
}

function coalesce(body: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (body[k] !== undefined) return body[k];
  return undefined;
}

function parseSearchParams(body: Record<string, unknown>): ChurchSearchParams {
  const minRaw = coalesce(body, "congregationMin", "minCongregation", "min_congregation");
  const maxRaw = coalesce(body, "congregationMax", "maxCongregation", "max_congregation");
  const tierRaw = coalesce(body, "targetTier", "target_tier");
  const stageRaw = coalesce(body, "growthStage", "growth_stage");
  const denomRaw = coalesce(body, "denomination");

  return {
    city: String(body.city ?? "").trim(),
    state: String(body.state ?? "").trim(),
    congregationMin: minRaw !== undefined ? Number(minRaw) : undefined,
    congregationMax: maxRaw !== undefined ? Number(maxRaw) : undefined,
    targetTier: tierRaw !== undefined ? (Number(tierRaw) as 1 | 2 | 3) : undefined,
    hasWebsite: body.hasWebsite !== undefined ? Boolean(body.hasWebsite) : undefined,
    hasStaff: body.hasStaff !== undefined ? Boolean(body.hasStaff) : undefined,
    denomination: denomRaw !== undefined ? String(denomRaw) : undefined,
    growthStage: stageRaw as ChurchSearchParams["growthStage"] | undefined,
  };
}

// Find churches via AI (no storage)
churchesRouter.post("/find", async (c) => {
  const body = await parseBody(c);

  if (!body.city || !body.state) {
    return c.json({ error: "city and state are required" }, 400);
  }

  const params = parseSearchParams(body);
  const result = await findChurches(params);
  return c.json(result);
});

// Find churches via AI and save to DB
churchesRouter.post("/find-and-save", async (c) => {
  const body = await parseBody(c);

  if (!body.city || !body.state) {
    return c.json({ error: "city and state are required — send JSON with Content-Type: application/json" }, 400);
  }

  const params = parseSearchParams(body);
  const { city, state, churches } = await findChurches(params);

  const saved = await saveChurches(
    churches.map((ch: Church) => ({
      name: ch.name,
      denomination: ch.denomination,
      address: ch.address,
      phone: ch.phone,
      website: ch.website,
      email: ch.email,
      city,
      state,
      notes: ch.fitReason ?? ch.notes,
    }))
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
