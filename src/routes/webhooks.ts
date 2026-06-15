import { Hono } from "hono";
import { supabase } from "../lib/supabase.js";

export const webhooksRouter = new Hono();

interface ResendWebhookPayload {
  type: string;
  data: {
    email_id?: string;
    to?: string[];
    from?: string;
    subject?: string;
    created_at?: string;
  };
}

// POST /webhooks/resend — receives Resend email event webhooks
webhooksRouter.post("/resend", async (c) => {
  const payload = await c.req.json<ResendWebhookPayload>();

  console.log("[webhook/resend] received event:", payload.type, JSON.stringify(payload.data));

  // Only handle bounce events
  if (payload.type !== "email.bounced") {
    return c.json({ received: true, action: "ignored", type: payload.type });
  }

  const bouncedEmail = payload.data.to?.[0]?.toLowerCase();
  if (!bouncedEmail) {
    return c.json({ received: true, action: "ignored", reason: "no email address in payload" });
  }

  console.log("[webhook/resend] bounce detected for:", bouncedEmail);

  // 1. Find the church by email and clear the email field
  const { data: churches, error: findError } = await supabase
    .from("churches")
    .select("id, name, email")
    .ilike("email", bouncedEmail);

  if (findError) {
    console.error("[webhook/resend] error finding church:", findError.message);
    return c.json({ error: "DB lookup failed" }, 500);
  }

  const actions: string[] = [];

  if (churches && churches.length > 0) {
    const churchIds = churches.map((ch) => ch.id);

    // Clear email on matching churches
    const { error: clearError } = await supabase
      .from("churches")
      .update({ email: null, updated_at: new Date().toISOString() })
      .in("id", churchIds);

    if (clearError) {
      console.error("[webhook/resend] error clearing church email:", clearError.message);
    } else {
      actions.push(`cleared email on ${churches.length} church(es): ${churches.map((c) => c.name).join(", ")}`);
    }

    // 2. Mark follow-up sequences as unsubscribed so no more emails go to this address
    const { error: seqError } = await supabase
      .from("follow_up_sequences")
      .update({ status: "unsubscribed" })
      .in("church_id", churchIds)
      .eq("status", "active");

    if (seqError) {
      console.error("[webhook/resend] error updating follow-up sequences:", seqError.message);
    } else {
      actions.push("marked active follow-up sequences as unsubscribed");
    }
  } else {
    // No church matched — still try to stop follow-ups by email address directly
    const { error: seqError } = await supabase
      .from("follow_up_sequences")
      .update({ status: "unsubscribed" })
      .ilike("email", bouncedEmail)
      .eq("status", "active");

    if (!seqError) {
      actions.push("marked active follow-up sequences as unsubscribed (by email, no church match)");
    }

    actions.push("no matching church found for bounced email");
  }

  console.log("[webhook/resend] bounce handled:", actions.join("; "));
  return c.json({ received: true, action: "bounce_handled", email: bouncedEmail, actions });
});
