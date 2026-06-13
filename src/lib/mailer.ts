import { Resend } from "resend";

export interface SendEmailOptions {
  from: string;
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}

export interface SendEmailResult {
  id: string;
}

export async function sendEmail(
  options: SendEmailOptions
): Promise<SendEmailResult> {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const replyTo = options.replyTo ?? process.env.REPLY_TO_EMAIL;

  const { data, error } = await resend.emails.send({
    from: options.from,
    to: options.to,
    subject: options.subject,
    text: options.text,
    ...(replyTo ? { reply_to: replyTo } : {}),
  });

  if (error || !data) {
    const detail = error
      ? `Resend error — name: ${error.name}, message: ${error.message}`
      : "Resend returned no data and no error";
    console.error("[mailer] sendEmail failed:", detail, "| to:", options.to, "| from:", options.from);
    throw new Error(detail);
  }

  return { id: data.id };
}
