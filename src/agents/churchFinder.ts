import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export interface Church {
  name: string;
  denomination: string;
  address?: string;
  phone?: string;
  website?: string;
  email?: string;
  notes?: string;
}

export interface ChurchFinderResult {
  city: string;
  state: string;
  churches: Church[];
}

export async function findChurches(
  city: string,
  state: string
): Promise<ChurchFinderResult> {
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `You are a church outreach research assistant. Find target churches in ${city}, ${state} that would be receptive to outreach and community engagement. Focus on established congregations with active community programs.

Return a JSON array of churches with this structure (and nothing else — no prose, just valid JSON):
[
  {
    "name": "Church Name",
    "denomination": "Denomination",
    "address": "Street Address, City, State ZIP",
    "phone": "Phone number if known",
    "website": "Website URL if known",
    "email": "Contact email if known",
    "notes": "Brief note on why this church is a good outreach target"
  }
]

Aim for 5–10 churches. If you don't have specific data for a field, omit it.`,
      },
    ],
  });

  const content = message.content[0];
  if (content.type !== "text") {
    throw new Error("Unexpected response type from Claude");
  }

  const jsonMatch = content.text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error("Could not parse church list from Claude response");
  }

  const churches: Church[] = JSON.parse(jsonMatch[0]);
  return { city, state, churches };
}
