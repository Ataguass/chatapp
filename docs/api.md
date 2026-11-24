# API contracts

Base path: `/v1`. Authentication uses opaque bearer access tokens. Send JSON request bodies with `Content-Type: application/json`.

## Authentication

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/auth/register` | Create an account and first device session |
| POST | `/auth/login` | Authenticate and create a device session |
| POST | `/auth/refresh` | Rotate access and refresh tokens |
| POST | `/auth/logout` | Revoke the current device session |
| POST | `/auth/logout-all` | Revoke all of the current user's sessions |
| POST | `/auth/recovery-codes` | Verify the current password and replace recovery codes |
| POST | `/auth/password` | Change the password and require sign-in on every device |
| POST | `/auth/password-reset` | Reset a password by username and recovery code |
| DELETE | `/auth/account` | Confirm the username and password and permanently delete the account |
| GET | `/auth/me` | Return the authenticated user's public profile |

Registration request:

```json
{
  "username": "alice_1",
  "password": "a long passphrase",
  "displayName": "Alice",
  "platform": "web",
  "deviceName": "Personal laptop"
}
```

`displayName`, `platform`, and `deviceName` are optional. The platform defaults to `web`, the device name to `Web browser`, and the display name to the normalized username. Supported platforms are `android`, `ios`, `web`, and `desktop`. Usernames are trimmed, lowercased, then validated against `^[a-z0-9_]{3,32}$`. Passwords require at least 12 Unicode characters and are capped at 128 UTF-8 bytes.

Login accepts `username`, `password`, and the optional device fields. Refresh accepts `refreshToken`. Successful registration, login, and refresh return:

```json
{
  "accessToken": "opaque-token",
  "accessExpiresAt": "2026-11-23T12:15:00.000Z",
  "refreshToken": "opaque-token",
  "refreshExpiresAt": "2026-12-23T12:00:00.000Z",
  "user": {
    "id": "uuid",
    "username": "alice_1",
    "displayName": "Alice",
    "avatarUrl": null,
    "bio": null,
    "createdAt": "2026-11-23T12:00:00.000Z"
  }
}
```

Use `Authorization: Bearer <accessToken>` for `/auth/me`, `/auth/logout`, and `/auth/logout-all`. Access tokens expire after 15 minutes. Refresh tokens expire after 30 days and are single-use: each refresh call replaces both tokens. Tokens are returned once and only their SHA-256 digests are stored in PostgreSQL.

Logout routes return `204 No Content`. Errors use a generic JSON body such as `{"error":"invalid_credentials"}`. Duplicate usernames return `409 username_taken`; invalid credentials return the same `401 invalid_credentials` response whether the username exists or not.

Registration and login are throttled in Redis. Registration permits 20 attempts per source in 15 minutes. Login permits 120 attempts per source in five minutes and 12 per normalized username in 15 minutes. Exceeding a limit returns `429` with `Retry-After`. A limiter outage returns `503`.

Recovery code replacement requires the current bearer token and `{ "password": "…" }`. The API returns five high entropy codes once and stores only their hashes. A password reset accepts `{ "username": "…", "code": "…", "password": "…" }`, where `password` is the new password. It returns `204`, cancels all codes in the set, and revokes all sessions and push tokens. Sign in normally afterward. Recovery and protected account changes have separate rate limits.

Password changes accept `{ "currentPassword": "…", "newPassword": "…" }` and return `204`. The change revokes every access and refresh session, push registration and recovery code. Browser clients use `POST /api/session` with `action: "change_password"` and the same password fields. On success the web server clears the session cookies.

Account deletion accepts `{ "username": "…", "password": "…" }` with the current bearer token and returns `204`. It revokes every session and removes personal profile fields, memberships, messages, recovery codes, and uploads. A database queue retries deleting unlinked upload files. Shared chat history retains other users’ messages and an anonymous reference where needed for direct conversation integrity. Direct chats become read-only, and owned groups promote an active admin or the oldest remaining member. Backup retention is managed separately from deletion in the live database.

## Profiles and discovery

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/users/search?q=al` | Search usernames by prefix; returns up to 20 public profiles |
| GET | `/users/:username` | Read a public profile |
| PATCH | `/users/me` | Update the current profile |
| GET | `/users/me/devices` | List devices with active sessions for the signed-in account |
| DELETE | `/users/me/devices/:deviceId` | Revoke that device's session and push token |
| GET | `/users/me/blocks?cursor=…` | Page through accounts blocked by the current user |
| POST | `/users/:id/block` | Block a user |
| DELETE | `/users/:id/block` | Remove a block |

