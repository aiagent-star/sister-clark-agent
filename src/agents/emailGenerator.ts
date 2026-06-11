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

export async function generateOutreachEmail(
  church: Church,
  senderName: string,
  senderOrganization: string
): Promise<OutreachEmail> {
  const churchDetails = [
    `Name: ${church.name}`,
    `Denomination: ${church.denomination}`,
    church.address ? `Address: ${church.address}` : null,
    church.notes ? `Notes: ${church.notes}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `You are a warm, professional outreach coordinator writing on behalf of ${senderName} from ${senderOrganization}.

Write a personalized outreach email to the following church. The email should:
- Open with a warm, specific greeting referencing their church by name
- Briefly introduce ${senderName} and ${senderOrganization}
- Express genuine interest in partnership, community collaboration, or fellowship
- Reference the church's denomination or community focus naturally where it fits
- Close with a clear, low-pressure call to action (e.g., a brief call or coffee meeting)
- Keep the tone warm, respectful, and sincere — not salesy

Church details:
${churchDetails}

Return ONLY valid JSON with no prose:
{
  "subject": "Email subject line",
  "body": "Full email body text"
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

export async function generateOutreachEmails(
  churches: Church[],
  senderName: string,
  senderOrganization: string
): Promise<OutreachEmail[]> {
  return Promise.all(
    churches.map((church) =>
      generateOutreachEmail(church, senderName, senderOrganization)
    )
  );
}
