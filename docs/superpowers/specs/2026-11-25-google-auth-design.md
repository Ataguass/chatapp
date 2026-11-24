# Google signup and recovery for Chatapp

## Goal and release order

Give new users a way to create a Chatapp account with Google. Let existing users link Google while they can still sign in, then use that link to recover access. Keep one account and session API for web and later native clients.

Implement the PostgreSQL migration, authentication endpoints, and tests first. Connect the existing web sign-in and security screens after the backend passes verification. Android and iOS can use the same backend contract when those clients are built. Use the standard Google provider on the free Firebase Spark plan for the private beta.

## Approaches

- **Use Firebase Authentication to verify Google identity.** Reuse the existing `chatapp-ataguas` project and keep Chatapp responsible for its usernames, passwords, devices, and sessions. This adds a provider verification step and a small account-linking model. This is the proposed approach after the user confirmed Google signup in addition to recovery.
- **Use Google OpenID Connect directly.** Chatapp would run the Google authorization flow and manage provider configuration and callback handling for each platform. This avoids a Firebase Authentication dependency and requires more integration work across clients.
- **Use Auth0 as the provider broker.** Auth0 can provide managed login with a Google connection and its own hosted configuration. This adds another account, dependency, and plan to operate for the beta.

## Account behavior

### Sign in and sign up

The client signs in with Google through Firebase and sends the Firebase ID token to Chatapp. The backend verifies the token and looks up the linked Google identity. An existing linked account receives the same Chatapp session response and device record as a password login.

An unlinked identity receives a short-lived signup grant. The user chooses a unique Chatapp username and can optionally provide a display name. Google signup starts without a local password. The user can add one later after verifying their linked Google account or using a recovery code. Account creation, the Google link, grant consumption, and the first device session commit together. If the username is taken, the user can try another one with the same unexpired grant.

Chatapp stores the verified Google subject from the Firebase claims with the configured Firebase project ID. Account association is made explicitly from an authenticated Chatapp session or as part of creating a new account. Email addresses and Google profile fields carry no account-linking authority. Existing chats and data follow the Chatapp account ID.

### Link, recover, and unlink

- **Link Google.** An active Chatapp session, current Chatapp password, and fresh proof of Google sign-in are required. Each Chatapp account can have one Google identity. Each Google identity can belong to one Chatapp account. Duplicate attempts for a different account fail without exposing account details.
- **Recover with Google.** A fresh verification of a linked Google identity can issue a one-time password reset grant. Setting or resetting a Chatapp password uses the existing password validation and reset lifecycle. It revokes Chatapp sessions, disconnects their active sockets, removes their push registrations, and invalidates existing recovery codes. The user signs in again afterward.
- **Recovery codes and deletion.** Existing password-based confirmations remain available. A user signed into Chatapp can use a fresh Google proof for recovery-code generation or account deletion. The proof is bound to their current Chatapp session and its specific action. Deletion still requires their username confirmation. After signup, prompt Google-only users to generate recovery codes with a separate Google confirmation. A valid recovery code can create a local password.
- **Unlink Google.** The user must be signed into Chatapp and confirm an existing Chatapp password. A Google-only user can set a password first. Unlinking revokes Chatapp sessions and pending Google grants for the account so the user signs in again afterward. Account deletion removes the link and pending grants. A later signup with the same Google account creates a new Chatapp account with no access to the deleted account's data.

