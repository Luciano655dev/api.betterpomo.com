import { Router } from "express";
import { cache, TTL } from "../lib/cache";
import { adminDb } from "../lib/supabase";

type HealthState = "operational" | "degraded" | "outage";

interface ServiceHealth {
  name: string;
  description: string;
  status: HealthState;
  responseTimeMs: number | null;
}

interface MetricPoint {
  date: string;
  accountsCreated: number;
  sessionsCreated: number;
  activeSessionsPeak: number;
}

interface PublicMetrics {
  accountsTotal: number;
  sessionsTotal: number;
  sessionsActive: number;
  peopleActive: number;
  accountsLast7Days: number;
  sessionsLast7Days: number;
  series: MetricPoint[];
}

interface StatusPayload {
  status: HealthState;
  checkedAt: string;
  services: ServiceHealth[];
  metrics: PublicMetrics | null;
}

const router = Router();
const CACHE_KEY = "public-status:v1";
const WEBAPP_URL = process.env.STATUS_WEBAPP_URL
  ?? process.env.WEBAPP_URL
  ?? "https://app.betterpomo.com";
const WEBSITE_URL = process.env.STATUS_WEBSITE_URL ?? "https://betterpomo.com";

function asNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeMetrics(value: unknown): PublicMetrics | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const rawSeries = Array.isArray(raw.series) ? raw.series : [];

  return {
    accountsTotal: asNumber(raw.accountsTotal),
    sessionsTotal: asNumber(raw.sessionsTotal),
    sessionsActive: asNumber(raw.sessionsActive),
    peopleActive: asNumber(raw.peopleActive),
    accountsLast7Days: asNumber(raw.accountsLast7Days),
    sessionsLast7Days: asNumber(raw.sessionsLast7Days),
    series: rawSeries.map((point) => {
      const row = point && typeof point === "object"
        ? point as Record<string, unknown>
        : {};
      return {
        date: typeof row.date === "string" ? row.date : "",
        accountsCreated: asNumber(row.accountsCreated),
        sessionsCreated: asNumber(row.sessionsCreated),
        activeSessionsPeak: asNumber(row.activeSessionsPeak),
      };
    }).filter((point) => point.date),
  };
}

async function probeWebsite(
  name: string,
  description: string,
  url: string,
): Promise<ServiceHealth> {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(4_000),
      headers: { "User-Agent": "BetterPomo-Status/1.0" },
    });
    await response.body?.cancel();
    const responseTimeMs = Math.round(performance.now() - startedAt);
    return {
      name,
      description,
      status: response.status < 400
        ? "operational"
        : response.status < 500 ? "degraded" : "outage",
      responseTimeMs,
    };
  } catch {
    return {
      name,
      description,
      status: "outage",
      responseTimeMs: Math.round(performance.now() - startedAt),
    };
  }
}

async function readMetrics(): Promise<{
  result: { data: unknown; error: unknown };
  responseTimeMs: number;
}> {
  const startedAt = performance.now();
  try {
    const result = await adminDb
      .rpc("get_public_status_metrics", { p_days: 30 })
      .abortSignal(AbortSignal.timeout(4_000));
    return {
      result,
      responseTimeMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      result: { data: null, error },
      responseTimeMs: Math.round(performance.now() - startedAt),
    };
  }
}

/** Public, aggregate-only status used by betterpomo.com/status. */
router.get("/", async (_req, res) => {
  const cached = cache.get<StatusPayload>(CACHE_KEY);
  if (cached) {
    res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
    res.json({ data: cached });
    return;
  }

  const startedAt = performance.now();
  const [metricsProbe, webapp, website] = await Promise.all([
    readMetrics(),
    probeWebsite("Web app", "The BetterPomo focus app", WEBAPP_URL),
    probeWebsite("Website", "The BetterPomo public website", WEBSITE_URL),
  ]);

  const metricsResult = metricsProbe.result;
  const databaseTimeMs = metricsProbe.responseTimeMs;
  const metrics = metricsResult.error ? null : normalizeMetrics(metricsResult.data);
  const database: ServiceHealth = {
    name: "Database",
    description: "Accounts, sessions, and realtime data",
    status: metricsResult.error ? "outage" : databaseTimeMs > 1_500 ? "degraded" : "operational",
    responseTimeMs: databaseTimeMs,
  };
  const api: ServiceHealth = {
    name: "API",
    description: "Authentication and session services",
    status: "operational",
    responseTimeMs: Math.round(performance.now() - startedAt),
  };
  const services = [api, database, webapp, website];
  const status: HealthState = services.some((service) => service.status === "outage")
    ? "outage"
    : services.some((service) => service.status === "degraded") ? "degraded" : "operational";
  const payload: StatusPayload = {
    status,
    checkedAt: new Date().toISOString(),
    services,
    metrics,
  };

  cache.set(CACHE_KEY, payload, TTL.PUBLIC_STATUS);
  res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
  res.json({ data: payload });

  console.info(JSON.stringify({
    event: "public_status_check",
    route: "/api/public/status",
    overall_status: status,
    database_status: database.status,
    duration_ms: Math.round(performance.now() - startedAt),
    metrics_available: metrics !== null,
  }));
});

export default router;
