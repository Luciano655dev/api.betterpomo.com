import type { SupabaseClient } from "@supabase/supabase-js";

export async function usersHaveBlockedEachOther(
  supabase: SupabaseClient,
  firstUserId: string,
  secondUserId: string,
): Promise<boolean> {
  if (!firstUserId || !secondUserId || firstUserId === secondUserId) return false;
  const { data, error } = await supabase
    .from("user_blocks")
    .select("blocker_id")
    .in("blocker_id", [firstUserId, secondUserId])
    .in("blocked_id", [firstUserId, secondUserId])
    .limit(1);
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** Every account whose content/interactions this viewer should not receive. */
export async function getMutuallyBlockedUserIds(
  supabase: SupabaseClient,
  userId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("user_blocks")
    .select("blocker_id, blocked_id")
    .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`);
  if (error) throw error;
  const ids = new Set<string>();
  for (const row of data ?? []) {
    if (row.blocker_id !== userId) ids.add(String(row.blocker_id));
    if (row.blocked_id !== userId) ids.add(String(row.blocked_id));
  }
  return ids;
}
