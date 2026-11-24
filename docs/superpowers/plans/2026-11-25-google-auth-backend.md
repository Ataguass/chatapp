# Chatapp Google Authentication Backend Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans or superpowers:subagent-driven-development to execute the steps. Track them with checkboxes.

**Goal**  
Support Google signup, sign-in, linking, and password recovery through the shared Chatapp API.

**Architecture**  
Firebase proves the Google identity. PostgreSQL owns the account-to-identity mapping and one-time authorization grants, and Chatapp issues its existing access and refresh tokens. The backend phase establishes the contract for later web and native integration.

**Tech stack**  
Node.js 22.18 or later, Express, TypeScript, Prisma, PostgreSQL, Redis, and a pinned Firebase Admin SDK.

**Spec**  
[`2026-11-25-google-auth-design.md`](../specs/2026-11-25-google-auth-design.md)

## Global constraints

- Use standard Google sign-in on the Spark plan for the beta project `chatapp-ataguas`.
- Preserve existing password, recovery-code, and session contracts. Account identity and data ownership remain attached to the Chatapp user ID.
- Bind the Google identity by configured Firebase project ID and verified Google subject. Require `google.com`, check revocation, and accept authentication from the last five minutes.
- Use only Chatapp tokens for chat APIs and Socket.IO. Put no Google tokens, email addresses, or plaintext grants in the database or logs.
- Make live changes to Firebase or the VPS as a separate rollout. Use disposable PostgreSQL and Redis for implementation tests.

## Review focus

- A Firebase refresh changes token issue time without making the Google authentication fresh. Tasks 1 and 2 cover stale and replayed authentication events.
- A signup collision must leave account creation and grant consumption atomic. Task 2 covers username retry and simultaneous requests.
- A user may unlink Google, reset their password, or delete their account while a grant is pending. Task 3 covers invalidation and session binding.
- A Google-only account must remain accessible when signup closes. Task 4 covers linked-account mode and outage behavior.
- Account association must survive an email change and reject a different Google subject with the same email. Tasks 1 and 2 cover identity matching.

## Task 1. Verify Google identity

**Files**  
Create `server/src/modules/auth/google-verifier.ts` and `server/test/core/google-verifier.test.ts`. Modify `server/package.json` and `pnpm-lock.yaml` for the pinned SDK.

**Interface**  
Export `GoogleProof` with `projectId`, `subject`, `firebaseUid`, and `authenticatedAt` in Unix seconds. Export `GoogleVerifier` with `verify(idToken: string): Promise<GoogleProof>`. Production wraps the Firebase Admin SDK. Tests inject the SDK verification boundary.

- [ ] **Write failing tests.** Assert that a verified Google subject comes from the Google provider claim and remains the same when the email changes. Assert that an invalid or revoked token, a wrong project, an ambiguous provider subject, a non-Google sign-in, and an authentication time over five minutes old are rejected. Assert `verifyIdToken` receives revocation checking enabled and a temporary provider failure yields a recoverable error.
- [ ] **Run the red test.** Run `pnpm --filter @messaging/server test` and confirm that the Google verifier cases fail because the verifier is absent.
- [ ] **Implement the verifier.** Use `pnpm --filter @messaging/server add --save-exact firebase-admin` after verifying the selected SDK supports the repo's Node versions. Validate the decoded audience and issuer, the reserved `firebase.sign_in_provider` claim, and one Google subject in the verified identities. Distinguish invalid proof from an unavailable provider with generic API errors.
- [ ] **Run the green tests.** Run `pnpm test` and `pnpm build`. Expect no failing tests or TypeScript errors.
- [ ] **Record the verified change.** Use a focused local commit when Git metadata is writable.

## Task 2. Create, link, and sign into Chatapp accounts

**Files**  
Modify `server/prisma/schema.prisma`, `server/src/modules/auth/service.ts`, `server/src/modules/auth/account-lock.ts`, `server/src/modules/auth/router.ts`, and `packages/shared-types/index.d.ts`. Create `server/prisma/migrations/20261125000100_google_auth/migration.sql`, `server/src/modules/auth/google-service.ts`, `server/src/modules/auth/google-router.ts`, and `server/test/integration/google-auth.test.ts`.

**Interfaces**  
`createGoogleAuthService(db, verifier, mode)` produces APIs for continuing login, signup, link status, and linking. Reuse the existing `AuthSessionResponse` for successful signup and sign-in. `continue` returns HTTP 200 for a linked account or HTTP 202 with `{ signupGrant, expiresAt }` for enrollment. `signup` returns HTTP 201. `GET /v1/auth/google/link` returns `{ linked, hasPassword }`.

