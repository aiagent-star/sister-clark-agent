import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

function normalizeUrl(url: string): string {
  if (!url) return url;
  url = url.trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  return url.replace(/\/$/, "");
}

export interface FetchResult {
  url: string;
  status?: number;
  emails: string[];
  error?: string;
}

async function fetchPage(url: string): Promise<FetchResult> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(10000),
      redirect: "follow",
    });

    if (!res.ok) {
      return { url, status: res.status, emails: [], error: `HTTP ${res.status}` };
    }

    const html = await res.text();

    // Extract mailto: hrefs BEFORE stripping tags — this is where most church emails live
    const mailtoEmails: string[] = [];
    const mailtoRe = /href\s*=\s*["']mailto:([^"'?#\s]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = mailtoRe.exec(html)) !== null) {
      mailtoEmails.push(m[1].toLowerCase());
    }

    // Also run regex over stripped plain text for emails written out in body copy
    const plainText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 12000);
    const textEmails = (plainText.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase());

    const all = [...new Set([...mailtoEmails, ...textEmails])].filter(
      (e) => !e.match(/\.(png|jpg|jpeg|gif|svg|webp|woff|css|js)$/i)
    );

    return { url, status: res.status, emails: all };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { url, emails: [], error: msg };
  }
}

function candidateUrls(base: string): string[] {
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
): Promise<{ email: string | null; log: FetchResult[] }> {
  const log: FetchResult[] = [];

  if (website) {
    const base = normalizeUrl(website);
    const pages = await Promise.all(candidateUrls(base).map(fetchPage));
    log.push(...pages);

    // Collect all unique emails across all pages
    const allEmails = [...new Set(pages.flatMap((p) => p.emails))];

    if (allEmails.length === 1) {
      return { email: allEmails[0], log };
    }

    if (allEmails.length > 1) {
      // Let Claude pick the best one from the list
      const message = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: `Pick the best general contact email for ${churchName} from this list. Prefer info@, contact@, or office@ addresses over personal names. Reply with ONLY the email address, nothing else.\n\nEmails found: ${allEmails.join(", ")}`,
          },
        ],
      });
      const text = message.content[0].type === "text" ? message.content[0].text.trim().toLowerCase() : "";
      const valid = text.match(/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/);
      return { email: valid ? text : allEmails[0], log };
    }
  }

  // No emails found via scraping — ask Claude to reason from scraped text
  const scrapedText = log
    .filter((p) => !p.error && p.status === 200)
    .map((p, i) => `--- Page ${i + 1}: ${p.url} ---\n(no emails found in page text)`)
    .join("\n\n");

  if (!scrapedText && !website) {
    return { email: null, log };
  }

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 128,
    messages: [
      {
        role: "user",
        content: `You are an email extraction assistant. Find a contact email for ${churchName} (website: ${website ?? "unknown"}).
${scrapedText ? `Scraped pages:\n${scrapedText}\n` : ""}
Based on the church name and website domain, suggest the most likely contact email (e.g. info@domain.com).
If you truly cannot determine an email, reply with exactly: null
Reply with ONLY the email address or null.`,
      },
    ],
  });

  const text = message.content[0].type === "text" ? message.content[0].text.trim().toLowerCase() : "";
  if (text === "null" || text === "") return { email: null, log };
  const valid = text.match(/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/);
  return { email: valid ? text : null, log };
}
