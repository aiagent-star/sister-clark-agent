import { Hono } from "hono";
import { findChurches } from "../agents/churchFinder.js";
import { generateOutreachEmails } from "../agents/emailGenerator.js";
import type { Church } from "../agents/churchFinder.js";
import { sendEmail } from "../lib/mailer.js";
import {
  insertOutreachRecord,
  getOutreachHistory,
  getChurches,
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

  const emails = await generateOutreachEmails(
    churches,
    senderName,
    senderOrganization
  );

  const sent: typeof emails = [];
  const skipped: typeof emails = [];
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
      failed: failed.length,
    },
    sent,
    skipped,
    failed,
  });
});

outreachRouter.get("/history", async (c) => {
  const history = await getOutreachHistory();
  return c.json({ history });
});
