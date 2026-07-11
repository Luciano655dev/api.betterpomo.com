import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import sessionsRouter from "./routes/sessions";
import historyRouter from "./routes/history";
import profileRouter from "./routes/profile";
import usersRouter from "./routes/users";
import friendsRouter from "./routes/friends";
import chatRouter from "./routes/chat";
import notificationsRouter from "./routes/notifications";
import wishlistRouter from "./routes/wishlist";
import authRouter from "./routes/auth";
import feedbackRouter from "./routes/feedback";
import emailRouter from "./routes/email";
import billingRouter, { stripeWebhookHandler } from "./routes/billing";
import templatesRouter from "./routes/templates";
import { startEmailScheduler } from "./lib/emailScheduler";
import { startTrialReminderSweep } from "./lib/trialReminders";
import { redis } from "./lib/redis";
import { makeRedisStore } from "./lib/rateStore";

// Fail fast on boot if required secrets are missing, instead of throwing cryptic
// errors on the first DB call.
const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
// Billing config is only required once the paid-plans system is switched on
// (BILLING_ENABLED=true); while it's off the billing routes answer 503 and
// nothing else references Stripe/RevenueCat.
if (process.env.NODE_ENV === "production" && process.env.BILLING_ENABLED === "true") {
  REQUIRED_ENV.push(
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_PRO_MONTHLY",
    "STRIPE_PRICE_PRO_YEARLY",
    "STRIPE_PRICE_LIFETIME",
    "WEBAPP_URL",
    "REVENUECAT_WEBHOOK_AUTH",
  );
}
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT ?? 4000;

// Behind a proxy/load balancer (Render, Fly, Nginx) so req.ip / protocol are correct.
app.set("trust proxy", 1);

// Allow one or more comma-separated origins (prod domain + previews).
const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    // Non-browser clients (curl, server-to-server) send no Origin — allow them.
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));
// Security headers. This is a JSON API (no HTML documents), so the CSP default —
// which only governs document rendering — is unnecessary and left off.
app.use(helmet({ contentSecurityPolicy: false }));
// Stripe webhook needs the raw (unparsed) body for signature verification, so
// it must be mounted BEFORE express.json(). It also intentionally precedes the
// /api global limiter: Stripe's servers are the only caller, and signature
// verification rejects everything else.
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), stripeWebhookHandler);
app.use(express.json({ limit: "100kb" }));

// Health check is intentionally before the limiter so uptime probes never count
// against the budget or get throttled.
app.get("/healthz", (_req, res) => { res.json({ ok: true }); });

// Generous per-IP backstop against floods. Tuned well above what a real client
// produces — the frontend polls several endpoints on intervals, and users can
// share an IP (NAT/mobile carriers) — so legitimate traffic never trips it; it
// exists to blunt abusive bursts. Override with RATE_LIMIT_MAX if needed.
const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.RATE_LIMIT_MAX ?? 600),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
  ...(redis ? { store: makeRedisStore("rl:global:") } : {}),
});
app.use("/api", globalLimiter);

// The wishlist is public and unauthenticated — the one real spam surface. Cap it
// hard: a genuine visitor signs up once.
const wishlistLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again later." },
  ...(redis ? { store: makeRedisStore("rl:wishlist:") } : {}),
});

app.use("/api/sessions", sessionsRouter);
app.use("/api/history", historyRouter);
app.use("/api/profile", profileRouter);
app.use("/api/users", usersRouter);
app.use("/api/friends", friendsRouter);
app.use("/api/chat", chatRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/wishlist", wishlistLimiter, wishlistRouter);
app.use("/api/feedback", feedbackRouter);
app.use("/api/email", emailRouter);
app.use("/api/billing", billingRouter);
app.use("/api/templates", templatesRouter);

// Public auth endpoints (register / forgot-password) are unauthenticated and
// email-sending — cap them as hard as the wishlist to blunt abuse.
const authLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again later." },
  ...(redis ? { store: makeRedisStore("rl:auth:") } : {}),
});
app.use("/api/auth", authLimiter, authRouter);

// 404 for unknown API routes.
app.use((_req, res) => { res.status(404).json({ error: "Not found" }); });

// Centralized error handler — keeps the process alive on thrown/rejected handlers
// and always returns the standard { error } shape instead of an HTML stack trace.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : "Internal server error";
  if (message === "Not allowed by CORS") { res.status(403).json({ error: message }); return; }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(PORT, () => {
  console.log(`BetterPomo API running on http://localhost:${PORT}`);
  startEmailScheduler();
  startTrialReminderSweep();
});

// Graceful shutdown so in-flight requests finish on deploy/restart.
function shutdown(signal: string) {
  console.log(`${signal} received, shutting down…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