## Backend contract

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/auth/google/continue` | Accept a fresh Firebase ID token and device details. Return a Chatapp session for a linked user or an expiring signup grant bound to the device details for an unlinked identity. |
| `POST /v1/auth/google/signup` | Accept the signup grant, username, and optional display name. Create the user, Google link, and initial Chatapp session. |
| `GET /v1/auth/google/link` | Return link state and whether a local password is set for the authenticated account. |
| `POST /v1/auth/google/link` | Link a verified Google identity after confirming the active Chatapp session and current password. |
| `DELETE /v1/auth/google/link` | Remove the link after verifying the session and a current local password. |
| `POST /v1/auth/google/recovery` | Issue a short-lived, one-time reset grant for the verified linked identity. |
| `POST /v1/auth/google/password-reset` | Consume the reset grant and set a Chatapp password using the shared reset lifecycle. |
| `POST /v1/auth/google/confirm` | Issue a fresh proof for recovery-code generation or account deletion, tied to the current Chatapp session, user, and requested action. |

Extend the existing recovery-code and account deletion handlers to accept the scoped proof as an alternative to a password. Existing routes continue to accept their existing request bodies. The web server uses Chatapp's secure cookies and existing origin checks. The browser holds the temporary Firebase credential in memory during the exchange. Later native clients obtain Chatapp access and refresh tokens from the same API. Chat and Socket.IO authorize with Chatapp sessions.

## Security and data

- Make the user password hash nullable for Google-only signup. Use the existing credential checks for password-based accounts. Password login returns the same generic credential error for Google-only, nonexistent, and wrong-password accounts.
- Use the Firebase Admin SDK on the server with a dedicated named app, configured project, and read-only credentials suitable for checking disabled and revoked users. Verify the signature, audience, issuer, expiry, and revocation. Require authentication within five minutes, a `google.com` sign-in provider, and one verified Google identity in the provider claims. Use the actual authentication time to check freshness.
- Rate-limit identity exchanges and protected account changes using the existing Redis limiter. Record consumption of the Google authentication event for the short freshness window to prevent replay by refreshing the Firebase token. Once verified, issue random opaque grants with a five-minute maximum lifetime. Persist digests and expiry, bind each grant to its permitted purpose and relevant account or session, and consume the grant inside the transaction that applies the change. Expire grants and replay records with bounded cleanup.
- Use database uniqueness constraints for the project and Google subject pair and for the Chatapp account link. Use the existing account lock to serialize link, unlink, recover, and delete operations. Recheck session validity and link ownership at the point of mutation. Password changes and account recovery invalidate outstanding Google grants for the account. Concurrent attempts must create only one account or link.
- Keep Firebase tokens, grant values, secrets, and email addresses out of request logs and the Chatapp database. Store the Google identity mapping, minimal timestamps, and only the digests needed for one-time grants and replay protection. Mount credentials as read-only secrets.
- Make Google support opt-in through configuration. Provide a mode that suspends new Google signups and links while linked accounts can still sign in, confirm sensitive actions, and recover. A failure in Firebase affects Google operations with a recoverable error. Passwords, recovery codes, and Chatapp sessions provide the other entry points.

## Verification and rollout

Apply the migration to a disposable copy of the beta database. Verify legacy accounts and sessions still work. Exercise signup, username retry, repeated sign-in, linking, reset, unlink after setting a password, recovery codes, and deletion. Test that the mode for linked accounts preserves access after signup closes. Include negative tests for token replay, wrong Firebase project or provider, stale authentication, disabled or revoked identity, matching email with a different Google subject, cross-session proof use, duplicate linking, and concurrent signup. Use a deterministic provider verifier in automated tests plus an end-to-end check with an authorized test Google account before opening Google signup on the beta.

Create the private beta backup before migration. Deploy the compatible backend with Google initially disabled, configure Google sign-in and the authorized web origin in Firebase, then verify the rollout behind the existing beta gate. Once Google-only users exist, the rollback target must support linked Google accounts and the current migration. Use the mode for linked accounts to pause enrollment during an incident. Restore an earlier database snapshot during an isolated rehearsal using the existing Oracle procedure.

Exact table and module names, grant cleanup scheduling, test doubles, and screen copy are implementation decisions. Native SDK setup and public rollout are later releases.

## References

- [Firebase Google sign-in](https://firebase.google.com/docs/auth/web/google-signin)
- [Firebase ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
- [Firebase session revocation](https://firebase.google.com/docs/auth/admin/manage-sessions)
- [Firebase Spark pricing](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans)
