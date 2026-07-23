import { adminDb } from "./supabase";

export type PushCategory = "timers" | "friends" | "sessions" | "messages" | "account";

export interface PushPayload {
  title: string;
  body: string;
  data: Record<string, unknown>;
  collapseId?: string;
}

interface DeliveryJob {
  id: string;
  push_device_id: string;
  attempts: number;
  payload: PushPayload;
  expo_ticket_id: string | null;
  push_devices: { expo_push_token: string; disabled_at: string | null };
}

interface ExpoPushResult {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const MAX_ATTEMPTS = 5;
let sending = false;
let checkingReceipts = false;

export function isExpoPushToken(token: unknown): token is string {
  return typeof token === "string" && /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(token);
}

async function expoRequest<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  const parsed = raw ? JSON.parse(raw) as { data?: T; errors?: { message?: string }[] } : {};
  if (!response.ok || parsed.errors?.length) {
    throw new Error(parsed.errors?.[0]?.message ?? `Expo push request failed (${response.status})`);
  }
  if (parsed.data === undefined) throw new Error("Expo push response did not include data");
  return parsed.data;
}

/** Persist one delivery job per active installation. Missing preferences mean enabled. */
export async function queuePush(
  recipientId: string,
  category: PushCategory,
  eventKey: string,
  payload: PushPayload,
): Promise<void> {
  const [{ data: preferences, error: prefError }, { data: devices, error: deviceError }] = await Promise.all([
    adminDb.from("notification_preferences").select(category).eq("user_id", recipientId).maybeSingle(),
    adminDb.from("push_devices").select("id").eq("user_id", recipientId).is("disabled_at", null),
  ]);
  if (prefError) throw prefError;
  if (deviceError) throw deviceError;
  if (preferences && (preferences as Record<PushCategory, boolean>)[category] === false) return;
  if (!devices?.length) return;

  const { error } = await adminDb.from("push_delivery_jobs").upsert(
    devices.map((device) => ({
      user_id: recipientId,
      push_device_id: device.id,
      event_key: eventKey,
      payload,
    })),
    { onConflict: "push_device_id,event_key", ignoreDuplicates: true },
  );
  if (error) throw error;
}

/**
 * Queue a push that can absorb later events for the same recipient/context.
 * The database function serializes concurrent writers, delays delivery until
 * the burst goes quiet, and still releases a summary after the maximum delay.
 */
export async function queueCoalescedPush(
  recipientId: string,
  category: PushCategory,
  eventKey: string,
  coalesceKey: string,
  payload: PushPayload,
  aggregateTitle: string,
  options: { delaySeconds?: number; maxDelaySeconds?: number } = {},
): Promise<void> {
  const [{ data: preferences, error: prefError }, { data: devices, error: deviceError }] = await Promise.all([
    adminDb.from("notification_preferences").select(category).eq("user_id", recipientId).maybeSingle(),
    adminDb.from("push_devices").select("id").eq("user_id", recipientId).is("disabled_at", null),
  ]);
  if (prefError) throw prefError;
  if (deviceError) throw deviceError;
  if (preferences && (preferences as Record<PushCategory, boolean>)[category] === false) return;
  if (!devices?.length) return;

  const delaySeconds = options.delaySeconds ?? 20;
  const maxDelaySeconds = options.maxDelaySeconds ?? 90;
  await Promise.all(devices.map(async (device) => {
    const { error } = await adminDb.rpc("queue_coalesced_push_delivery_job", {
      p_user_id: recipientId,
      p_push_device_id: device.id,
      p_event_key: eventKey,
      p_coalesce_key: coalesceKey,
      p_payload: payload,
      p_aggregate_title: aggregateTitle,
      p_delay_seconds: delaySeconds,
      p_max_delay_seconds: maxDelaySeconds,
    });
    if (error) throw error;
  }));
}

/** Remove an alert that is no longer useful because the user read its context. */
export async function cancelCoalescedPush(recipientId: string, coalesceKey: string): Promise<void> {
  const { error } = await adminDb
    .from("push_delivery_jobs")
    .delete()
    .eq("user_id", recipientId)
    .eq("coalesce_key", coalesceKey)
    .eq("status", "queued");
  if (error) throw error;
}

async function disableDevice(deviceId: string, reason: string): Promise<void> {
  await adminDb
    .from("push_devices")
    .update({ disabled_at: new Date().toISOString() })
    .eq("id", deviceId);
  console.warn(`Disabled push device ${deviceId}: ${reason}`);
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(15 * 60, 5 * 2 ** Math.max(0, attempts - 1));
}

async function retryOrFail(job: DeliveryJob, message: string): Promise<void> {
  if (job.attempts >= MAX_ATTEMPTS) {
    await adminDb.from("push_delivery_jobs").update({
      status: "failed",
      last_error: message,
      updated_at: new Date().toISOString(),
    }).eq("id", job.id);
    return;
  }
  const availableAt = new Date(Date.now() + retryDelaySeconds(job.attempts) * 1000).toISOString();
  await adminDb.from("push_delivery_jobs").update({
    status: "queued",
    available_at: availableAt,
    last_error: message,
    updated_at: new Date().toISOString(),
  }).eq("id", job.id);
}