All profile and discovery routes require an access token. Search queries must be 2–32 username characters. Profile updates accept any nonempty subset of `displayName`, `bio`, and `avatarUrl`; display names are limited to 100 characters, bios to 500, and avatar URLs must use HTTPS. Search and profile lookup hide users when either side has blocked the other.

```json
{
  "displayName": "Alice Smith",
  "bio": "Usually around after work",
  "avatarUrl": "https://cdn.example.com/alice.png"
}
```

Use `null` for `bio` or `avatarUrl` to clear them. Blocks prevent profile discovery and direct conversation creation.

Each device has `id`, `platform`, `deviceName`, `lastSeenAt` and `current`. Device revocation is idempotent and closes live sockets on the target device. It always scopes changes to the requesting account. The block list returns `{ users, nextCursor }`.

## Direct conversations

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/conversations` | List up to 50 active conversations |
| GET | `/conversations/page?limit=50&cursor=…` | List conversations with a stable, opaque cursor |
| POST | `/conversations/direct` | Find or create a private one-to-one conversation |

Both routes require an access token. Start a direct conversation with a username or user ID:

```json
{ "username": "alice_1" }
```

The direct pair is canonicalized and unique in PostgreSQL, so repeated or concurrent requests return the same conversation. A block in either direction rejects creation with `403 messaging_blocked`; users cannot open a direct conversation with themselves.

For a full conversation list, use `/conversations/page` and repeat with `nextCursor` until it is null. Refresh this list on reconnect to discover new groups or memberships that changed while offline.

## Private groups

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/conversations/groups` | Create a private group and its initial members |
| GET | `/conversations/:id` | Read a conversation summary if you are a member |
| PATCH | `/conversations/:id` | Update a group title (owner/admin) |
| GET | `/conversations/:id/members` | List active group members and roles |
| POST | `/conversations/:id/members` | Add members (owner/admin) |
| DELETE | `/conversations/:id/members/:userId` | Remove a member (role rules apply) |
| PATCH | `/conversations/:id/members/:userId/role` | Promote/demote a member (owner only) |
| POST | `/conversations/:id/transfer-ownership` | Transfer group ownership |
| POST | `/conversations/:id/leave` | Leave a group |
| POST / GET | `/conversations/:id/invites` | Create or list invitation links (owner/admin) |
| DELETE | `/conversations/:id/invites/:inviteId` | Revoke an invitation link |
| POST | `/conversations/invites/redeem` | Join using an invitation token |
| POST | `/conversations/invites/preview` | Check an invitation and show its title before joining |

Create a group with a title and one or more existing user IDs:

```json
{ "title": "Weekend plans", "userIds": ["USER_UUID_1", "USER_UUID_2"] }
```

Groups are private and limited to 100 active members by default. Set `MAX_GROUP_MEMBERS` to a value from 2 to 500 to change the server cap. The creator becomes owner. Owners can appoint admins and transfer ownership; admins can add or remove regular members. Owners cannot leave until they transfer ownership. Members can leave at any time. Invitation links default to 100 uses and expire after seven days; configure `maxUses` from 1–1000 and `expiresInHours` from 1–720 when creating one. The raw token is returned once, while only its SHA-256 digest is stored. Redeem with `{ "token": "..." }`; joining an already active member is idempotent and does not consume a use.

