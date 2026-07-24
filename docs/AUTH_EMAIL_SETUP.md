# Authentication email delivery

BetterPomo's API owns the delivery-critical authentication flows:

- Supabase Admin generates signup, resend, and recovery tokens without SMTP.
- The API logs those OTPs in development and sends them through Resend.
- Supabase still verifies each token and creates the resulting session.
- Resend failures stop the API request from reporting success and are written
  to the server log with the provider status and message.

This means mobile onboarding does not depend on Supabase SMTP or the optional
Send Email hook.

## Resend

The Resend account has `auth.betterpomo.com` as its verified sending domain.
Use a sender on that domain. A Gmail address and `onboarding@resend.dev` will
not work for arbitrary recipients.

Set these variables on the deployed API:

```env
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=no-reply@auth.betterpomo.com
AUTH_FROM_EMAIL=no-reply@auth.betterpomo.com
```

## Optional Supabase Send Email hook

Enable the hook only if BetterPomo starts triggering Auth emails outside the
API-owned registration, login confirmation, resend, and recovery endpoints—for
example, direct Supabase invitations or email-change messages.

1. Deploy the API changes.
2. Open **Supabase Dashboard → Authentication → Hooks**.
3. Create a **Send Email** hook using the **HTTPS** type.
4. Set the URL to:

   ```text
   https://api.betterpomo.com/api/auth/send-email-hook
   ```

5. Generate the hook secret in Supabase.
6. Add that exact secret to the API deployment:

   ```env
   SEND_EMAIL_HOOK_SECRET=v1,whsec_...
   ```

7. Restart/redeploy the API, then enable the hook.

Once enabled, the hook replaces SMTP delivery for Supabase-triggered Auth
messages. It is not required for mobile onboarding codes.

Hosted Supabase cannot call `localhost`. To exercise the hook against a local
API, use a secure tunnel and temporarily set the hook URL to that HTTPS URL.

## OTP logging

Outside production, OTP logging is enabled by default:

```text
[auth-code] action=signup email=person@example.com code=123456
```

In a deployed testing environment, opt in explicitly:

```env
LOG_AUTH_CODES=true
```

Set `LOG_AUTH_CODES=false` in production after testing. Codes are credentials:
anyone with log access could use a live code before it expires.

Delivery acceptance is logged separately:

```text
[auth-email] accepted action=signup email=person@example.com resend_id=...
```

Provider failures include Resend's HTTP status and message. Common failures are
an unverified From domain, an invalid/restricted API key, account quota, or rate
limits.

Authentication recipients always come from the normalized address associated
with the signup, login, resend, or recovery request. Owner notification
variables such as `WISHLIST_NOTIFY_EMAIL` and `CONTACT_NOTIFY_EMAIL` are not
authentication fallbacks. Resend messages are tagged by auth category and
action so the exact delivery path can be audited in the Resend dashboard.
