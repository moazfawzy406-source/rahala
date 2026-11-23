# Cloudflare Free preview

This port preserves the React interface and Node development server. The Cloudflare deployment uses a new Worker plus a NEW SQLite-backed Durable Object, not the old D1 database. It uses no R2, no paid subscription, no credit card. It is a pilot, not a guarantee of capacity for 700 concurrent users.

## Local checks

```
npm ci
npm run cf:build
npm run cf:check
npm test
node tests/cloudflare-smoke.mjs
npx tsc -p cloudflare/tsconfig.json --noEmit
```

The source archive is assembled from an explicit allowlist during cf:check/cf:deploy. Never include local databases, secrets, .dev.vars or runtime exports. Native better-sqlite3 remains for local Node development only and is not in the Worker runtime bundle. iconv-lite is overridden to fix its older stream initialization under Workers.

## Deployment

Use a fresh narrow token, verify account identity and Free plan, choose an unused Worker name, and verify it is not the existing production Worker. No old binding, DNS route, database or secret is reused. Run cf:deploy only after the owner approves the shown change. Never force-push while the owner is also updating this repository. Fetch and review their commits before changes and again before pushing.

## New Owner

Set OWNER_BOOTSTRAP_TOKEN as a random short-lived Worker secret, never in this repository or command arguments. POST /bootstrap-owner using the matching Bearer secret and username, name, password. Personal email is optional; no-email accounts get an internal .invalid placeholder to retain the original schema. Password must arrive through the vault, not conversation. Existing Owner makes this route refuse further creation. Remove the bootstrap secret immediately after verified login. No default owner/password is shipped.

## Forgotten Owner password

Owner recovery requires administrative Cloudflare control, not another app admin. Set a fresh one-time OWNER_RECOVERY_TOKEN through the protected deployment channel. POST /bootstrap-owner/reset with matching Bearer secret, exact Owner username and vault-supplied new password. The token is marked consumed, password is hashed, old sessions are revoked, login lockouts are cleared. Delete the Worker secret after success. Verify old password/session no longer works and new one does. If Cloudflare account access is also lost, recover that account first. Never leave a standing reset password or expose the token in a URL.

Members can ask an app admin to set a temporary password through the existing protected admin route. Only Owner can reset another admin; nobody can reset Owner through that route. No email recovery was enabled.

## Pilot limits

Cloudflare adapter: 2,000,000 bytes per file/voice, 500,000 bytes per avatar, 10,000,000 stored asset bytes per user, 300,000,000 total stored asset bytes. These are checked server-side, and file type/checksum/access checks remain. Use educational resource links for larger material. No public/private upload bytes in static assets. Pending uploads count toward quota. Storage/attachment cleanup policy still needs real usage review before broad cohort launch.

Free account quotas are shared with other apps, including the old site. Monitor usage before inviting students. HTTP polling was replaced by socket events and visibility refresh. Local countdown timers do not send HTTP requests. WebSockets use Durable Object Hibernation and serializable metadata; room moderation/timer state is persisted for reconstruction. The SQL adapter keeps one authoritative relational store for the pilot. Sharding or D1 is a later deliberate migration.

## Known limits

The Majalis media layer is browser-to-browser WebRTC, not Cloudflare-hosted conferencing. STUN-only connections do not work across every mobile/strict NAT network. No paid TURN relay, SFU or large-group video capacity is supplied. Existing ICE configuration support is retained, but do not add persistent TURN credentials to a public config. Real two-network camera/mic tests and load testing are required before claiming universal calls or 700 concurrent media users.

Package audit currently reports six moderate findings in archive/build-tool transitive packages, no high/critical. No blind major-version downgrade was applied. Keep dependencies and the source archive under review. Original role/history/security acceptance tests and separate local Cloudflare smoke tests pass, but they do not replace production security review.

### Open signup and private signup Sheet

Open signup is disabled unless `OPEN_REGISTRATION=true`. Do not enable it before configuring and testing Managed Turnstile with the exact app hostname and action `register`. Set the public `TURNSTILE_SITE_KEY` as a Worker variable and `TURNSTILE_SECRET` as a Worker secret. Failed/missing verification fails closed. New accounts are approved members without past-channel-history access. Existing pending accounts and group membership approval are unchanged. The Owner can pause new signup in the admin panel.

Recovery codes are 192-bit random one-use values, displayed once and stored only as SHA-256 hashes. Password recovery rotates the code and revokes all sessions. Only members use code recovery. Owner credentials keep the existing separate operator recovery route. Existing approved members can create a code in Account after verifying their password. The Owner can issue a new member code in member management. Administrative password resets invalidate old codes. Codes and passwords are never sent to the Sheet.

For Sheet sync, create an Apps Script project on the chosen owner's private Sheet and use `scripts/signup-sheet.gs`. Configure Script Properties `RAHALA_SIGNUP_SHEET_ID` and `RAHALA_SIGNUP_HMAC`. The `Signups` tab must have six columns: Event ID, User ID, Name, Username, Signup time UTC, Recovery enabled. Deploy as a web app executing as the owner, with access Anyone. The web app is reachable without Google sign-in but accepts only schema-valid, fresh HMAC-authenticated requests. The Sheet itself stays private. Put the same shared secret into Worker secret `SIGNUP_WEBHOOK_SECRET` and the deployed `/exec` endpoint into `SIGNUP_WEBHOOK_URL`. Do not commit credentials or put them in URLs, browser source, archives or logs.

Signup commits its metadata to a local outbox in the same transaction as account creation. A Durable Object alarm sends at most 20 events per request, with capped exponential retry delays and event-ID deduplication at the receiver. Sheet failure never blocks entry. Successfully acknowledged payloads are cleared from the outbox. Owner admin status shows whether sync is configured and how many records remain. Google quotas still apply; this is not a guarantee of 700 simultaneous registrations or meetings. Test a synthetic append and outage/retry before opening registration, then remove the synthetic row through the Sheet UI.

Validation: `npm test`, `node tests/signup-sheet-script.mjs`, `node tests/cloudflare-smoke.mjs`, `npm run cf:check`. Test-only challenge responses in unit tests are mocked in the test runner, never a production bypass.