Preview also accepts `{ "token": "…" }` and returns only the group title, expiry, join state and whether there is room.

## Messages and attachments

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/conversations/:id/messages?limit=50&before=<message-id>` | Read a conversation history page |
| GET | `/conversations/:id/sync?after=…&limit=50` | Get committed changes since a saved sync cursor |
| POST | `/conversations/:id/messages` | Persist a text message |
| POST | `/conversations/:id/attachments` | Upload media and persist it as a message |
| GET | `/conversations/:id/attachments/:attachment-id` | Download a message attachment |
| PUT | `/conversations/:id/messages/:message-id` | Edit your own message |
| DELETE | `/conversations/:id/messages/:message-id` | Soft-delete your own message |
| POST | `/conversations/:id/messages/hide` | Hide selected messages in the signed-in account's history |
| POST | `/conversations/:id/messages/:message-id/forward` | Copy a visible message to a conversation you can send to |
| GET | `/conversations/:id/messages/:message-id/reactions` | List reaction counts and your reaction state |
| POST / DELETE | `/conversations/:id/messages/:message-id/reactions` | Add or remove one emoji reaction |
| GET | `/conversations/:id/read-cursors` | Read each active member's latest read position |
| POST | `/conversations/:id/read` | Advance the current user's read position |
| GET | `/conversations/:id/delivery-cursors` | Restore member delivery positions |
| POST | `/conversations/:id/delivered` | Confirm that a client has received messages through a position |
| GET | `/conversations/:id/presence` | Read visible members' online status and latest device activity |
| GET | `/media/policies` | Read current upload categories, byte limits and MIME types |

Conversation message routes require an access token and active conversation membership. The first history page contains the latest messages in the order they were saved. A message's `position` is a decimal string scoped to its conversation. Follow `nextCursor` with `before` to load older messages. The limit defaults to 50 and is capped at 100.

```json
{
  "clientMessageId": "3cb7b762-8b88-456f-a554-16d6f227006b",
  "content": "Hi Alice",
  "replyToMessageId": null
}
```

Clients generate a UUID `clientMessageId` once per message and reuse it on retries. The server enforces uniqueness per sender and conversation; a retry returns the saved message with HTTP 200, while a new message returns HTTP 201. Message content is limited to 4,000 Unicode characters. `replyToMessageId` is optional and must refer to a message in the same conversation. Message objects include a reply preview, current reaction summaries, and `editedAt` / `deletedAt` timestamps. Blocking either participant prevents direct-message sends.

Upload a single raw file body. Include `Authorization: Bearer <accessToken>`, a supported `Content-Type`, `X-File-Name` (URL-encoded UTF-8 filename), and `X-Client-Message-Id` (UUID). Optional headers are `X-Message-Text` for a caption (up to 4,000 characters) and `X-Reply-To-Message-Id`. Supported formats are JPEG, PNG, WebP, MP4, MPEG audio, WAV, and PDF. The server checks the file signature and enforces limits per category: images 10 MiB, videos 50 MiB, audio 20 MiB, and documents 25 MiB by default. Configure these with `MEDIA_IMAGE_MAX_BYTES`, `MEDIA_VIDEO_MAX_BYTES`, `MEDIA_AUDIO_MAX_BYTES`, and `MEDIA_DOCUMENT_MAX_BYTES`; absolute hard caps are 100, 500, 200, and 100 MiB respectively. The raw file is streamed to private storage; it is never served from a public static directory.

Example upload:

```http
POST /v1/conversations/CONVERSATION_ID/attachments
Authorization: Bearer ACCESS_TOKEN
Content-Type: image/jpeg
Content-Length: 184322
X-File-Name: vacation%20photo.jpg
X-Client-Message-Id: 3cb7b762-8b88-456f-a554-16d6f227006b
X-Message-Text: At the beach

