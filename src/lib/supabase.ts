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
  zip_code?: string;
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
  pastor?: string;
  email?: string;
  city?: string;
  state?: string;
  email_subject?: string;
  email_body?: string;
  status: "sent" | "failed" | "skipped";
  sent_at?: string;
  created_at?: string;
}

export async function insertOutreachRecord(
  record: Omit<OutreachRecord, "id" | "sent_at" | "created_at">
): Promise<void> {
  const { error } = await supabase.from("outreach_history").insert(record);
  if (error) throw error;
}

export async function getOutreachHistory(): Promise<OutreachRecord[]> {
  const { data, error } = await supabase
    .from("outreach_history")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export type PipelineStage =
  | "identified"
  | "emailed"
  | "opened"
  | "responded"
  | "demo_scheduled"
  | "demo_done"
  | "proposal_sent"
  | "won"
  | "lost";

export interface PipelineRecord {
  id?: string;
  church_id: string;
  stage: PipelineStage;
  tier_interest?: number;
  notes?: string;
  expected_close_date?: string;
  monthly_revenue?: number;
  lost_reason?: string;
  created_at?: string;
  updated_at?: string;
  // joined church fields
  church?: ChurchRecord;
}

export async function getPipeline(): Promise<Record<PipelineStage, PipelineRecord[]>> {
  const { data, error } = await supabase
    .from("pipeline")
    .select("*, church:churches(*)")
    .order("created_at", { ascending: false });

  if (error) throw error;

  const stages: PipelineStage[] = [
    "identified", "emailed", "opened", "responded",
    "demo_scheduled", "demo_done", "proposal_sent", "won", "lost",
  ];
  const grouped = Object.fromEntries(stages.map((s) => [s, []])) as unknown as Record<PipelineStage, PipelineRecord[]>;
  for (const row of data ?? []) {
    grouped[row.stage as PipelineStage]?.push(row);
  }
  return grouped;
}

export async function addToPipeline(
  church_id: string,
  stage: PipelineStage = "identified"
): Promise<PipelineRecord> {
  const { data, error } = await supabase
    .from("pipeline")
    .upsert({ church_id, stage }, { onConflict: "church_id" })
    .select("*, church:churches(*)")
    .single();
  if (error) throw error;
  return data;
}

export async function updatePipelineRecord(
  id: string,
  updates: Partial<Pick<PipelineRecord, "stage" | "notes" | "tier_interest" | "expected_close_date" | "monthly_revenue" | "lost_reason">>
): Promise<PipelineRecord> {
  const { data, error } = await supabase
    .from("pipeline")
    .update(updates)
    .eq("id", id)
    .select("*, church:churches(*)")
    .single();
  if (error) throw error;
  return data;
}

export async function deletePipelineRecord(id: string): Promise<void> {
  const { error } = await supabase.from("pipeline").delete().eq("id", id);
  if (error) throw error;
}

export async function getPipelineStats() {
  const { data, error } = await supabase
    .from("pipeline")
    .select("stage, monthly_revenue, tier_interest");
  if (error) throw error;

  const rows = data ?? [];
  const stageCounts: Record<string, number> = {};
  let totalMrr = 0;
  let totalPipelineValue = 0;

  for (const row of rows) {
    stageCounts[row.stage] = (stageCounts[row.stage] ?? 0) + 1;
    if (row.stage === "won" && row.monthly_revenue) {
      totalMrr += row.monthly_revenue;
    }
    if (row.stage !== "lost" && row.monthly_revenue) {
      totalPipelineValue += row.monthly_revenue;
    }
  }

  return {
    total: rows.length,
    by_stage: stageCounts,
    total_mrr: totalMrr,
    total_pipeline_value: totalPipelineValue,
  };
}
