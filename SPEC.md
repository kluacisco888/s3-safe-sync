# S3 Vault Sync MVP Specification

## Product boundary

S3 Vault Sync is a personal-first, Apache-2.0 Obsidian plugin for macOS, Android, and iOS. It synchronizes ordinary Vault files through Amazon S3 while remaining safe when devices are offline for long periods, local plugin state is lost, or synchronization is interrupted. Windows and Linux are expected to work but are not release-blocking for the first version.

The plugin does not run after Obsidian is closed, provide telemetry, synchronize Obsidian configuration, deduplicate content, compute binary deltas, or expose a remote-destruction command.

## User-visible behavior

- Synchronize on startup, five seconds after local edits settle, every two foreground minutes for remote changes, and on explicit command. When Obsidian becomes hidden or begins unloading, request one best-effort final sync; the host may still terminate before network work completes, so the next startup scan remains the guarantee. An ordinary sync request received during an active synchronization is coalesced into a guaranteed follow-up run instead of being dropped; destructive confirmations are revalidated against a fresh plan.
- Permit per-device pause without losing local observations.
- Show the current phase, file count, byte count, and current path during scanning, uploading, and downloading in plugin settings and the desktop status bar without routine success popups.
- Persist an action-required state for conflicts, corruption, unsafe bulk deletion, repair, or a local edit waiting behind a deferred remote Revision.
- Mirror normal files to mobile up to 50 MB. Android transfers use bounded S3 ranges and multipart requests; larger remote files are listed as unavailable on that device, and larger local files are explicitly unsynchronized.
- Delay mobile attachments above 10 MB until Wi-Fi by default. For this limit, `.md`, `.canvas`, and `.base` are note files; other paths are attachments.
- Offer a 30-day per-file Version History and an encrypted shared Conflict Center.
- Keep manual sync and pause controls at the top of the status view. Deleted-file paths are selectable and copyable, and UTF-8 recovery content up to 1 MiB can be previewed read-only before restoration.

## Sync Scope

Include ordinary files of every extension. Exclude `.obsidian`, dot-prefixed path segments, underscore-prefixed path segments, version-control directories, `node_modules`, and temporary office files. Configurable exclusion globs, bookmarks, and configuration synchronization are outside the first release. Remote paths that the current device cannot create are deferred without becoming deletions and require a rename on another device. A previously deferred Entry remains known as unmaterialized and is downloaded when its path later becomes supported instead of treating its absence as a local deletion.

## Remote layout

The user chooses an empty S3 prefix. All identifiers below are opaque or fixed protocol control names; payloads other than bootstrap version fields are encrypted.

```text
<prefix>/v1/head
<prefix>/v1/key-envelope
<prefix>/v1/commits/<random-id>
<prefix>/v1/blobs/<random-id>
<prefix>/v1/snapshots/<random-id>
<prefix>/v1/audits/<random-id>
```

Immutable objects use `If-None-Match: *`. Head uses `If-Match` with its previously read ETag, or `If-None-Match: *` during initialization. A rejected Head write reloads and reconciles instead of overwriting, using jittered exponential backoff and a bounded automatic retry schedule so concurrent Replicas do not remain in a sticky error state.

## State model

Each Vault Entry has a stable random ID and a mutable normalized path. Its state is live, deleted, or conflicted. Every Revision references an immutable encrypted blob and encrypted plaintext hash. Deletion Records remain permanently in snapshots and commits; deleted or superseded content expires after 30 days. Unresolved conflict blobs remain until explicit resolution.

Sync Commits form an immutable parent-linked history. The accepted Head identifies the current commit. Encrypted snapshots are written every 100 accepted commits for bootstrap performance. Device clocks never establish causality; AWS-observed commit time drives retention only.

## Reconciliation invariants

1. A stale Replica cannot turn a known deleted Entry into a new Entry.
2. Edit/delete produces a Conflict; the original path remains deleted until explicit Restore.
3. Concurrent edits merge only for UTF-8 Markdown below 5 MB with a common base and a clean three-way result.
4. Ambiguous rename, bootstrap, or path collision requires explicit resolution.
5. A local cache loss triggers remote bootstrap, never loss of deletion history.
6. Live files are replaced only after staged content authenticates and its plaintext hash matches.
7. Head never references a blob or commit that was not uploaded successfully first. Every newly uploaded Blob is read back, authenticated, and checked against its plaintext size and hash before publication.
8. Every Head read checks that all referenced blob keys still exist. Before publishing a change to an existing Entry, its current decision-bearing Revision is downloaded, authenticated, and matched to its encrypted plaintext size and hash.
9. A local draft created from a deleted base conflicts with a concurrent remote Restore; neither version is overwritten. Before replacing any materialized local version, the plugin verifies that an authenticated remote recovery copy of that exact plaintext still exists.
10. Local materialization uses a no-overwrite copy and hash-checked local trash fallback. A path owned by another Entry, a move target that appears after planning, or a non-unique rename identity stops without replacing either file.
11. A deferred Entry retains the last accepted local Revision as its reconciliation base. Raising a device limit downloads an unchanged stale copy, while edits made during deferral become action-required and later reconcile as a Conflict.
12. A rename concurrent with an edit combines the renamed path and edited content when those changes are independent. Deletion wins over a rename that did not change content; rename plus content changes enters the Conflict Center.

## Encryption

The migration reader supports Remotely Save 0.5.25 Rclone Crypt with base64url names. New protocol blobs use authenticated Rclone Crypt data framing with a random Vault Key. The user's password derives an AES-GCM wrapping key for a Key Envelope containing the Vault Key. Password validation and migration are read-only until every preflight succeeds.

Paths, hashes, entry metadata, deletion records, conflicts, commits, snapshots, and audit payloads are encrypted. S3 can still observe the bucket and prefix, fixed control-object roles, random object IDs, ciphertext sizes, counts, and request timing.