<raw JPEG bytes>
```

The response is the saved `PublicMessage`, with `type` set to the attachment category and `attachment` containing its ID, filename, content type, size, and authenticated `downloadPath`. Download with GET on that path and the bearer token. HEAD and single byte ranges are supported. Deleted or hidden message attachments return 404. Only active authorized members can download. `MEDIA_STORAGE_PATH` controls private storage and defaults to `server/data/media`. Docker Compose stores uploads in the persistent `media_data` volume.

Edit a message you sent with `{ "content": "Corrected text" }`. DELETE redacts the text, clears reactions, marks the reply target as deleted and queues its original media file for removal. To delete only from your own view, submit `{ "messageIds": ["…"] }` to `messages/hide`. You can hide up to 100 messages in one request. Other members keep their history. Hiding a message also removes its reply previews and download access for the requesting account.

Forward with `{ "conversationId": "DESTINATION_ID", "clientMessageId": "CLIENT_UUID" }`. Forwarding needs read access to the source and send access in the destination. The copy has its own ID and attachment, with `forwarded: true`. The source sender and conversation are kept private. Retry with the same client ID.

### Reconnect synchronization

For a new local conversation cache, fetch `/sync` without `after` to capture the starting cursor, then load history. Replay `/sync?after=STARTING_CURSOR` to catch changes made during the history load. Every sync response includes `cursor`, `hasMore`, `messages`, and `removedMessageIds`. Upsert the returned messages by ID and delete entries named in `removedMessageIds`. Update related reply previews when applying an edit, deletion or hide. Commit the data and cursor together in local storage. Keep requesting from the returned cursor while `hasMore` is true. Cursor strings are separate from message positions and scoped to the conversation and signed-in account. A fresh cache should always load history because migrations preserve older messages outside the change feed.

If access was revoked, the sync call returns 403. The client should clear that cached conversation. Real-time updates help keep the cache current while it is connected. Socket edits and reactions should update known messages. Refresh read and delivery cursors separately.

### Push notifications

Register the current authenticated device's FCM token after the client receives it, and remove it when notifications are disabled:

```http
PUT /v1/push/tokens/current
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json

{"token":"FCM_REGISTRATION_TOKEN"}
```

`DELETE /v1/push/tokens/current` removes tokens for the current device. Logout removes that device's token; logout-all removes all of the user's tokens. A newly saved message triggers a generic push for each other active conversation member. The notification does not include message text. The API also emits the normal Socket.IO message event; clients can suppress visible notifications while their conversation is in the foreground.

Delivery uses Firebase Cloud Messaging HTTP v1. Set `FCM_PROJECT_ID` and `FCM_SERVICE_ACCOUNT_FILE` together to enable it. Mount the JSON file read-only as a secret. Leave both unset to disable outbound delivery. iOS remote push requires APNs credentials and remains deferred.

A message commit queues one job per eligible push token. The worker checks membership, blocking, preferences, the device session and whether the message has been read before dispatch. It retries transient failures with backoff, follows the provider's retry delay and drops stale notifications after one hour. Each notification uses generic text. See [Firebase retry guidance](https://firebase.google.com/docs/cloud-messaging/scale-fcm).

Use GET or PATCH `/push/preferences` with `{ "pushEnabled": false }` to disable delivery for the current account. Use GET or PATCH `/conversations/:id/settings` with `{ "pushMuted": true }` to mute one conversation. The settings apply across devices.

Add and remove reactions with `{ "emoji": "👍" }` as the JSON body for `POST` and `DELETE` on the reaction endpoint. A user can have one reaction per emoji per message. The server accepts one emoji grapheme and returns the updated count and whether the caller has that emoji set.

### Read receipts

Mark the newest message the user has read. The cursor advances by the server-assigned message position, so a delayed device cannot move it backwards.

```http
POST /v1/conversations/CONVERSATION_ID/read
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json

