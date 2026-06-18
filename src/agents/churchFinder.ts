import Anthropic from "@anthropic-ai/sdk";
import { searchChurches } from "../lib/googlePlaces.js";
import type { PlaceResult } from "../lib/googlePlaces.js";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export interface Church {
  id?: string;
  name: string;
  city?: string;
  state?: string;
  denomination: string;
  address?: string;
  phone?: string;
  website?: string;
  email?: string;
  notes?: string;
  placeId?: string;
  rating?: number;
  totalReviews?: number;
  congregationSize?: number;
  staffCount?: number;
  growthStage?: "established" | "growing" | "new-plant";
  fitScore: number;
  tierRecommendation: 0 | 1 | 2 | 3;
  fitReason: string;
}

export interface ChurchSearchParams {
  city: string;
  state: string;
  zipCode?: string;
  radiusMiles?: number;
  congregationMin?: number;
  congregationMax?: number;
  targetTier?: 0 | 1 | 2 | 3;
  hasWebsite?: boolean;
  hasStaff?: boolean;
  denomination?: string;
  growthStage?: "established" | "growing" | "new-plant";
}

export interface ChurchFinderResult {
  city: string;
  state: string;
  churches: Church[];
}

function buildScoringPrompt(
  places: PlaceResult[],
  params: ChurchSearchParams
): string {
  const filters: string[] = [];
  if (params.congregationMin !== undefined || params.congregationMax !== undefined) {
    const min = params.congregationMin ?? 0;
    const max = params.congregationMax ?? 99999;
    filters.push(`only include churches with estimated congregation size between ${min} and ${max}`);
  }
  if (params.growthStage) filters.push(`growth stage should be: ${params.growthStage}`);
  if (params.hasWebsite === true) filters.push("must have a website");
  if (params.hasStaff === true) filters.push("must have estimated paid staff");
  if (params.targetTier !== undefined) {
    const tierDesc = {
      0: "Tier 0 Economy (micro, under 75 members)",
      1: "Tier 1 Essential (small, 75–250 members)",
      2: "Tier 2 Enterprise (mid-size, 250–750 members)",
      3: "Tier 3 Executive (large, 750–2000 members)",
    }[params.targetTier];
    filters.push(`target tier: ${tierDesc}`);
  }

  const filterText = filters.length
    ? `\n\nApply these filters (exclude churches that don't match):\n${filters.map((f) => `- ${f}`).join("\n")}`
    : "";

  const churchList = JSON.stringify(places, null, 2);

  return `You are a church sales research assistant for Sister Clark, a church technology consultant.

Below is real data from Google Places for churches in ${params.city}, ${params.state}. For each church, you must:
1. Estimate congregation size based on review count and rating (more reviews + high rating = larger, active congregation)
2. Estimate staff count based on congregation size estimate
3. Determine growthStage: "growing" (active, increasing reviews, newer), "established" (stable, many reviews), or "new-plant" (very few reviews, possibly new)
4. Assign a fitScore (1–10) based on Sister Clark's ICP
5. Assign a tierRecommendation (1, 2, or 3)
6. Write a fitReason (one sentence)${filterText}

Sister Clark's ICP and tier definitions:
- Tier 0 Economy ($97/mo, 100 min): 1–75 members, 0 paid staff — micro churches and house churches with any budget. Score 7–9 if active/growing despite small size. Do NOT score small churches low just for being small.
- Tier 1 Essential ($197/mo, 250 min): 75–250 members, 0–1 paid staff — small churches modernizing. Score 8–10 if understaffed and growing.
- Tier 2 Enterprise ($297/mo, 500 min): 250–750 members, 2–5 staff — mid-size (SWEET SPOT). Score 8–10.
- Tier 3 Executive ($597/mo, 1,000 min): 750–2000 members, 6+ staff — large churches. Score 6–8.
- Bad fit (1–3): mega-church (2000+) with dedicated IT team, or clearly inactive/closed.

fitScore guidance:
- 9–10: Strong ICP match — understaffed, active, any size from micro to large
- 7–8: Good fit — some staff but still needs help, or small but clearly active
- 5–6: Neutral — unclear fit
- 3–4: Unlikely to need help (very large, well-staffed)
- 1–2: Mega-church IT team or closed/inactive

Church data from Google Places:
${churchList}

Return ONLY a JSON array with this structure (no prose):
[
  {
    "placeId": "the place_id from input",
    "name": "Church Name",
    "denomination": "your best estimate of denomination",
    "address": "address from input",
    "phone": "phone from input if present",
    "website": "website from input if present",
    "rating": 4.5,
    "totalReviews": 120,
    "congregationSize": 350,
    "staffCount": 3,
    "growthStage": "growing",
    "fitScore": 8,
    "tierRecommendation": 1,
    "fitReason": "One sentence explaining fit for Sister Clark."
  }
]`;
}

const BATCH_SIZE = 5;
const BATCH_STAGGER_MS = 300;
const SCORE_TIMEOUT_MS = 45_000;

async function scoreBatch(places: PlaceResult[], params: ChurchSearchParams): Promise<Church[]> {
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [{ role: "user", content: buildScoringPrompt(places, params) }],
  });

  const content = message.content[0];
  if (content.type !== "text") return [];
  const jsonMatch = content.text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  return JSON.parse(jsonMatch[0]) as Church[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function findChurches(
  params: ChurchSearchParams
): Promise<ChurchFinderResult & { partial?: boolean }> {
  // Step 1: Get real church data from Google Places, cap at 20
  const radiusMeters = params.radiusMiles !== undefined
    ? Math.round(params.radiusMiles * 1609)
    : undefined;
  const allPlaces = await searchChurches(params.city, params.state, params.denomination, params.zipCode, radiusMeters);
  const places = allPlaces.slice(0, 20);

  if (places.length === 0) {
    return { city: params.city, state: params.state, churches: [] };
  }

  // Step 2: Split into batches of 5, launch in parallel with staggered starts
  const batches: PlaceResult[][] = [];
  for (let i = 0; i < places.length; i += BATCH_SIZE) {
    batches.push(places.slice(i, i + BATCH_SIZE));
  }

  const deadline = Date.now() + SCORE_TIMEOUT_MS;
  const settled: Church[] = [];
  let partial = false;

  for (let idx = 0; idx < batches.length; idx++) {
    // If we're out of time, return what we have
    if (Date.now() >= deadline) { partial = true; break; }

    if (idx > 0) await sleep(BATCH_STAGGER_MS);

    // Race this batch against the remaining time
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      scoreBatch(batches[idx], params),
      sleep(remaining).then(() => null as Church[] | null),
    ]);

    if (result === null) { partial = true; break; }
    settled.push(...result);
  }

  const churches = settled.sort((a, b) => b.fitScore - a.fitScore);
  return { city: params.city, state: params.state, churches, ...(partial ? { partial: true } : {}) };
}
