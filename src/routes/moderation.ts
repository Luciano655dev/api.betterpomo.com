import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getMutuallyBlockedUserIds } from "../lib/blocks";
import { cache } from "../lib/cache";
import { renderBrandedEmail, sendEmailDetailed } from "../lib/email";
import { serverError } from "../lib/http";
import { authenticate } from "../middleware/auth";
import { perUserLimiter } from "../middleware/rateLimit";

const router = Router();
router.use(authenticate);

export const MODERATION_RESPONSE_HOURS = 24;

const REPORT_REASONS = [
  "harassment",
  "hate_or_abuse",
  "sexual_content",
  "violence_or_threats",
  "spam_or_scam",
  "impersonation",
  "other",
] as const;
type ReportReason = typeof REPORT_REASONS[number];
type SubjectType = "user" | "dm_message" | "session_message";

const reportLimiter = perUserLimiter({
  windowMs: 60 * 60_000,
  limit: 30,
  message: "Too many reports were submitted. Please try again later.",
  name: "moderation-report",
});

function resolveUserId(supabase: SupabaseClient, username: string) {
  return supabase
    .from("profiles")
    .select("id, username, display_name, emoji, bio")
    .eq("username", username)
    .is("deleted_at", null)
    .maybeSingle();
}

function moderationSchemaUnavailable(error: { code?: string } | null | undefined): boolean {
  return ["42P01", "42883", "PGRST202", "PGRST205"].includes(error?.code ?? "");
}

function handleModerationError(res: Parameters<typeof serverError>[0], error: { code?: string; message?: string }) {
  if (moderationSchemaUnavailable(error)) {
    res.status(503).json({ error: "Safety services are being updated. Please try again shortly." });
    return;
  }
  serverError(res, error);
}

function invalidateSocialState(firstUserId: string, secondUserId?: string) {
  const ids = [firstUserId, secondUserId].filter(Boolean) as string[];
  for (const id of ids) {
    cache.delByPrefix(`friends:${id}:`);
    cache.del(`friend-count:${id}`);
    cache.del(`friend-reqs:${id}`);
    cache.del(`conversations:${id}`);
    cache.del(`notif:${id}`);
  }
  cache.delByPrefix("search:");
  cache.delByPrefix("user:");
  cache.delByPrefix("user-hist:");
  cache.delByPrefix("user-friends:");
}

function isAdmin(email: string | undefined): boolean {
  if (!email) return false;
  const admins = (process.env.ADMIN_EMAILS ?? "lucianomenezes655@gmail.com")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.toLowerCase());
}

async function notifyModerators(report: {
  id: string;
  subject_type: SubjectType;
  reason: ReportReason;
  reporter_id: string;
  reported_user_id: string;
  details: string | null;
  reporter: { username: string; display_name: string; email?: string };
  reported: { username: string; display_name: string };
}) {
  const recipient = process.env.SAFETY_NOTIFY_EMAIL?.trim() || "lucianomenezes655@gmail.com";
  const reporterLabel = `${report.reporter.display_name} (@${report.reporter.username})`;
  const reportedLabel = `${report.reported.display_name} (@${report.reported.username})`;
  return sendEmailDetailed({
    to: recipient,
    subject: `[BetterPomo safety] Report about @${report.reported.username}`,
    idempotencyKey: `safety-report-${report.id}`,
    tags: [
      { name: "category", value: "safety-report" },
      { name: "subject", value: report.subject_type },
    ],
    text: [
      `Report: ${report.id}`,
      `Type: ${report.subject_type.replace("_", " ")}`,
      `Reason: ${report.reason}`,
      `Reporter: ${reporterLabel} (${report.reporter_id})`,
      report.reporter.email ? `Reporter email: ${report.reporter.email}` : null,
      `Reported user: ${reportedLabel} (${report.reported_user_id})`,
      report.details ? `Details: ${report.details}` : "Details: none provided",
      `Response target: within ${MODERATION_RESPONSE_HOURS} hours`,
      "",
      "Review the content_reports table or the authenticated moderation API.",
    ].filter(Boolean).join("\n"),
    html: renderBrandedEmail({
      preview: `A new BetterPomo safety report about @${report.reported.username} needs review.`,
      eyebrow: "Trust & Safety",
      heading: `New report about @${report.reported.username}`,
      paragraphs: [`Please review this report within ${MODERATION_RESPONSE_HOURS} hours.`],
      details: [
        { label: "Report ID", value: report.id },
        { label: "Type", value: report.subject_type.replace("_", " ") },
        { label: "Reason", value: report.reason.replaceAll("_", " ") },
        { label: "Reporter", value: `${reporterLabel}\n${report.reporter.email ?? "No email available"}\n${report.reporter_id}` },
        { label: "Reported user", value: `${reportedLabel}\n${report.reported_user_id}` },
        { label: "Details", value: report.details || "None provided" },
      ],
    }),
  });
}