{"messageId":"MESSAGE_ID"}
```

The response contains `conversationId`, `userId`, `lastReadMessageId`, `readAt`, and `advanced`. `advanced` is false when this message is at or before the saved cursor. Use `GET /v1/conversations/:id/read-cursors` to restore the active members' cursors after reconnecting; members who have not read a message have null cursor fields.

Delivery confirmation uses the same body on `POST /conversations/:id/delivered` after the client has applied messages through the given ID. A delivery receipt tracks what the app received. The read cursor also counts as delivery when reading the aggregate state.

## Real-time messaging

The Socket.IO gateway shares the API host and port at `/socket.io/`. Configure exact browser origins with the comma-separated `SOCKET_ALLOWED_ORIGINS` setting. When the list is empty, browser connections with an `Origin` header are denied; native clients without an `Origin` remain supported. The gateway accepts the short-lived access token in the Socket.IO `auth` payload; do not send tokens in query strings.

```ts
const socket = io(apiUrl, { auth: { token: accessToken } });
```

Authenticate first, then join only conversations returned by the API:

```ts
socket.emit("conversation:join", { conversationId }, result => {
  if (!result.ok) handleError(result.error);
});
```

| Event | Direction | Payload / result |
| --- | --- | --- |
| `conversation:join` | Client → Server | `{ conversationId }`; acknowledged with `{ ok, data: { conversationId } }` |
| `conversation:leave` | Client → Server | `{ conversationId }`; acknowledged with the same shape |
| `conversation:created` | Server → initial participants | `ConversationSummary`. Connected participants also start receiving events for the new conversation. |
| `conversation:invalidated` | Server → joined clients | `{ conversationId }`. Discard the cached conversation history and refresh after an account deletion. |
| `session:authenticate` | Client → Server | Updated access token for the same session. Keeps the existing socket connected during token rotation. |
| `message:send` | Client → Server | `{ conversationId, clientMessageId, content, replyToMessageId? }`; acknowledged with `{ ok, data: { message, created } }` |
| `message:new` | Server → joined clients | Persisted `PublicMessage`, delivered once for a newly saved message |
| `message:ack` | Server → sending socket | `{ message, created }`, including on idempotent retries |
| `message:edit` | Client → Server | `{ conversationId, messageId, content }`; peers receive `message:updated` with the full message |
| `message:delete` | Client → Server | `{ conversationId, messageId }`; peers receive `message:deleted` with the redaction timestamp |
| `message:hidden` | Server → current account's devices | `{ conversationId, messageIds }`; remove these messages and their reply previews from local caches |
| `message:reaction` | Client → Server | `{ conversationId, messageId, emoji, active }`; peers receive the updated reaction count when it changes |
| `typing:start` / `typing:stop` | Client → Server | `{ conversationId }`; forwarded to other joined clients as `{ conversationId, userId }` |
| `conversation:read` | Client → Server and server → other joined clients | Client sends `{ conversationId, messageId }`; callback returns the saved cursor, and other clients receive `{ conversationId, userId, lastReadMessageId, readAt }` when it advances |
| `conversation:delivered` | Server → joined clients | `{ conversationId, userId, lastDeliveredMessageId, lastDeliveredPosition, deliveredAt }` after an HTTP delivery acknowledgement |
| `presence:update` | Server → authorized direct peers | `{ userId, online, lastSeenAt }` when the first live device connects or the last disconnects |
| `group:member_added` | Server → group members | `{ conversationId, userId, role }` |
| `group:member_removed` | Server → remaining group members | `{ conversationId, userId }`; removed member sockets are taken out of the room |
| `group:role_changed` | Server → group members | `{ conversationId, userId, role }` |
| `group:updated` | Server → group members | `{ conversation }` |

Message actions require an authorized joined conversation and are persisted through the same service as REST. Retried sends receive an acknowledgement without broadcasting another `message:new`. The server rechecks membership and direct-chat block status for sends, edits, reactions, reads and typing events, and revalidates the access token once a minute. Blocking a direct peer closes an active call and removes both users' sockets from the direct room. Use the sync cursor and read/delivery APIs after reconnecting. Clients should leave a room when navigating away. Presence assumes one gateway instance. In groups, refresh the scoped presence API to update the member list.

## Stories

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/stories` | Publish a text story |
| POST | `/stories/media` | Publish an image or video story |
| GET | `/stories/feed?cursor=…` | Page through active stories visible to the signed-in user |
| GET | `/stories/:id` | Fetch one visible story |
| GET / HEAD | `/stories/:id/media` | Download private media with optional byte ranges |
| POST | `/stories/:id/views` | Record one view per account |
| GET | `/stories/:id/viewers?cursor=…` | List views as the author |
| DELETE | `/stories/:id` | Delete a story as the author |
| GET / PATCH | `/stories/privacy` | Read or replace the signed-in author's audience policy |

