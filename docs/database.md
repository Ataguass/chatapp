# Baseline database contract

The identity migration creates users, devices, refresh sessions and block relationships. The conversation migration creates conversations, canonical direct pairs, memberships and messages. Both migrations use PostgreSQL transactions.

| Invariant | Enforcement |
| --- | --- |
| Case-insensitive account identity | Persist lowercase ASCII usernames with 3–32 letters, digits or underscores. The database rejects noncanonical values, with a unique index on the canonical username. Registration and search must lowercase input when implemented. Display names preserve casing. |
| Session ownership | A composite foreign key ties the session's device and account to the same device row. Its refresh-token digest is unique and expiration must follow creation. |
| Direct conversations | Sort the two distinct user UUIDs in ascending order. A check enforces order and a unique index enforces one pair. |
| Membership | Composite primary key on conversation and user. The active membership lookup is indexed by user and leave time. |
| Message retries | Unique key on conversation, sender and client-generated UUID. The messaging endpoint must return the persisted message on a retry. |
| History pagination | An index orders messages by conversation, creation time and UUID. The UUID breaks timestamp ties. |

The foundation exposes health endpoints. Future message handlers must check current membership, roles and blocks in addition to these storage constraints. A historical membership row can support old messages after a user leaves.

In the next messaging milestone, the group-creation transaction will create membership, ownership and group settings together. Invite redemption, read cursors, attachments and their policy checks belong with their respective endpoints and integration tests. Subsequent releases add stories, calls and encryption keys.