## Safety and recovery

- Bulk deletion over 100 entries or 20 percent of current entries requires confirmation bound to the exact Entry ID set; any changed deletion set requires a new confirmation.
- Automatic sync, initialization, deferred downloads, imports, previews, and all restore or Conflict actions share one per-plugin serial operation queue so an older operation cannot overwrite a newer cache.
- A missing, unauthenticated, or dangling Head enters read-only Repair Mode.
- S3 capability probes verify conditional create/update, read, list, and delete before initialization.
- S3 Versioning and a 30-day noncurrent-version lifecycle are an independent safety layer.
- Physical expiry cleanup is disabled during Beta. Before it is enabled, expiration must create an accepted cleanup decision followed by at least 24 hours of grace before physical deletion.
- The plugin never deletes a legacy Remotely Save prefix or offers one-click remote destruction.

## Migration

The user completes one final Remotely Save sync, reviews the desktop Vault, disables Remotely Save manually, and selects a different S3 prefix. Local desktop content becomes the baseline only after a read-only comparison with the old encrypted prefix. Missing, additional, mixed-format, or undecryptable legacy objects stop migration for review. New devices bootstrap remote state before classifying any existing local file as an Import Candidate.

## Acceptance tests

- Desktop delete followed by a long-offline mobile sync does not resurrect the file, including after mobile cache loss.
- Edit/delete and edit/edit preserve every user-authored version and surface the correct resolution action.
- Concurrent CAS writers converge after one receives `412 Precondition Failed`.
- Crash or cancellation before Head advancement leaves live state unchanged, and an uploaded Orphan Blob never becomes current.
- Wrong password, corrupted ciphertext, mixed legacy data, Vault ID mismatch, and unsupported protocol version perform no writes.
- Android and iOS pass encrypted 50 MB upload, download, interruption, and resume tests before leaving Beta.

## Build and install

Requirements: Node.js 22 or newer and Obsidian 1.12.3 or newer.

```sh
npm install
npm test
npm run build
```

An opt-in live AWS test is available through `npm run test:integration`. It reads `S3_VAULT_SYNC_TEST_ACCESS_KEY_ID`, `S3_VAULT_SYNC_TEST_SECRET_ACCESS_KEY`, `S3_VAULT_SYNC_TEST_REGION`, and `S3_VAULT_SYNC_TEST_BUCKET` from the process environment and creates only a random `integration/` child prefix. The default test command never reads AWS credentials.

For a manual Beta installation, copy `main.js`, `manifest.json`, and `styles.css` into `<Vault>/.obsidian/plugins/s3-vault-sync/`, reload Obsidian, and enable **S3 Vault Sync** under Community plugins.

In plugin settings, enter a device-specific AWS Access Key ID and Secret Access Key, region, bucket, and an empty new prefix. For migration, also enter the existing Remotely Save prefix, complete one final Remotely Save synchronization, inspect the desktop Vault, and disable Remotely Save before initializing. The same Vault password reads the legacy Rclone Crypt data and protects the new Key Envelope.

Enable S3 Versioning in the AWS console and scope each device's IAM policy to list the bucket prefix and get, put, and delete objects beneath it. Configure a 30-day lifecycle for noncurrent versions; the plugin does not request bucket-management permission.

## Beta boundary

- Automated tests cover deletion resurrection after cache loss, concurrent restore/local-draft conflicts, rename/edit combinations, occupied rename targets, edit/delete, edit/edit, clean Markdown merge, conflicts, history restore, encrypted migration comparison, Head CAS, snapshots, mobile deferral and limit changes, exact-set bulk-delete confirmation, cache-loss mismatches, edits during download/delete, corrupted recovery copies, truncated reads, and staged replacement recovery.
- The generated bundle contains no Node/Electron runtime import. A OnePlus Android 16 device has passed a 49.6 MB ranged download and a 12 MiB two-part upload without the previous `requestUrlAndroid` Base64 OOM; a full 50 MB upload, interruption/resume, and iOS still require real-device validation.
- An opt-in desktop stress test round-trips an encrypted 50 MiB Revision under a 256 MiB Node heap. This validates local cryptographic framing and truncation checks, not Android or iOS lifecycle behavior.
- S3 integration supports global and `aws-cn` virtual-hosted endpoints. Live `cn-northwest-1` tests have passed signed List/Get/Put/Delete, stale ETag rejection, encrypted Blob/Commit round trips, ranged reads, multipart writes, concurrent Head CAS, and an Obsidian 1.13.7 macOS initialization plus no-op synchronization through `requestUrl`.
- Desktop transfers currently have no configured size limit but use Obsidian's whole-file binary API; streaming multipart transfer remains required before claiming arbitrarily large-file support.
- Android network responses are fetched in 4 MiB ranges and uploads use 8 MiB multipart parts, but encryption and decryption still operate on a complete file. Final local replacement uses a verified temporary file, hash-checked backup, and recovery journal so an interrupted promotion restores the old file, keeps the verified new file, or stops with ambiguous copies preserved. A successfully retired backup is moved to local trash instead of being permanently removed. Network transfer itself is not resumable across app restarts, so mobile transfer remains Beta below the configured 50 MB ceiling.
- Restore operations enforce the 30-day deadline using AWS-observed time. Deleted conflict candidates retained in Version History can be previewed and restored even when no primary deletion recovery remains. Removing expired metadata, physical orphan-blob garbage collection, and shared audit browsing remain follow-up hardening work; S3 Versioning is the operational fallback during Beta.
- Repair Mode prevents further writes when Head is missing or invalid. During Beta, selecting a previous Head version is performed in the AWS console; an in-plugin S3 Versioning browser is not yet implemented.
