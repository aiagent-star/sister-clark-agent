import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ChurchEmailBot/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "";
    const html = await res.text();
    // Strip tags, collapse whitespace
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 8000);
  } catch {
    return "";
  }
}

function extractEmails(text: string): string[] {
  const matches = text.match(EMAIL_RE) ?? [];
  // Filter out common false positives (image names, CDN paths, etc.)
  return [...new Set(matches)].filter(
    (e) => !e.match(/\.(png|jpg|jpeg|gif|svg|webp|woff|css|js)$/i)
  );
}

function candidateUrls(website: string): string[] {
  const base = website.replace(/\/$/, "");
  return [
    base,
    `${base}/contact`,
    `${base}/contact-us`,
    `${base}/about`,
    `${base}/staff`,
    `${base}/about-us`,
  ];
}

export async function extractChurchEmail(
  churchName: string,
  website?: string | null
): Promise<string | null> {
  const pagesText: string[] = [];

  // Step 1: scrape candidate pages if we have a website
  if (website) {
    const pages = await Promise.all(candidateUrls(website).map(fetchText));
    pagesText.push(...pages.filter(Boolean));

    // Quick regex pass first — no Claude needed if obvious
    for (const text of pagesText) {
      const emails = extractEmails(text);
      if (emails.length === 1) return emails[0];
      // If multiple, let Claude pick the best one below
    }
  }

  // Step 2: build Claude prompt with all scraped text + fallback web hint
  const scrapedSection = pagesText.length
    ? `Here is text scraped from the church's website pages:\n\n${pagesText.map((t, i) => `--- Page ${i + 1} ---\n${t}`).join("\n\n")}`
    : "No website text was available.";

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: `You are an email extraction assistant. Find the best contact email address for this church:

Church name: ${churchName}
Website: ${website ?? "unknown"}

${scrapedSection}

Instructions:
- Look for a general contact email, info@ address, or pastor/office email
- Prefer generic addresses (info@, contact@, office@) over personal ones
- If you find multiple emails, pick the most appropriate contact email
- If no email is found, reply with exactly: null
- Reply with ONLY the email address or the word null — no other text`,
      },
    ],
  });

  const content = message.content[0];
  if (content.type !== "text") return null;

  const result = content.text.trim().toLowerCase();
  if (result === "null" || result === "") return null;

  // Validate it looks like an email
  const match = result.match(/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/);
  return match ? result : null;
}
