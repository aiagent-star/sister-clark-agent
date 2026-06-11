import { Hono } from "hono";
import { findChurches } from "../agents/churchFinder.js";
import type { Church } from "../agents/churchFinder.js";
import {
  saveChurches,
  getChurches,
  updateChurchEmail,
  deleteChurch,
} from "../lib/supabase.js";

export const churchesRouter = new Hono();

// Find churches via AI (no storage)
churchesRouter.post("/find", async (c) => {
  const body = await c.req.json<{ city: string; state: string }>();
  const { city, state } = body;

  if (!city || !state) {
    return c.json({ error: "city and state are required" }, 400);
  }

  const result = await findChurches(city.trim(), state.trim());
  return c.json(result);
});

// Find churches via AI and save to DB
churchesRouter.post("/find-and-save", async (c) => {
  const body = await c.req.json<{ city: string; state: string }>();
  const { city, state } = body;

  if (!city || !state) {
    return c.json({ error: "city and state are required" }, 400);
  }

  const { churches } = await findChurches(city.trim(), state.trim());

  const saved = await saveChurches(
    churches.map((ch: Church) => ({ ...ch, city: city.trim(), state: state.trim() }))
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