- [ ] **Write failing PostgreSQL integration tests.** Use an injected verifier and real API requests. Cover a first Google signup with no local password, successful login to that same account, an unchanged legacy account with a similar email, failed linking with an incorrect current password, repeated linking to another account, reuse of the same authentication event across fresh Firebase tokens, a taken username followed by a successful retry with the same grant, and concurrent use of one signup grant. Assert only one Chatapp user and link are created.
- [ ] **Run the red tests.** Run `pnpm test:integration` against a disposable database migrated to the existing schema. Expect new Google tests to fail because the routes and data model are absent.
- [ ] **Add the schema and shared session support.** Make `users.password_hash` nullable. Add one Google identity per Chatapp user, unique by Firebase project and Google subject. Add expiring replay markers and digested one-time grants. Bind signup grants to validated device details. Reuse existing username, display name, device, and session issuance rules. A Google-only account uses the generic password login failure.
- [ ] **Implement enrollment and linking.** Mount the Google routes under `/v1/auth/google`. Claim an authentication event using a digest of its project, subject, Firebase user, and authentication time. Scope grants to their action, set expiry to at most five minutes and no later than the proof window, and consume them transactionally. Check that signup still targets an unlinked identity at transaction time. Link with an active, rechecked Chatapp session, current password, and fresh Google verification.
- [ ] **Run the green tests.** Run `pnpm db:deploy`, `pnpm db:drift`, `pnpm test:integration`, and `pnpm build`. Expect a successful migration, no drift, and all tests passing.
- [ ] **Record the verified change.** Use a focused local commit when Git metadata is writable.

## Task 3. Recover and protect linked accounts

**Files**  
Modify `server/src/modules/auth/google-service.ts`, `server/src/modules/auth/google-router.ts`, `server/src/modules/auth/account-lifecycle.ts`, `server/src/modules/auth/router.ts`, and `server/test/integration/google-auth.test.ts`.

**Interfaces**  
`POST /v1/auth/google/recovery` returns `{ resetGrant, expiresAt }` for a verified linked identity. `POST /v1/auth/google/password-reset` accepts `{ resetGrant, newPassword }` and returns HTTP 204. `POST /v1/auth/google/confirm` issues a proof scoped to `recovery_codes` or `delete_account` and the current Chatapp session. The existing endpoints for these operations accept `googleProof` as an alternative to their existing password field. `DELETE /v1/auth/google/link` confirms the local password and returns HTTP 204.

- [ ] **Write failing tests.** Verify that a Google recovery grant sets or resets a local password, revokes the previous sessions and push registrations, invalidates recovery codes and outstanding grants, and fails when replayed. Reject an unlinked Google identity, a proof from another session, and a proof issued for a different action. Verify that a Google-only user can create recovery codes using a separate confirmation, that a code can set a local password, and that Google can be unlinked after that password exists. Assert deletion clears the identity link and outstanding grants in the deletion transaction.
- [ ] **Run the red tests.** Run `pnpm test:integration` and confirm the new account lifecycle cases fail at the missing operations.
- [ ] **Implement the lifecycle.** Share password reset and revocation logic with the existing password and recovery-code flows. Lock the active account and recheck its Google link and relevant session before mutation. Consume the scoped grant in the same transaction. On a successful reset or unlink, use the existing socket revocation callback. Preserve the current username confirmation for deletion.
- [ ] **Run the green tests.** Run `pnpm test`, `pnpm test:integration`, and `pnpm build`. Expect no failing tests or TypeScript errors.
- [ ] **Record the verified change.** Use a focused local commit when Git metadata is writable.

## Task 4. Configure, document, and rehearse the backend release

**Files**  
Modify `server/src/config/settings.ts`, `server/src/modules/auth/throttle.ts`, `server/src/app.ts`, `server/src/index.ts`, `server/.env.example`, `server/test/core/settings.test.ts`, `server/test/integration/google-auth.test.ts`, and `docs/api.md`. Document deployment in `docs/deployment.md`.

**Interfaces**  
Use `GOOGLE_AUTH_MODE=disabled|existing|enabled`, defaulting to `disabled`. The other modes require `GOOGLE_AUTH_PROJECT_ID` and a dedicated read-only `GOOGLE_AUTH_CREDENTIALS_FILE`. Use the Redis auth limiter for exchanges and sensitive operations. Specify the HTTPS web origin and enable the standard Google provider during beta setup.

- [ ] **Write failing tests.** Assert that disabled mode starts without Firebase credentials and preserves legacy login. Assert existing mode accepts linked sign-in and recovery and blocks new enrollment and linking. Verify a verifier outage returns a recoverable status while existing Chatapp access and password login continue. Check that rate-limited requests stop before contacting Firebase.
- [ ] **Run the red tests.** Run `pnpm test` and `pnpm test:integration`. Expect failures attributable to missing configuration modes or rate limiting.
- [ ] **Implement runtime wiring.** Instantiate Firebase only for enabled modes and keep Google authentication credentials separate from FCM configuration. Add a source-based Google exchange limit of 30 requests per 15 minutes and reuse the protected account-change budget where the account is known. Add bounded cleanup of expired Google grants and replay markers. Document the new endpoint shapes and sanitized error behavior.
- [ ] **Verify deployment compatibility.** Build the production backend, apply migrations to a pre-change database with an existing account and session, then run `pnpm db:drift`, `pnpm test`, and `pnpm test:integration`. An older beta fixture must retain its account and authenticated Chatapp session. Confirm the production image starts in disabled mode with the existing PostgreSQL and Redis config.
- [ ] **Review the backend.** Use the preceding acceptance cases and the design to check the complete change. Document the need for a real Google account smoke test before enabling enrollment. Use an existing-mode compatible build as the rollback target once a Google-only account exists.
- [ ] **Record the verified change.** Use a focused local commit when Git metadata is writable. The web phase can then implement Continue with Google and Settings flows against the verified API.
