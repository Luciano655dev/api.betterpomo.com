import { Router } from "express";
import { sendContactNotification } from "../lib/email";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOPICS = ["feedback", "question", "bug", "other"] as const;
type Topic = (typeof TOPICS)[number];

/** POST /api/contact — public landing-page contact form. */
router.post("/", async (req, res) => {
  const body = req.body ?? {};

  // Hidden honeypot field. Bots tend to fill every input; acknowledge without
  // sending anything so they cannot learn how the filter works.
  if (typeof body.website === "string" && body.website.trim()) {
    res.json({ data: { ok: true } });
    return;
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const topic: Topic = TOPICS.includes(body.topic) ? body.topic : "other";

  if (name.length < 2 || name.length > 80) {
    res.status(400).json({ error: "Name must be between 2 and 80 characters" });
    return;
  }
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "Please enter a valid email" });
    return;
  }
  if (message.length < 10 || message.length > 4000) {
    res.status(400).json({ error: "Message must be between 10 and 4000 characters" });
    return;
  }

  const sent = await sendContactNotification({ name, email, topic, message });
  if (!sent) {
    res.status(503).json({ error: "We couldn't send your message right now. Please try again later." });
    return;
  }

  res.json({ data: { ok: true } });
});

export default router;
