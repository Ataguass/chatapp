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

## Profiles and discovery

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/users/search?q=al` | Search usernames by prefix; returns up to 20 public profiles |
| GET | `/users/:username` | Read a public profile |
| PATCH | `/users/me` | Update the current profile |
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

## Direct conversations

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/conversations` | List up to 50 active conversations |
| POST | `/conversations/direct` | Find or create a private one-to-one conversation |

Both routes require an access token. Start a direct conversation with a username or user ID:

```json
{ "username": "alice_1" }
```

The direct pair is canonicalized and unique in PostgreSQL, so repeated or concurrent requests return the same conversation. A block in either direction rejects creation with `403 messaging_blocked`; users cannot open a direct conversation with themselves.

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

Create a group with a title and one or more existing user IDs:

```json
{ "title": "Weekend plans", "userIds": ["USER_UUID_1", "USER_UUID_2"] }
```

Groups are private and limited to 100 active members by default. Set `MAX_GROUP_MEMBERS` to a value from 2 to 500 to change the server cap. The creator becomes owner. Owners can appoint admins and transfer ownership; admins can add or remove regular members. Owners cannot leave until they transfer ownership. Members can leave at any time. Invitation links default to 100 uses and expire after seven days; configure `maxUses` from 1–1000 and `expiresInHours` from 1–720 when creating one. The raw token is returned once, while only its SHA-256 digest is stored. Redeem with `{ "token": "..." }`; joining an already active member is idempotent and does not consume a use.

## Messages and attachments

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/conversations/:id/messages?limit=50&before=<message-id>` | Read a conversation history page |
| POST | `/conversations/:id/messages` | Persist a text message |
| POST | `/conversations/:id/attachments` | Upload media and persist it as a message |
| GET | `/conversations/:id/attachments/:attachment-id` | Download a message attachment |
| PUT | `/conversations/:id/messages/:message-id` | Edit your own message |
| DELETE | `/conversations/:id/messages/:message-id` | Soft-delete your own message |
| GET | `/conversations/:id/messages/:message-id/reactions` | List reaction counts and your reaction state |
| POST / DELETE | `/conversations/:id/messages/:message-id/reactions` | Add or remove one emoji reaction |
| GET | `/conversations/:id/read-cursors` | Read each active member's latest read position |
| POST | `/conversations/:id/read` | Advance the current user's read position |

Both routes require an access token and active conversation membership. The first history page contains the latest messages in chronological order. Follow `nextCursor` with `before` to load older messages; the limit defaults to 50 and is capped at 100.

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

The response is the saved `PublicMessage`, with `type` set to the attachment category and `attachment` containing its ID, filename, content type, size, and authenticated `downloadPath`. Download with GET on that path and the bearer token. Only active conversation members can download; deleted-message attachments return 404. `MEDIA_STORAGE_PATH` controls private file storage and defaults to `server/data/media` for local development. Docker Compose stores uploads in the persistent `media_data` volume.

Edit a message you sent with `{ "content": "Corrected text" }`. Delete a message you sent with `DELETE`; this is a soft delete that clears its text and sets `deletedAt`, keeping a deleted reply target available as a redacted preview.

### Push notifications

Register the current authenticated device's FCM token after the client receives it, and remove it when notifications are disabled:

```http
PUT /v1/push/tokens/current
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json

{"token":"FCM_REGISTRATION_TOKEN"}
```

`DELETE /v1/push/tokens/current` removes tokens for the current device. Logout removes that device's token; logout-all removes all of the user's tokens. A newly saved message triggers a generic push for each other active conversation member. The notification does not include message text. The API also emits the normal Socket.IO message event; clients can suppress visible notifications while their conversation is in the foreground.

Delivery uses Firebase Cloud Messaging HTTP v1. Set `FCM_PROJECT_ID` and `FCM_SERVICE_ACCOUNT_FILE` together to enable it; protect the service-account JSON file as a secret and mount it into the API container when using Docker. Leave both unset to disable outbound delivery. FCM is listed as a no-cost Firebase product, so this is the free-first provider for Android and web. iOS remote push is deferred: Apple delivery through Firebase needs an APNs authentication key, and we won't require an Apple Developer Program membership for this phase. Notifications are sent asynchronously as best-effort API work; a durable retry worker and notification preferences are future improvements.

Add and remove reactions with `{ "emoji": "👍" }` as the JSON body for `POST` and `DELETE` on the reaction endpoint. A user can have one reaction per emoji per message. The server accepts one emoji grapheme and returns the updated count and whether the caller has that emoji set.

### Read receipts

Mark the newest message the user has read. The cursor advances monotonically by message creation time and ID, so a delayed device cannot move it backwards:

```http
POST /v1/conversations/CONVERSATION_ID/read
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json

{"messageId":"MESSAGE_ID"}
```

The response contains `conversationId`, `userId`, `lastReadMessageId`, `readAt`, and `advanced`. `advanced` is false when this message is at or before the saved cursor. Use `GET /v1/conversations/:id/read-cursors` to restore the active members' cursors after reconnecting; members who have not read a message have null cursor fields.

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
| `message:send` | Client → Server | `{ conversationId, clientMessageId, content, replyToMessageId? }`; acknowledged with `{ ok, data: { message, created } }` |
| `message:new` | Server → joined clients | Persisted `PublicMessage`, delivered once for a newly saved message |
| `message:ack` | Server → sending socket | `{ message, created }`, including on idempotent retries |
| `message:edit` | Client → Server | `{ conversationId, messageId, content }`; peers receive `message:updated` with the full message |
| `message:delete` | Client → Server | `{ conversationId, messageId }`; peers receive `message:deleted` with the redaction timestamp |
| `message:reaction` | Client → Server | `{ conversationId, messageId, emoji, active }`; peers receive the updated reaction count when it changes |
| `typing:start` / `typing:stop` | Client → Server | `{ conversationId }`; forwarded to other joined clients as `{ conversationId, userId }` |
| `conversation:read` | Client → Server and server → other joined clients | Client sends `{ conversationId, messageId }`; callback returns the saved cursor, and other clients receive `{ conversationId, userId, lastReadMessageId, readAt }` when it advances |
| `group:member_added` | Server → group members | `{ conversationId, userId, role }` |
| `group:member_removed` | Server → remaining group members | `{ conversationId, userId }`; removed member sockets are taken out of the room |
| `group:role_changed` | Server → group members | `{ conversationId, userId, role }` |
| `group:updated` | Server → group members | `{ conversation }` |

Message actions require an authorized joined conversation and are persisted through the same service as REST. Retried sends receive an acknowledgement without broadcasting another `message:new`. The server rechecks membership and direct-chat block status for sends, edits, reactions, reads and typing events, and revalidates the access token once a minute so revoked or expired sessions disconnect. Clients should still load message history and read cursors after connecting or reconnecting; room delivery is a live notification path, not a history sync protocol. Access is authorized at room join, so clients should leave a room when they navigate away.

## Not in this slice

Recovery codes, password reset, rate limiting, multi-factor authentication, email/phone verification, and end-to-end encryption are not implemented yet.