router.get("/policy", (_req, res) => {
  res.json({
    data: {
      response_hours: MODERATION_RESPONSE_HOURS,
      support_email: "lucianomenezes655@gmail.com",
    },
  });
});

/** GET /api/moderation/blocks — accounts blocked by the current user. */
router.get("/blocks", async (req, res) => {
  const { user, supabase } = req;
  const { data: rows, error } = await supabase
    .from("user_blocks")
    .select("blocked_id, created_at")
    .eq("blocker_id", user.id)
    .order("created_at", { ascending: false });
  if (error) { handleModerationError(res, error); return; }

  const ids = (rows ?? []).map((row) => row.blocked_id);
  const { data: profiles, error: profilesError } = ids.length
    ? await supabase.from("profiles").select("id, username, display_name, emoji").in("id", ids)
    : { data: [], error: null };
  if (profilesError) { serverError(res, profilesError); return; }
  const byId = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
  res.json({
    data: (rows ?? []).flatMap((row) => {
      const profile = byId.get(row.blocked_id);
      return profile ? [{ ...profile, blocked_at: row.created_at }] : [];
    }),
  });
});

/** GET /api/moderation/hidden-user-ids — both sides of every block relation.
 * IDs only: revealing profiles of people who blocked the caller would defeat
 * the privacy expectation of blocking. Clients use this to suppress realtime
 * session broadcasts in both directions. */
router.get("/hidden-user-ids", async (req, res) => {
  const { user, supabase } = req;
  try {
    const ids = await getMutuallyBlockedUserIds(supabase, user.id);
    res.json({ data: [...ids] });
  } catch (error) {
    const dbError = error as { code?: string; message?: string };
    handleModerationError(res, dbError);
  }
});

/** GET /api/moderation/users/:username/status */
router.get("/users/:username/status", async (req, res) => {
  const { user, supabase } = req;
  const { data: target, error: targetError } = await resolveUserId(supabase, String(req.params.username));
  if (targetError) { serverError(res, targetError); return; }
  if (!target) { res.status(404).json({ error: "User not found" }); return; }
  if (target.id === user.id) {
    res.json({ data: { target_id: target.id, blocked_by_me: false, interactions_blocked: false } });
    return;
  }
  const { data, error } = await supabase
    .from("user_blocks")
    .select("blocker_id, blocked_id")
    .in("blocker_id", [user.id, target.id])
    .in("blocked_id", [user.id, target.id]);
  if (error) { handleModerationError(res, error); return; }
  res.json({
    data: {
      target_id: target.id,
      blocked_by_me: (data ?? []).some((row) => row.blocker_id === user.id),
      interactions_blocked: (data?.length ?? 0) > 0,
    },
  });
});

