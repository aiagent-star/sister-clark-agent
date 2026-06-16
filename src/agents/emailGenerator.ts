import Anthropic from "@anthropic-ai/sdk";
import type { Church } from "./churchFinder.js";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export interface OutreachEmail {
  church: Church;
  subject: string;
  body: string;
}

const SIGNATURE = `With warmth and respect,
James Kirklin II
Founder, Sister Clark
404-860-2775
support@theintellectualstew.com
sisterclark.com`;

function tierGuidance(tier: number | undefined): string {
  if (tier === 0) return `This church maps to the Economy tier ($97/month, $50 deposit, 100 minutes). Lead with accessibility — "no church is too small," low-commitment entry point, easy setup. Do NOT mention higher-tier pricing.`;
  if (tier === 1) return `This church maps to the Essential tier ($197/month, $100 deposit, 250 minutes). Emphasize it is built for small, growing churches — affordable, no large IT team needed.`;
  if (tier === 2) return `This church maps to the Enterprise tier ($297/month, $150 deposit, 500 minutes). Emphasize reliable coverage that scales with a mid-size congregation.`;
  if (tier === 3) return `This church maps to the Executive tier ($597/month, $250 deposit, 1,000 minutes). Emphasize full-coverage for a large congregation — high call volume, 24/7 reliability, intelligent routing.`;
  return `Do not mention specific pricing.`;
}

export async function generateOutreachEmail(
  church: Church,
  _senderName: string,
  _senderOrganization: string
): Promise<OutreachEmail> {
  const churchDetails = [
    `Name: ${church.name}`,
    church.denomination ? `Denomination: ${church.denomination}` : null,
    (church as { city?: string; state?: string }).city
      ? `City: ${(church as { city?: string }).city}, ${(church as { state?: string }).state ?? ""}`
      : null,
    (church as { congregation?: number }).congregation
      ? `Congregation size: ~${(church as { congregation?: number }).congregation}`
      : null,
    church.notes ? `Notes about this church: ${church.notes}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `You are writing a cold outreach email FROM James Kirklin II, founder of Sister Clark — an AI voice receptionist SaaS built specifically for churches.

Sister Clark answers every call 24/7, handles prayer requests, takes messages, routes urgent calls to the pastor, and ensures no member ever reaches voicemail. It is set up in minutes and designed for churches of all sizes — from small congregations to large ministries.

Tier context for this church: ${tierGuidance(church.tierRecommendation)}

Write a warm, personal outreach email TO the following church. Rules:
- James is the sender — write in first person as James ("I", "my", "I built")
- Open with James briefly introducing himself and why he is reaching out to THIS specific church
- Reference the church's denomination, congregation size, or city naturally to show this is not a mass email
- Explain Sister Clark in 2-3 sentences — what it does, why it matters for THIS church's size and context
- If you mention pricing, use only the tier-specific price and deposit from the tier context above — no other figures
- Make a soft ask: a 15-minute call or a quick demo, no pressure
- Keep the tone warm, pastoral, and sincere — never corporate or salesy
- End with EXACTLY this signature, no changes:

${SIGNATURE}

IMPORTANT: Do NOT use any placeholder text like [Phone Number], [Email], [Website], [Your Name], or similar. The signature above is complete and final.

Church details:
${churchDetails}

Return ONLY valid JSON:
{
  "subject": "Email subject line",
  "body": "Full email body text including the signature at the end"
}`,
      },
    ],
  });

  const content = message.content[0];
  if (content.type !== "text") {
    throw new Error("Unexpected response type from Claude");
  }

  const jsonMatch = content.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Could not parse email from Claude response");
  }

  const { subject, body } = JSON.parse(jsonMatch[0]);
  return { church, subject, body };
}

const RATE_LIMIT_DELAY_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export async function generateOutreachEmails(
  churches: Church[],
  senderName: string,
  senderOrganization: string
): Promise<OutreachEmail[]> {
  const results: OutreachEmail[] = [];

  for (let i = 0; i < churches.length; i++) {
    if (i > 0) await sleep(RATE_LIMIT_DELAY_MS);

    try {
      const email = await generateOutreachEmail(churches[i], senderName, senderOrganization);
      results.push(email);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("rate_limit") || message.includes("429") || message.includes("Rate limit")) {
        throw new RateLimitError(`Rate limit reached after generating ${results.length} email(s)`);
      }
      throw err;
    }
  }

  return results;
}
