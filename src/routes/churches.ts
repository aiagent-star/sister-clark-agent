import { Hono } from "hono";
import { findChurches } from "../agents/churchFinder.js";
import type { Church, ChurchSearchParams } from "../agents/churchFinder.js";
import {
  saveChurches,
  getChurches,
  updateChurchEmail,
  deleteChurch,
  supabase,
} from "../lib/supabase.js";
import { extractChurchEmail } from "../agents/emailExtractor.js";

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
    zipCode: body.zipCode !== undefined ? String(body.zipCode).trim() : undefined,
    radiusMiles: body.radiusMiles !== undefined ? Number(body.radiusMiles) : undefined,
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
      zip_code: params.zipCode,
      notes: ch.fitReason ?? ch.notes,
    }))
  );

  return c.json({ city, state, churches: saved });
});

// List saved churches (optionally filter by city/state, with pagination)
churchesRouter.get("/", async (c) => {
  const city = c.req.query("city");
  const state = c.req.query("state");
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 50);
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
  const result = await getChurches(city, state, limit, offset);
  return c.json(result);
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

// Extract and save email for a single church
churchesRouter.post("/:id/extract-email", async (c) => {
  const id = c.req.param("id");

  const { data: church, error } = await supabase
    .from("churches")
    .select("id, name, website, email")
    .eq("id", id)
    .single();

  if (error || !church) {
    return c.json({ error: "Church not found" }, 404);
  }

  const { email, log } = await extractChurchEmail(church.name, church.website);

  if (email) {
    await updateChurchEmail(id, email);
  }

  return c.json({ id, name: church.name, email: email ?? null, updated: !!email, log });
});

// GET /churches/extract-progress — how many churches have/lack emails
churchesRouter.get("/extract-progress", async (c) => {
  const [{ count: total }, { count: remaining }] = await Promise.all([
    supabase.from("churches").select("*", { count: "exact", head: true }),
    supabase.from("churches").select("*", { count: "exact", head: true }).or("email.is.null,email.eq."),
  ]);
  const processed = (total ?? 0) - (remaining ?? 0);
  return c.json({ total: total ?? 0, processed, remaining: remaining ?? 0, done: (remaining ?? 0) === 0 });
});

// Scoring function: count how many key fields are populated
function completenessScore(ch: Record<string, unknown>): number {
  return [ch.email, ch.phone, ch.website, ch.address, ch.denomination].filter(Boolean).length;
}

// GET /churches/duplicates — preview duplicate groups without deleting
churchesRouter.get("/duplicates", async (c) => {
  const { data, error } = await supabase
    .from("churches")
    .select("id, name, city, state, email, phone, website, address, denomination");
  if (error) throw error;

  const groups = new Map<string, typeof data>();
  for (const ch of data ?? []) {
    const key = `${ch.name?.trim().toLowerCase()}|${ch.city?.trim().toLowerCase()}|${ch.state?.trim().toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ch);
  }

  const duplicateGroups = [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const sorted = [...g].sort((a, b) => completenessScore(b) - completenessScore(a));
      return {
        name: sorted[0].name,
        city: sorted[0].city,
        state: sorted[0].state,
        count: g.length,
        would_keep: sorted[0],
        would_delete: sorted.slice(1),
      };
    });

  return c.json({
    duplicateGroupsFound: duplicateGroups.length,
    totalDuplicateChurches: duplicateGroups.reduce((sum, g) => sum + g.would_delete.length, 0),
    groups: duplicateGroups,
  });
});

// POST /churches/dedupe — delete duplicates, keeping the most complete record per group
churchesRouter.post("/dedupe", async (c) => {
  const { data, error } = await supabase
    .from("churches")
    .select("id, name, city, state, email, phone, website, address, denomination");
  if (error) throw error;

  const groups = new Map<string, typeof data>();
  for (const ch of data ?? []) {
    const key = `${ch.name?.trim().toLowerCase()}|${ch.city?.trim().toLowerCase()}|${ch.state?.trim().toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ch);
  }

  const duplicateGroups = [...groups.values()].filter((g) => g.length > 1);

  if (duplicateGroups.length === 0) {
    return c.json({ duplicateGroupsFound: 0, churchesRemoved: 0, churchesKept: 0 });
  }

  const idsToDelete: string[] = [];
  for (const group of duplicateGroups) {
    const sorted = [...group].sort((a, b) => completenessScore(b) - completenessScore(a));
    idsToDelete.push(...sorted.slice(1).map((ch) => ch.id));
  }

  const { error: deleteError } = await supabase
    .from("churches")
    .delete()
    .in("id", idsToDelete);
  if (deleteError) throw deleteError;

  return c.json({
    duplicateGroupsFound: duplicateGroups.length,
    churchesRemoved: idsToDelete.length,
    churchesKept: duplicateGroups.length,
  });
});

// Extract emails one batch of 10 at a time — call repeatedly until remaining reaches 0
churchesRouter.post("/extract-all-emails", async (c) => {
  const BATCH_SIZE = 10;

  const { data: batch, error } = await supabase
    .from("churches")
    .select("id, name, website, email")
    .or("email.is.null,email.eq.")
    .limit(BATCH_SIZE);

  if (error) throw error;

  if (!batch || batch.length === 0) {
    return c.json({ message: "All churches already have emails", updated: 0, processed: 0, remaining: 0, results: [] });
  }

  const results = await Promise.allSettled(
    batch.map(async (ch) => {
      const { email, log } = await extractChurchEmail(ch.name, ch.website);
      if (email) await updateChurchEmail(ch.id, email);
      return {
        id: ch.id,
        name: ch.name,
        website: ch.website,
        email: email ?? null,
        updated: !!email,
        pages_checked: log.length,
        errors: log.filter((p) => p.error).map((p) => ({ url: p.url, error: p.error })),
      };
    })
  );

  const settled = results.map((r) =>
    r.status === "fulfilled" ? r.value : { error: r.reason?.message }
  );

  const updatedCount = settled.filter((r) => "updated" in r && r.updated).length;

  // Get fresh remaining count after updates
  const { count: remaining } = await supabase
    .from("churches")
    .select("*", { count: "exact", head: true })
    .or("email.is.null,email.eq.");

  return c.json({
    updated: updatedCount,
    processed: batch.length,
    remaining: remaining ?? 0,
    done: (remaining ?? 0) === 0,
    results: settled,
  });
});
