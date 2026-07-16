// Drip email sequences. Steps are defined in code; the scheduler in
// emailScheduler.ts sends each step once per recipient (tracked in the
// email_sends table) after `afterDays` from the row's created_at.

import type { BrandedEmailOptions } from "./email";

export type SequenceStep = {
  id: string; // unique forever — changing it re-sends to everyone
  afterDays: number;
  subject: string;
  /** Plain-text body. `{{unsubscribe}}` is replaced with the opt-out URL. */
  body: string;
  /** Rich content rendered through the shared, email-client-safe template. */
  content: Omit<BrandedEmailOptions, "unsubscribe">;
};

const FOOTER = `

—
BetterPomo · focus is better, together
Don't want these emails? Unsubscribe: {{unsubscribe}}`;

/** Nurture for wishlist signups (no account yet). Keyed by wishlist.created_at. */
export const WAITLIST_SEQUENCE: SequenceStep[] = [
  {
    id: "waitlist-welcome",
    afterDays: 0,
    subject: "You're on the BetterPomo waitlist 🍅",
    body: `Hey!

You're on the list. BetterPomo is a shared Pomodoro timer — you start a session, share a six-character code, and focus in sync with your study group, friends, or team.

We're onboarding the waitlist in small cohorts, and you'll get one email from us the moment your seat is ready.

Until then, you can already try the web app at https://app.betterpomo.com.

Talk soon,
BetterPomo${FOOTER}`,
    content: {
      preview: "You’re on the list. Your BetterPomo seat is saved.",
      eyebrow: "Waitlist",
      heading: "You’re on the list 🍅",
      paragraphs: [
        "BetterPomo is a shared Pomodoro timer: start a session, share one six-character code, and focus in sync with your study group, friends, or team.",
        "We’re onboarding the waitlist in small cohorts. You’ll hear from us the moment your seat is ready.",
      ],
      notice: "You don’t have to wait to try it—the web app is already open.",
      action: { label: "Try BetterPomo", url: "https://app.betterpomo.com" },
      signoff: "Talk soon,\nThe BetterPomo team",
    },
  },
  {
    id: "waitlist-how-it-works",
    afterDays: 3,
    subject: "How a BetterPomo session works",
    body: `Quick tour while you wait:

1. Create a session — pick your focus/break lengths, or classic 25/5.
2. Share the code — one six-character code, no installs, no invites.
3. Focus together — timers stay in sync, chat between rounds, and your history saves itself.

There's also an ambient sound mixer, tasks and notes per session, and stats on your profile — streaks, hours, all tracked automatically.

Try it now: https://app.betterpomo.com${FOOTER}`,
    content: {
      preview: "Create, share, and focus together in three simple steps.",
      eyebrow: "Quick tour",
      heading: "How a BetterPomo session works",
      paragraphs: ["Going from distracted to focused takes about ten seconds."],
      bullets: [
        "Create a session — choose your focus and break lengths, or start with the classic 25/5.",
        "Share the code — one six-character code, with no installs or invitations required.",
        "Focus together — timers stay synced, chat between rounds, and everyone keeps their own history.",
      ],
      notice: "Also inside: ambient sounds, personal notes and tasks, profile stats, streaks, and focus history.",
      action: { label: "Start a session", url: "https://app.betterpomo.com" },
    },
  },
  {
    id: "waitlist-vision",
    afterDays: 7,
    subject: "Why we're building BetterPomo",
    body: `Solo timers don't keep you accountable. People do.

The Pomodoro technique works — until nobody's watching. Millions already recreate the fix by hand: study-with-me streams, virtual coworking rooms, Discord timer bots. We're productizing it — shared, synced focus sessions with the social layer built in.

Web today. iOS and Android next. Your seat on the waitlist is saved.

https://betterpomo.com${FOOTER}`,
    content: {
      preview: "The idea behind shared, synced focus sessions.",
      eyebrow: "Why BetterPomo",
      heading: "Solo timers don’t keep you accountable. People do.",
      paragraphs: [
        "The Pomodoro technique works—until nobody’s watching. People already recreate the missing accountability through study-with-me streams, virtual coworking rooms, and Discord timer bots.",
        "BetterPomo turns that behavior into one calm place: shared, synchronized focus sessions with the social layer built in.",
      ],
      notice: "The web app is live today. iOS and Android are next, and your waitlist seat is saved.",
      action: { label: "See BetterPomo", url: "https://betterpomo.com" },
    },
  },
];

/** Onboarding drip for registered users. Keyed by profiles.created_at. */
export const USER_SEQUENCE: SequenceStep[] = [
  {
    id: "user-welcome",
    afterDays: 0,
    subject: "Welcome to BetterPomo 🍅",
    body: `Welcome aboard!

Your account is live. The fastest way in:

1. Hit "New Pomo" on the dashboard.
2. Share the session code with a friend (or run it solo).
3. Focus — your history and stats save themselves.

https://app.betterpomo.com/dashboard${FOOTER}`,
    content: {
      preview: "Your BetterPomo account is ready. Start your first session.",
      eyebrow: "Welcome",
      heading: "Your focus space is ready 🍅",
      paragraphs: ["Welcome aboard. The fastest way to feel what BetterPomo does is to run one session."],
      bullets: [
        "Choose New Session from your dashboard.",
        "Share the session code with a friend—or keep it solo.",
        "Focus. Your history, tasks, and stats are saved for you.",
      ],
      action: { label: "Open your dashboard", url: "https://app.betterpomo.com/dashboard" },
      signoff: "Here’s to a focused day,\nThe BetterPomo team",
    },
  },
  {
    id: "user-tips",
    afterDays: 3,
    subject: "3 BetterPomo features people miss",
    body: `Three things worth trying this week:

• Ambient sounds — layer rain or café noise under your session.
• Tasks & notes — write down what the session is for and check things off.
• Friends — add your people and see what they're focusing on.

https://app.betterpomo.com/dashboard${FOOTER}`,
    content: {
      preview: "Three useful BetterPomo features worth trying this week.",
      eyebrow: "BetterPomo tips",
      heading: "Three features people often miss",
      paragraphs: ["A timer is only the beginning. These small tools make a session much easier to settle into."],
      bullets: [
        "Ambient sounds — layer rain, a café, or other soundscapes beneath your session.",
        "Tasks and notes — capture the goal, check work off, and keep completed tasks in your history.",
        "Friends — add your people and see what they’re focusing on.",
      ],
      action: { label: "Try them now", url: "https://app.betterpomo.com/dashboard" },
    },
  },
  {
    id: "user-checkin",
    afterDays: 10,
    subject: "Your next focus session is one code away",
    body: `Just checking in.

If the streak slipped, no judgment — that's exactly why BetterPomo exists. Start a session, send the code to one person, and the next 25 minutes take care of themselves.

https://app.betterpomo.com/dashboard

P.S. Have feedback or a feature you want? Post it on the board: https://app.betterpomo.com/feedback${FOOTER}`,
    content: {
      preview: "Your next focused 25 minutes are one session code away.",
      eyebrow: "A gentle check-in",
      heading: "Ready for the next 25 minutes?",
      paragraphs: [
        "If the streak slipped, no judgment—that’s exactly why BetterPomo exists.",
        "Start a session, send the code to one person, and let the next 25 minutes take care of themselves.",
      ],
      action: { label: "Start focusing", url: "https://app.betterpomo.com/dashboard" },
      secondaryAction: { label: "Share feedback or request a feature", url: "https://app.betterpomo.com/feedback" },
    },
  },
];