Text publishing accepts `{ "clientId": "CLIENT_UUID", "text": "…" }`. Media publishing reuses the raw upload headers and uses `X-Client-Message-Id` as the story's client ID. Captions and text are capped at 1,000 characters. A story expires 24 hours after publication. Expired stories and their media become inaccessible immediately. The maintenance worker removes the story and its views and queues file deletion.

Privacy accepts `{ "visibility": "connections", "userIds": [] }`. Connections are active direct chats in which both people have sent a message. Everyone allows authenticated accounts to see the story. Selected permits the listed accounts. Excluded allows connections except the listed accounts. The audience setting applies to all the author's active stories, and either direction of a block overrides access. The same rule protects story records, views and downloads.

## Direct calls

The gateway rings the other member of an authorized direct chat using `call:start` (`callId`, `conversationId`, `kind`). The other member receives `call:incoming` and can send `call:accept` or `call:end` with the call ID. The caller receives `call:accepted` before creating a WebRTC offer. Offers, answers and ICE candidates use `call:signal` and are relayed only between the chosen sockets. The gateway emits `call:ended` when a participant hangs up, disconnects, is blocked or the ring times out.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/calls/history?cursor=…` | Page through your outgoing and incoming calls |
| GET | `/calls/:callId` | Get a call record as one of its participants |
| GET | `/calls/ice` | Get configured ICE servers and temporary TURN credentials |

Call records include `startedAt`, `acceptedAt`, `endedAt` and `endReason`. No call media, offers or ICE candidates are saved. A call attempt to an offline user appears in history with an `offline` reason. For TURN, configure `CALL_ICE_URLS` and a read-only `CALL_TURN_SECRET_FILE` on the API and the same secret on Coturn. The backend issues credentials for 10 minutes. See [Coturn's TURN REST authentication documentation](https://github.com/coturn/coturn/blob/master/man/man1/turnserver.1).

## Reporting and administration

`POST /reports` accepts `{ "conversationId": "…", "messageId": "…", "category": "spam", "details": "…" }`. Categories are spam, harassment, inappropriate and other. Only someone who can access the message can report it, and the same reporter and message pair returns the existing report. An administrator can review the queue without a copy of message content in the report.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/admin/reports?status=pending&cursor=…` | List reports by status |
| PATCH | `/admin/reports/:id` | Resolve or dismiss a pending report with `{ "status": "resolved" }` |
| GET | `/admin/media-policies` | Inspect effective upload limits and content types |
| PATCH | `/admin/media-policies/:category` | Replace an upload policy |
| GET | `/admin/system/health` | Read readiness as a system administrator |

System administration is granted to explicit user UUIDs listed in `SYSTEM_ADMIN_USER_IDS`. Group roles grant no system permission. A policy update requires `enabled`, `maxBytes` and `contentTypes`. The configured environment byte ceiling and the server's supported MIME types still bound the effective policy. Policy changes affect future uploads and forwarding, while previously authorized downloads remain available.

Group-call media via LiveKit, incoming-call push, iOS remote push and end-to-end encryption remain separate milestones.