function errorCode(result: { details?: { error?: string } }): string | undefined {
  return result.details?.error;
}

async function sendQueued(): Promise<void> {
  if (sending) return;
  sending = true;
  try {
    const { data, error } = await adminDb.rpc("claim_push_delivery_jobs", { p_limit: 100 });
    if (error) {
      console.error("Push job claim failed:", error.message);
      return;
    }
    const claimed = (data ?? []) as Omit<DeliveryJob, "push_devices">[];
    if (!claimed.length) return;

    const deviceIds = [...new Set(claimed.map((job) => job.push_device_id))];
    const { data: devices, error: devicesError } = await adminDb
      .from("push_devices")
      .select("id, expo_push_token, disabled_at")
      .in("id", deviceIds);
    if (devicesError) throw devicesError;
    const byId = new Map((devices ?? []).map((device) => [device.id, device]));

    const jobs: DeliveryJob[] = [];
    for (const job of claimed) {
      const device = byId.get(job.push_device_id);
      if (!device || device.disabled_at || !isExpoPushToken(device.expo_push_token)) {
        await adminDb.from("push_delivery_jobs").update({
          status: "failed",
          last_error: "Push device is disabled or has an invalid Expo token",
          updated_at: new Date().toISOString(),
        }).eq("id", job.id);
        continue;
      }
      jobs.push({ ...job, push_devices: device });
    }

    const messages = jobs.map((job) => ({
      to: job.push_devices.expo_push_token,
      title: job.payload.title,
      body: job.payload.body,
      data: job.payload.data,
      sound: "default",
      priority: "high",
      ...(job.payload.collapseId ? { collapseId: job.payload.collapseId } : {}),
    }));
    if (messages.length) {
      try {
        const tickets = await expoRequest<ExpoPushResult[]>(EXPO_PUSH_URL, messages);
        for (let i = 0; i < jobs.length; i += 1) {
          const ticket = tickets[i];
          const job = jobs[i];
          if (!ticket) {
            await retryOrFail(job, "Expo push response omitted a ticket");
          } else if (ticket.status === "ok" && ticket.id) {
            await adminDb.from("push_delivery_jobs").update({
              status: "receipt_pending",
              expo_ticket_id: ticket.id,
              receipt_due_at: new Date(Date.now() + 15 * 60_000).toISOString(),
              last_error: null,
              updated_at: new Date().toISOString(),
            }).eq("id", job.id);
          } else if (errorCode(ticket) === "DeviceNotRegistered") {
            await disableDevice(job.push_device_id, ticket.message ?? "DeviceNotRegistered");
            await adminDb.from("push_delivery_jobs").update({
              status: "failed", last_error: ticket.message ?? "DeviceNotRegistered", updated_at: new Date().toISOString(),
            }).eq("id", job.id);
          } else {
            await retryOrFail(job, ticket.message ?? "Expo rejected the push notification");
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Expo push request failed";
        await Promise.all(jobs.map((job) => retryOrFail(job, message)));
      }
    }
  } catch (err) {
    console.error("Push worker failed:", err);
  } finally {
    sending = false;
  }
}

async function checkReceipts(): Promise<void> {
  if (checkingReceipts) return;
  checkingReceipts = true;
  try {
    const { data, error } = await adminDb
      .from("push_delivery_jobs")
      .select("id, push_device_id, attempts, payload, expo_ticket_id")
      .eq("status", "receipt_pending")
      .lte("receipt_due_at", new Date().toISOString())
      .limit(100);
    if (error) throw error;
    const jobs = (data ?? []) as Omit<DeliveryJob, "push_devices">[];
    const ids = jobs.map((job) => job.expo_ticket_id).filter((id): id is string => Boolean(id));
    if (!ids.length) return;

    const receipts = await expoRequest<Record<string, ExpoPushResult>>(EXPO_RECEIPTS_URL, { ids });
    for (const job of jobs) {
      if (!job.expo_ticket_id) continue;
      const receipt = receipts[job.expo_ticket_id];
      if (!receipt) continue;
      if (receipt.status === "ok") {
        await adminDb.from("push_delivery_jobs").update({
          status: "delivered", updated_at: new Date().toISOString(),
        }).eq("id", job.id);
      } else {
        if (errorCode(receipt) === "DeviceNotRegistered") {
          await disableDevice(job.push_device_id, receipt.message ?? "DeviceNotRegistered");
        }
        await adminDb.from("push_delivery_jobs").update({
          status: "failed", last_error: receipt.message ?? "Expo could not deliver the notification", updated_at: new Date().toISOString(),
        }).eq("id", job.id);
      }
    }
  } catch (err) {
    console.error("Push receipt check failed:", err);
  } finally {
    checkingReceipts = false;
  }
}

export function startPushWorker(): void {
  setTimeout(() => { void sendQueued(); }, 2_000).unref();
  setInterval(() => { void sendQueued(); }, 5_000).unref();
  setInterval(() => { void checkReceipts(); }, 60_000).unref();
  setInterval(() => { void adminDb.rpc("cleanup_push_delivery_jobs"); }, 6 * 60 * 60_000).unref();
}
