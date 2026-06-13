import Anthropic from "@anthropic-ai/sdk";
import { searchChurches } from "../lib/googlePlaces.js";
import type { PlaceResult } from "../lib/googlePlaces.js";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export interface Church {
  id?: string;
  name: string;
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
  tierRecommendation: 1 | 2 | 3;
  fitReason: string;
}

export interface ChurchSearchParams {
  city: string;
  state: string;
  congregationMin?: number;
  congregationMax?: number;
  targetTier?: 1 | 2 | 3;
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
    const tierDesc = { 1: "Tier 1 (small, under 200)", 2: "Tier 2 (mid-size, 200–800)", 3: "Tier 3 (large, 800+)" }[params.targetTier];
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

Sister Clark's ICP:
- Best fit (9–10): growing church, clearly understaffed, no obvious IT/admin team, 50–800 members
- Good fit (7–8): established church modernizing, moderate staff, 200–800 members
- Neutral (5–6): stable but unclear fit
- Poor fit (3–4): large, well-staffed church unlikely to need outside help
- Bad fit (1–2): mega-church with dedicated IT team or house church with no budget

Tier definitions:
- Tier 1: under 200 congregation, 0–1 paid staff
- Tier 2: 200–800 congregation, 2–5 staff (SWEET SPOT)
- Tier 3: 800+ congregation, 6+ staff

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
    "tierRecommendation": 2,
    "fitReason": "One sentence explaining fit for Sister Clark."
  }
]`;
}

export async function findChurches(
  params: ChurchSearchParams
): Promise<ChurchFinderResult> {
  // Step 1: Get real church data from Google Places
  const places = await searchChurches(params.city, params.state, params.denomination);

  if (places.length === 0) {
    return { city: params.city, state: params.state, churches: [] };
  }

  // Step 2: Pass real data to Claude for scoring and enrichment
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    messages: [
      {
        role: "user",
        content: buildScoringPrompt(places, params),
      },
    ],
  });

  const content = message.content[0];
  if (content.type !== "text") {
    throw new Error("Unexpected response type from Claude");
  }

  const jsonMatch = content.text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error("Could not parse church scoring from Claude response");
  }

  let churches: Church[] = JSON.parse(jsonMatch[0]);

  // Sort by fitScore descending
  churches = churches.sort((a, b) => b.fitScore - a.fitScore);

  return { city: params.city, state: params.state, churches };
}
