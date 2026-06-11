import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export interface ChurchRecord {
  id?: string;
  name: string;
  denomination?: string;
  address?: string;
  phone?: string;
  website?: string;
  email?: string;
  city?: string;
  state?: string;
  notes?: string;
  created_at?: string;
  updated_at?: string;
}

export async function saveChurches(
  churches: Omit<ChurchRecord, "id" | "created_at" | "updated_at">[]
): Promise<ChurchRecord[]> {
  const { data, error } = await supabase
    .from("churches")
    .insert(churches)
    .select();
  if (error) throw error;
  return data ?? [];
}

export async function getChurches(city?: string, state?: string): Promise<ChurchRecord[]> {
  let query = supabase.from("churches").select("*").order("name");
  if (city) query = query.ilike("city", city);
  if (state) query = query.ilike("state", state);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function updateChurchEmail(
  id: string,
  email: string
): Promise<ChurchRecord> {
  const { data, error } = await supabase
    .from("churches")
    .update({ email, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteChurch(id: string): Promise<void> {
  const { error } = await supabase.from("churches").delete().eq("id", id);
  if (error) throw error;
}

export interface OutreachRecord {
  id?: string;
  church_name: string;
  email_address: string;
  subject: string;
  date_sent?: string;
  status: "sent" | "failed" | "skipped";
  resend_id?: string;
}

export async function insertOutreachRecord(
  record: Omit<OutreachRecord, "id" | "date_sent">
): Promise<void> {
  const { error } = await supabase.from("outreach_history").insert(record);
  if (error) throw error;
}

export async function getOutreachHistory(): Promise<OutreachRecord[]> {
  const { data, error } = await supabase
    .from("outreach_history")
    .select("*")
    .order("date_sent", { ascending: false });

  if (error) throw error;
  return data ?? [];
}