/** POST /api/moderation/blocks — block by username and sever direct social ties. */
router.post("/blocks", async (req, res) => {
  const { user, supabase } = req;
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  if (!username) { res.status(400).json({ error: "username is required" }); return; }
  const { data: target, error: targetError } = await resolveUserId(supabase, username);
  if (targetError) { serverError(res, targetError); return; }
  if (!target) { res.status(404).json({ error: "User not found" }); return; }
  if (target.id === user.id) { res.status(400).json({ error: "You cannot block yourself" }); return; }

  const { error } = await supabase.rpc("block_user_and_cleanup", {
    p_actor: user.id,
    p_target: target.id,
  });
  if (error) { handleModerationError(res, error); return; }
  invalidateSocialState(user.id, target.id);
  res.status(201).json({ data: { target_id: target.id, username: target.username, blocked: true } });
});

/** DELETE /api/moderation/blocks/:username */
router.delete("/blocks/:username", async (req, res) => {
  const { user, supabase } = req;
  const { data: target, error: targetError } = await resolveUserId(supabase, String(req.params.username));
  if (targetError) { serverError(res, targetError); return; }
  if (!target) { res.status(404).json({ error: "User not found" }); return; }
  const { error } = await supabase
    .from("user_blocks")
    .delete()
    .eq("blocker_id", user.id)
    .eq("blocked_id", target.id);
  if (error) { handleModerationError(res, error); return; }
  invalidateSocialState(user.id, target.id);
  res.json({ data: { target_id: target.id, username: target.username, blocked: false } });
});

