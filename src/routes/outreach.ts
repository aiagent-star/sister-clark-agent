import { Hono } from "hono";
import { findChurches } from "../agents/churchFinder.js";
import { generateOutreachEmails, RateLimitError } from "../agents/emailGenerator.js";
import type { Church } from "../agents/churchFinder.js";
import { sendEmail } from "../lib/mailer.js";
import {
  insertOutreachRecord,
  getOutreachHistory,
  getChurches,
  addToPipeline,
  createFollowUpSequence,
  supabase,
} from "../lib/supabase.js";

export const outreachRouter = new Hono();

outreachRouter.post("/emails", async (c) => {
  const body = await c.req.json<{
    city: string;
    state: string;
    senderName: string;
    senderOrganization: string;
  }>();

  const { city, state, senderName, senderOrganization } = body;

  if (!city || !state || !senderName || !senderOrganization) {
    return c.json(
      { error: "city, state, senderName, and senderOrganization are required" },
      400
    );
  }

  const { churches } = await findChurches({ city: city.trim(), state: state.trim() });
  const emails = await generateOutreachEmails(
    churches,
    senderName,
    senderOrganization
  );

  return c.json({ city, state, senderName, senderOrganization, emails });
});

outreachRouter.post("/emails/from-churches", async (c) => {
  const body = await c.req.json<{
    churches: Church[];
    senderName: string;
    senderOrganization: string;
  }>();

  const { churches, senderName, senderOrganization } = body;

  if (!churches?.length || !senderName || !senderOrganization) {
    return c.json(
      {
        error:
          "churches (non-empty array), senderName, and senderOrganization are required",
      },
      400
    );
  }

  const emails = await generateOutreachEmails(
    churches,
    senderName,
    senderOrganization
  );

  return c.json({ senderName, senderOrganization, emails });
});

