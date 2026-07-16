import type { SupabaseClient } from "@supabase/supabase-js";

export interface SessionTimeMetrics {
  totalSeconds: number;
  focusSeconds: number;
}

/**
 * Read the database's authoritative per-user session totals. The migration's
 * RPC includes the currently-open attendance/work segments and clamps active
 * time to total time. Null keeps deployments backward-compatible until the
 * migration has been applied.
 */
export async function getSessionTimeMetrics(
  supabase: SupabaseClient,
  sessionId: string,
  userId: string,
  at: Date = new Date(),
): Promise<SessionTimeMetrics | null> {
  const { data, error } = await supabase.rpc("get_session_time_metrics", {
    p_session_id: sessionId,
    p_user_id: userId,
    p_at: at.toISOString(),
  });

  if (error) {
    // 42883: RPC not deployed; 42703: new columns not deployed. Let the route
    // use its legacy wall-clock/client fallback during a rolling deployment.
    if (error.code === "42883" || error.code === "42703" || error.code === "PGRST202") return null;
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  const totalSeconds = Math.max(0, Math.floor(Number(row.total_seconds) || 0));
  const focusSeconds = Math.min(
    totalSeconds,
    Math.max(0, Math.floor(Number(row.focus_seconds) || 0)),
  );
  return { totalSeconds, focusSeconds };
}
