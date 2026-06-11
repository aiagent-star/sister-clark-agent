import { Resend } from "resend";

export interface SendEmailOptions {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface SendEmailResult {
  id: string;
}

export async function sendEmail(
  options: SendEmailOptions
): Promise<SendEmailResult> {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: options.from,
    to: options.to,
    subject: options.subject,
    text: options.text,
  });

  if (error || !data) {
    throw new Error(error?.message ?? "Failed to send email");
  }

  return { id: data.id };
}