/** POST /api/moderation/reports — server resolves and snapshots the subject. */
router.post("/reports", reportLimiter, async (req, res) => {
  const { user, supabase } = req;
  const subjectType = req.body?.subject_type as SubjectType | undefined;
  const subjectId = typeof req.body?.subject_id === "string" ? req.body.subject_id : "";
  const reason = req.body?.reason as ReportReason | undefined;
  const details = typeof req.body?.details === "string" ? req.body.details.trim().slice(0, 1000) : null;
  if (!subjectType || !["user", "dm_message", "session_message"].includes(subjectType)) {
    res.status(400).json({ error: "A valid subject_type is required" }); return;
  }
  if (!subjectId) { res.status(400).json({ error: "subject_id is required" }); return; }
  if (!reason || !REPORT_REASONS.includes(reason)) {
    res.status(400).json({ error: "A valid reason is required" }); return;
  }

  let reportedUserId = "";
  let canonicalSubjectId = subjectId;
  let conversationId: string | null = null;
  let sessionId: string | null = null;
  let snapshot: Record<string, unknown> = {};

  if (subjectType === "user") {
    const { data: target, error } = await resolveUserId(supabase, subjectId);
    if (error) { serverError(res, error); return; }
    if (!target) { res.status(404).json({ error: "User not found" }); return; }
    reportedUserId = target.id;
    canonicalSubjectId = target.id;
    snapshot = target;
  } else if (subjectType === "dm_message") {
    const { data: message, error } = await supabase
      .from("dm_messages")
      .select("id, conversation_id, sender_id, kind, content, metadata, created_at, expires_at")
      .eq("id", subjectId)
      .maybeSingle();
    if (error) { serverError(res, error); return; }
    if (!message) { res.status(404).json({ error: "Message not found" }); return; }
    const { data: membership, error: membershipError } = await supabase
      .from("conversation_members")
      .select("user_id")
      .eq("conversation_id", message.conversation_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (membershipError) { serverError(res, membershipError); return; }
    if (!membership) { res.status(404).json({ error: "Message not found" }); return; }
    reportedUserId = message.sender_id;
    conversationId = message.conversation_id;
    snapshot = message;
  } else {
    const { data: message, error } = await supabase
      .from("chat_messages")
      .select("id, session_id, user_id, content, kind, metadata, created_at")
      .eq("id", subjectId)
      .maybeSingle();
    if (error) { serverError(res, error); return; }
    if (!message) { res.status(404).json({ error: "Message not found" }); return; }
    const { data: membership, error: membershipError } = await supabase
      .from("session_participants")
      .select("id")
      .eq("session_id", message.session_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (membershipError) { serverError(res, membershipError); return; }
    if (!membership) { res.status(404).json({ error: "Message not found" }); return; }
    reportedUserId = message.user_id;
    sessionId = message.session_id;
    snapshot = message;
  }

  if (reportedUserId === user.id) {
    res.status(400).json({ error: "You cannot report your own content" }); return;
  }
  const { data: report, error } = await supabase
    .from("content_reports")
    .insert({
      reporter_id: user.id,
      reported_user_id: reportedUserId,
      subject_type: subjectType,
      subject_id: canonicalSubjectId,
      conversation_id: conversationId,
      session_id: sessionId,
      reason,
      details,
      content_snapshot: snapshot,
    })
    .select("id, subject_type, reason, status, created_at")
    .single();
  if (error) { handleModerationError(res, error); return; }

  const { data: identities, error: identitiesError } = await supabase
    .from("profiles")
    .select("id, username, display_name")
    .in("id", [user.id, reportedUserId]);
  if (identitiesError) console.error("moderation identity snapshot failed", identitiesError);
  const reporterProfile = identities?.find((profile) => profile.id === user.id);
  const reportedProfile = identities?.find((profile) => profile.id === reportedUserId);
  const delivery = await notifyModerators({
    id: report.id,
    subject_type: subjectType,
    reason,
    reporter_id: user.id,
    reported_user_id: reportedUserId,
    details,
    reporter: {
      username: reporterProfile?.username ?? "unknown",
      display_name: reporterProfile?.display_name ?? reporterProfile?.username ?? "Unknown user",
      email: user.email,
    },
    reported: {
      username: reportedProfile?.username ?? "unknown",
      display_name: reportedProfile?.display_name ?? reportedProfile?.username ?? "Unknown user",
    },
  });
  const deliveryPatch = delivery.ok
    ? { notification_sent_at: new Date().toISOString(), notification_error: null }
    : { notification_sent_at: null, notification_error: delivery.error.slice(0, 1000) };
  const { error: deliveryAuditError } = await supabase
    .from("content_reports")
    .update(deliveryPatch)
    .eq("id", report.id);
  if (deliveryAuditError) console.error("moderation email audit failed", deliveryAuditError);
  if (!delivery.ok) console.error("moderation email failed", delivery.error);
  res.status(201).json({
    data: {
      ...report,
      response_hours: MODERATION_RESPONSE_HOURS,
      notification_sent: delivery.ok,
    },
  });
});

/** Admin review queue. Admins are configured through ADMIN_EMAILS. */
router.get("/reports", async (req, res) => {
  if (!isAdmin(req.user.email)) { res.status(403).json({ error: "Admin access required" }); return; }
  const status = typeof req.query.status === "string" ? req.query.status : "open";
  const { data, error } = await req.supabase
    .from("content_reports")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) { handleModerationError(res, error); return; }
  res.json({ data: data ?? [] });
});

router.patch("/reports/:id", async (req, res) => {
  if (!isAdmin(req.user.email)) { res.status(403).json({ error: "Admin access required" }); return; }
  const status = req.body?.status;
  if (!status || !["open", "reviewing", "resolved", "dismissed"].includes(status)) {
    res.status(400).json({ error: "A valid status is required" }); return;
  }
  const notes = typeof req.body?.moderation_notes === "string"
    ? req.body.moderation_notes.trim().slice(0, 4000)
    : null;
  const { data, error } = await req.supabase
    .from("content_reports")
    .update({
      status,
      moderation_notes: notes,
      reviewed_by: req.user.id,
      reviewed_at: status === "open" ? null : new Date().toISOString(),
      resolved_at: ["resolved", "dismissed"].includes(status) ? new Date().toISOString() : null,
    })
    .eq("id", req.params.id)
    .select("*")
    .single();
  if (error) { handleModerationError(res, error); return; }
  res.json({ data });
});

export default router;
