import { Hono } from "hono";
import { findChurches } from "../agents/churchFinder.js";
import { generateOutreachEmails } from "../agents/emailGenerator.js";
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
    senderName: string;
    senderOrganization: string;
    fromEmail?: string;
  }>();

  const { senderName, senderOrganization } = body;
  const fromEmail = body.fromEmail ?? process.env.FROM_EMAIL;

  if (!senderName || !senderOrganization) {
    return c.json({ error: "senderName and senderOrganization are required" }, 400);
  }

  let churches: Church[];

  if (body.city && body.state) {
    // Pull saved churches from Supabase so email addresses are included
    const saved = await getChurches(body.city.trim(), body.state.trim());
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
    return c.json({ error: "Provide either city+state or a churches array" }, 400);
  }

  if (!fromEmail) {
    return c.json(
      { error: "fromEmail is required (or set FROM_EMAIL env var)" },
      400
    );
  }

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

  const emails = await generateOutreachEmails(
    churches,
    senderName,
    senderOrganization
  );

  const sent: typeof emails = [];
  const skipped: typeof emails = [];
  const skippedDuplicates: Array<{ name: string; email: string; reason: string }> = [];
  const failed: Array<{ email: (typeof emails)[0]; error: string }> = [];

  await Promise.all(
    emails.map(async (item) => {
      const toEmail = item.church.email;

      if (!toEmail) {
        skipped.push(item);
        await insertOutreachRecord({
          church_name: item.church.name,
          email_subject: item.subject,
          status: "skipped",
        }).catch(() => {});
        return;
      }

      // Duplicate / active-sequence check
      const churchId = item.church.id as string | undefined;
      if (alreadyEmailedSet.has(toEmail.toLowerCase())) {
        skippedDuplicates.push({ name: item.church.name, email: toEmail, reason: "already emailed" });
        return;
      }
      if (churchId && activeSequenceSet.has(churchId)) {
        skippedDuplicates.push({ name: item.church.name, email: toEmail, reason: "active follow-up sequence exists" });
        return;
      }

      try {
        const result = await sendEmail({
          from: fromEmail,
          to: toEmail,
          subject: item.subject,
          text: item.body,
        });

        await insertOutreachRecord({
          church_name: item.church.name,
          email: toEmail,
          email_subject: item.subject,
          email_body: item.body,
          status: "sent",
        });

        // Resolve church_id (may already be on the object or needs a lookup)
        let churchId: string | null = (item.church.id as string) ?? null;
        if (!churchId) {
          const { data: found } = await supabase
            .from("churches")
            .select("id")
            .eq("name", item.church.name)
            .maybeSingle();
          churchId = found?.id ?? null;
        }

        if (churchId) {
          await addToPipeline(churchId, "emailed").catch(() => {});
          await createFollowUpSequence(churchId, toEmail).catch(() => {});
        }

        sent.push(item);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        await insertOutreachRecord({
          church_name: item.church.name,
          email: toEmail,
          email_subject: item.subject,
          status: "failed",
        }).catch(() => {});

        failed.push({ email: item, error: message });
      }
    })
  );

  return c.json({
    summary: {
      sent: sent.length,
      skipped: skipped.length,
      skipped_duplicates: skippedDuplicates.length,
      failed: failed.length,
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
