import Anthropic from "@anthropic-ai/sdk";
import { supabase, insertOutreachRecord } from "../lib/supabase.js";
import { sendEmail } from "../lib/mailer.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FROM_EMAIL = process.env.OUTREACH_FROM_EMAIL ?? "outreach@sisterclark.com";

// Days to wait before the next follow-up after each sequence step
const NEXT_DELAY_DAYS: Record<number, number> = { 1: 4, 2: 7, 3: 7 };

interface SequenceRow {
  id: string;
  church_id: string;
  email: string;
  sequence_number: number;
  status: string;
  church: { name: string; denomination?: string; congregation?: number } | null;
}

async function generateFollowUp(
  churchName: string,
  denomination: string | undefined,
  congregationSize: number | undefined,
  sequenceNumber: number
): Promise<{ subject: string; body: string }> {
  const prompts: Record<number, string> = {
    1: `Write a short, casual follow-up email for Sister Clark (a church AI phone receptionist service) to ${churchName}.
This is follow-up #1 (day 3 after the initial email).
Tone: friendly, no pressure, 3-4 sentences.
Subject line should be: "Re: Sister Clark for ${churchName}"
Just ask if they had a chance to review the previous email. Sign off as Sister Clark's team.
Return JSON: { "subject": "...", "body": "..." }`,

    2: `Write a value-add follow-up email for Sister Clark to ${churchName} (${denomination ?? "church"}, ~${congregationSize ?? "unknown"} members).
This is follow-up #2 (day 7). Focus on a specific use case: churches using Sister Clark never miss a prayer request or urgent pastoral call.
Tailor the use case to their denomination and congregation size. 4-5 sentences.
Sign off as Sister Clark's team.
Return JSON: { "subject": "...", "body": "..." }`,

    3: `Write a ROI-focused follow-up email for Sister Clark to ${churchName}.
This is follow-up #3 (day 14). Focus on the cost of missed calls vs the cost of Sister Clark — frame it as a simple ROI decision, not a features pitch.
Keep it under 6 sentences. No fluff. Sign off as Sister Clark's team.
Return JSON: { "subject": "...", "body": "..." }`,

    4: `Write a final "breakup" follow-up email for Sister Clark to ${churchName}.
This is follow-up #4 (day 21) — the last one. Keep it short (3 sentences max), respectful, and leave the door open.
End with something like: "I won't reach out again, but Sister Clark will be here when you're ready."
Sign off as Sister Clark's team.
Return JSON: { "subject": "...", "body": "..." }`,
  };

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    messages: [{ role: "user", content: prompts[sequenceNumber] }],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Could not parse follow-up email JSON for sequence ${sequenceNumber}`);
  return JSON.parse(jsonMatch[0]) as { subject: string; body: string };
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export async function processFollowUps(): Promise<{
  processed: number;
  sent: number;
  failed: number;
  details: Array<{ church: string; sequence: number; status: string; error?: string }>;
}> {
  const now = new Date().toISOString();

  const { data: due, error } = await supabase
    .from("follow_up_sequences")
    .select("id, church_id, email, sequence_number, status, church:churches(name, denomination, congregation)")
    .eq("status", "active")
    .lte("next_follow_up_at", now);

  if (error) throw error;
  if (!due || due.length === 0) return { processed: 0, sent: 0, failed: 0, details: [] };

  let sent = 0;
  let failed = 0;
  const details: Array<{ church: string; sequence: number; status: string; error?: string }> = [];

  await Promise.all(
    (due as unknown as SequenceRow[]).map(async (seq) => {
      const churchName = seq.church?.name ?? "your church";
      const nextSeq = seq.sequence_number + 1;

      try {
        const { subject, body } = await generateFollowUp(
          churchName,
          seq.church?.denomination,
          seq.church?.congregation,
          nextSeq
        );

        await sendEmail({ from: FROM_EMAIL, to: seq.email, subject, text: body });

        await insertOutreachRecord({
          church_name: churchName,
          email: seq.email,
          email_subject: subject,
          email_body: body,
          status: "sent",
        });

        // Update the sequence record
        const nextDelay = NEXT_DELAY_DAYS[nextSeq];
        const isComplete = nextSeq >= 4 || !nextDelay;

        await supabase
          .from("follow_up_sequences")
          .update({
            sequence_number: nextSeq,
            last_sent_at: new Date().toISOString(),
            next_follow_up_at: nextDelay ? addDays(new Date(), nextDelay).toISOString() : null,
            status: isComplete ? "completed" : "active",
          })
          .eq("id", seq.id);

        sent++;
        details.push({ church: churchName, sequence: nextSeq, status: isComplete ? "completed" : "sent" });
      } catch (err) {
        failed++;
        details.push({
          church: churchName,
          sequence: nextSeq,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );

  return { processed: due.length, sent, failed, details };
}

export async function getFollowUpStatus() {
  const { data, error } = await supabase
    .from("follow_up_sequences")
    .select("status, sequence_number, next_follow_up_at");
  if (error) throw error;

  const rows = data ?? [];
  const now = new Date();

  const active = rows.filter((r) => r.status === "active");
  const dueToday = active.filter((r) => r.next_follow_up_at && new Date(r.next_follow_up_at) <= now);

  const bySequence: Record<number, number> = {};
  for (const r of active) {
    bySequence[r.sequence_number] = (bySequence[r.sequence_number] ?? 0) + 1;
  }

  const { count: totalSent } = await supabase
    .from("outreach_history")
    .select("*", { count: "exact", head: true });

  return {
    total_active: active.length,
    due_today: dueToday.length,
    by_sequence_number: bySequence,
    total_outreach_sent: totalSent ?? 0,
    total_sequences: rows.length,
    breakdown_by_status: {
      active: active.length,
      completed: rows.filter((r) => r.status === "completed").length,
      responded: rows.filter((r) => r.status === "responded").length,
      unsubscribed: rows.filter((r) => r.status === "unsubscribed").length,
    },
  };
}
