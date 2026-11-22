# Baseline database contract

The identity migration creates users, devices, refresh sessions and block relationships. Conversation migrations create direct and group chats, memberships, messages, read cursors, replies, reactions and hashed group invitations. The auth-token migration adds hashed access-token digests and short access-token expiry to sessions, revoking any legacy refresh-only sessions. The push migration associates FCM registration tokens with the authenticated device and account. Migrations use PostgreSQL transactions.

| Invariant | Enforcement |
| --- | --- |
| Case-insensitive account identity | Persist lowercase ASCII usernames with 3–32 letters, digits or underscores. The API normalizes input and the database rejects noncanonical values, with a unique index on the canonical username. Display names preserve casing. |
| Session ownership | A composite foreign key ties the session's device and account to the same device row. Its refresh-token digest is unique and expiration must follow creation. |
| Session token storage | Access and refresh tokens are opaque random values. Only SHA-256 digests are stored, each with a unique constraint. Refresh rotates both tokens; access is limited to 15 minutes and refresh to 30 days. |
| Direct conversations | Sort the two distinct user UUIDs in ascending order. A check enforces order and a unique index enforces one pair. |
| Membership | Composite primary key on conversation and user. The active membership lookup is indexed by user and leave time. |
| Message retries | Unique key on conversation, sender and client-generated UUID. The messaging endpoint must return the persisted message on a retry. |
| History pagination | An index orders messages by conversation, creation time and UUID. The UUID breaks timestamp ties. |
| Read receipts | One cursor per active conversation member, constrained by a composite foreign key. Cursor updates are monotonic by message timestamp and UUID. |
| Message replies | A reply target is optional. The service only accepts a target from the same conversation; deleted targets retain a redacted preview. |
| Message reactions | A reaction is unique per message, user and emoji. Composite foreign keys constrain the message and reactor to the same conversation. |
| Message edits and deletes | Only the sender can change or soft-delete a message. Soft deletion clears content and keeps the message ID for reply references. |
| Group size and roles | Group creation and membership changes use serializable transactions, enforce a configurable active-member cap (default 100), and create the owner with the group. Ownership transfers update both roles in one transaction. |
| Invitation links | Store a SHA-256 token digest, expiration, use limit and use count. Redemption consumes a use atomically and adds membership in the same transaction. |
| Push registration | Each FCM token is unique and linked to the same account and device by a composite foreign key. Device logout removes its tokens; logout-all removes all of that user's tokens. |

Message and read routes require active membership and enforce blocks in direct conversations. Group membership management checks roles; historical memberships are retained for data integrity, while current endpoints deny access after a member leaves.

Attachments store file metadata, a private storage key, size and SHA-256 digest in PostgreSQL; the file bytes live in the server's private media directory or the Compose `media_data` volume. Messages reference at most one attachment, and attachment metadata is returned only to conversation members. Soft-deleted message files remain stored for now, but their download endpoint is disabled.