outreachRouter.post("/send", async (c) => {
  const body = await c.req.json<{
    city?: string;
    state?: string;
    churches?: Church[];
    churchIds?: string[];
    senderName: string;
    senderOrganization: string;
    fromEmail?: string;
    maxPerRun?: number;
  }>();

  const { senderName, senderOrganization } = body;
  const fromEmail = body.fromEmail ?? process.env.OUTREACH_FROM_EMAIL ?? "outreach@sisterclark.com";
  const maxPerRun = Math.min(body.maxPerRun ?? 5, 5);

  if (!senderName || !senderOrganization) {
    return c.json({ error: "senderName and senderOrganization are required" }, 400);
  }

  let churches: Church[];

  if (body.churchIds?.length) {
    const { data, error } = await supabase
      .from("churches")
      .select("*")
      .in("id", body.churchIds);
    if (error) throw error;
    if (!data?.length) {
      return c.json({ error: "No churches found for the provided churchIds" }, 404);
    }
    churches = data as Church[];
  } else if (body.city && body.state) {
    const { churches: saved } = await getChurches(body.city.trim(), body.state.trim(), 500, 0);
    if (!saved.length) {
      return c.json(
        { error: `No saved churches found for ${body.city}, ${body.state}. Use POST /churches/find-and-save first, then add emails via PATCH /churches/:id/email.` },
        404
      );
    }
    churches = saved as Church[];
  } else if (body.churches?.length) {
    churches = body.churches;
  } else {
    // No filter provided — fetch all churches with a non-null email up to maxPerRun
    const { data, error } = await supabase
      .from("churches")
      .select("*")
      .not("email", "is", null)
      .neq("email", "")
      .limit(maxPerRun);
    if (error) throw error;
    if (!data?.length) {
      return c.json({ error: "No churches with email addresses found. Extract emails first." }, 404);
    }
    churches = data as Church[];
  }

  if (!fromEmail) {
    return c.json(
      { error: "fromEmail is required (or set OUTREACH_FROM_EMAIL env var)" },
      400
    );
  }

  // Cap to maxPerRun
  churches = churches.slice(0, maxPerRun);

  // Build sets of already-contacted emails and church_ids with active sequences
  const churchEmails = churches.map((ch) => ch.email).filter(Boolean) as string[];
  const churchIds = churches.map((ch) => ch.id).filter(Boolean) as string[];

  const [{ data: sentHistory }, { data: activeSequences }] = await Promise.all([
    churchEmails.length
      ? supabase.from("outreach_history").select("email").eq("status", "sent").in("email", churchEmails)
      : Promise.resolve({ data: [] }),
    churchIds.length
      ? supabase.from("follow_up_sequences").select("church_id").eq("status", "active").in("church_id", churchIds)
      : Promise.resolve({ data: [] }),
  ]);

  const alreadyEmailedSet = new Set((sentHistory ?? []).map((r: { email: string }) => r.email?.toLowerCase()));
  const activeSequenceSet = new Set((activeSequences ?? []).map((r: { church_id: string }) => r.church_id));

  // Filter out duplicates before generation to avoid wasting Claude calls
  const skippedDuplicates: Array<{ name: string; email: string; reason: string }> = [];
  const churchesToProcess = churches.filter((ch) => {
    if (!ch.email) return true; // let send loop handle no-email skips
    if (alreadyEmailedSet.has(ch.email.toLowerCase())) {
      skippedDuplicates.push({ name: ch.name, email: ch.email, reason: "already emailed" });
      return false;
    }
    if (ch.id && activeSequenceSet.has(ch.id)) {
      skippedDuplicates.push({ name: ch.name, email: ch.email, reason: "active follow-up sequence exists" });
      return false;
    }
    return true;
  });

  let emails: Awaited<ReturnType<typeof generateOutreachEmails>> = [];
  let rateLimitMessage: string | undefined;

  try {
    emails = await generateOutreachEmails(churchesToProcess, senderName, senderOrganization);
  } catch (err) {
    if (err instanceof RateLimitError) {
      rateLimitMessage = err.message;
      // emails will be empty — partial results handled below
    } else {
      throw err;
    }
  }

  const sent: typeof emails = [];
  const skipped: typeof emails = [];
  const failed: Array<{ email: (typeof emails)[0]; error: string }> = [];

  for (const item of emails) {
    const toEmail = item.church.email;

      if (!toEmail) {
        skipped.push(item);
        continue; // no email address — don't log to outreach_history
      }

      try {
        const { id: resendId } = await sendEmail({ from: fromEmail, to: toEmail, subject: item.subject, text: item.body });

        console.log("[outreach/send] email sent via Resend, now logging to outreach_history for:", item.church.name);
        await insertOutreachRecord({
          church_name: item.church.name,
          email: toEmail,
          city: item.church.city,
          state: item.church.state,
          email_subject: item.subject,
          email_body: item.body,
          status: "sent",
          resend_id: resendId,
        });
        console.log("[outreach/send] outreach_history insert complete for:", item.church.name);

        // Resolve church_id for pipeline + follow-up sequence
        let resolvedChurchId: string | null = (item.church.id as string) ?? null;
        if (!resolvedChurchId) {
          const { data: found } = await supabase
            .from("churches")
            .select("id")
            .eq("name", item.church.name)
            .maybeSingle();
          resolvedChurchId = found?.id ?? null;
        }

        if (resolvedChurchId) {
          await addToPipeline(resolvedChurchId, "emailed").catch(() => {});
          await createFollowUpSequence(resolvedChurchId, toEmail).catch(() => {});
        }

        sent.push(item);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[outreach/send] failed for", item.church.name, "—", message);
        await insertOutreachRecord({
          church_name: item.church.name,
          email: toEmail,
          city: item.church.city,
          state: item.church.state,
          email_subject: item.subject,
          status: "failed",
        }).catch(() => {});
        failed.push({ email: item, error: message });
      }
  }

  return c.json({
    summary: {
      sent: sent.length,
      skipped: skipped.length,
      skipped_duplicates: skippedDuplicates.length,
      failed: failed.length,
      ...(rateLimitMessage ? { rate_limit_message: `${rateLimitMessage} — run again to continue` } : {}),
    },
    sent,
    skipped,
    skipped_duplicates: skippedDuplicates,
    failed,
  });
});

outreachRouter.get("/history", async (c) => {
  const history = await getOutreachHistory();
  return c.json({ history });
});

// Preview a personalized outreach email for a church — no send, no logging
outreachRouter.post("/preview", async (c) => {
  const body = await c.req.json<{
    church_id: string;
    senderName?: string;
    senderOrganization?: string;
  }>();

  if (!body.church_id) {
    return c.json({ error: "church_id is required" }, 400);
  }

  const { data: church, error } = await supabase
    .from("churches")
    .select("*")
    .eq("id", body.church_id)
    .single();

  if (error || !church) {
    return c.json({ error: "Church not found" }, 404);
  }

  const senderName = body.senderName ?? "Sister Clark";
  const senderOrganization = body.senderOrganization ?? "Sister Clark Ministry Tools";

  const [result] = await generateOutreachEmails([church as Church], senderName, senderOrganization);

  return c.json({ subject: result.subject, body: result.body });
});
