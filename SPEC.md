# S3 Vault Sync MVP Specification

## Product boundary

S3 Vault Sync is a personal-first, Apache-2.0 Obsidian plugin for macOS, Android, and iOS. It synchronizes ordinary Vault files through Amazon S3 while remaining safe when devices are offline for long periods, local plugin state is lost, or synchronization is interrupted. Windows and Linux are expected to work but are not release-blocking for the first version.

The plugin does not run after Obsidian is closed, provide telemetry, synchronize Obsidian configuration, deduplicate content, compute binary deltas, or expose a remote-destruction command.

## User-visible behavior

- Synchronize on startup, five seconds after local edits settle, every two foreground minutes for remote changes, and on explicit command.
- Permit per-device pause without losing local observations.
- Show routine progress in plugin UI and the desktop status bar without success popups.
- Persist an action-required state for conflicts, corruption, unsafe bulk deletion, or repair.
- Mirror normal files to mobile up to 50 MB. Larger remote files are listed as unavailable on that device; larger local files are explicitly unsynchronized.
- Delay mobile attachments above 10 MB until Wi-Fi by default.
- Offer a 30-day per-file Version History and an encrypted shared Conflict Center.

## Sync Scope

Include ordinary files of every extension. Exclude `.obsidian`, dot-prefixed path segments, underscore-prefixed path segments, version-control directories, `node_modules`, temporary office files, and configured glob patterns. Bookmarks and configuration synchronization are outside the first release.

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

Immutable objects use `If-None-Match: *`. Head uses `If-Match` with its previously read ETag, or `If-None-Match: *` during initialization. A rejected Head write reloads and reconciles instead of overwriting.

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
7. Head never references a blob or commit that was not uploaded successfully first.

## Encryption

The migration reader supports Remotely Save 0.5.25 Rclone Crypt with base64url names. New protocol blobs use authenticated Rclone Crypt data framing with a random Vault Key. The user's password derives an AES-GCM wrapping key for a Key Envelope containing the Vault Key. Password validation and migration are read-only until every preflight succeeds.

Paths, hashes, entry metadata, deletion records, conflicts, commits, snapshots, and audit payloads are encrypted. S3 can still observe the bucket and prefix, fixed control-object roles, random object IDs, ciphertext sizes, counts, and request timing.

## Safety and recovery

- Bulk deletion over 100 entries or 20 percent of current entries requires confirmation.
- A missing, unauthenticated, or dangling Head enters read-only Repair Mode.
- S3 capability probes verify conditional create/update, read, list, and delete before initialization.
- S3 Versioning and a 30-day noncurrent-version lifecycle are an independent safety layer.
- Expiration creates an accepted cleanup decision before physical deletion after an additional 24-hour grace period.
- The plugin never deletes a legacy Remotely Save prefix or offers one-click remote destruction.

## Migration

The user completes one final Remotely Save sync, reviews the desktop Vault, disables Remotely Save manually, and selects a different S3 prefix. Local desktop content becomes the baseline only after a read-only comparison with the old encrypted prefix. Missing, additional, mixed-format, or undecryptable legacy objects stop migration for review. New devices bootstrap remote state before classifying any existing local file as an Import Candidate.

## Acceptance tests

- Desktop delete followed by a long-offline mobile sync does not resurrect the file, including after mobile cache loss.
- Edit/delete and edit/edit preserve every user-authored version and surface the correct resolution action.
- Concurrent CAS writers converge after one receives `412 Precondition Failed`.
- Crash or cancellation before Head advancement leaves live state unchanged and later cleans Orphan Blobs.
- Wrong password, corrupted ciphertext, mixed legacy data, Vault ID mismatch, and unsupported protocol version perform no writes.
- Android and iOS pass encrypted 50 MB upload, download, interruption, and resume tests before leaving Beta.

## Build and install

Requirements: Node.js 22 or newer and Obsidian 1.12.3 or newer.

```sh
npm install
npm test
npm run build
```

For a manual Beta installation, copy `main.js`, `manifest.json`, and `styles.css` into `<Vault>/.obsidian/plugins/s3-vault-sync/`, reload Obsidian, and enable **S3 Vault Sync** under Community plugins.

In plugin settings, enter a device-specific AWS Access Key ID and Secret Access Key, region, bucket, and an empty new prefix. For migration, also enter the existing Remotely Save prefix, complete one final Remotely Save synchronization, inspect the desktop Vault, and disable Remotely Save before initializing. The same Vault password reads the legacy Rclone Crypt data and protects the new Key Envelope.

Enable S3 Versioning in the AWS console and scope each device's IAM policy to list the bucket prefix and get, put, and delete objects beneath it. Configure a 30-day lifecycle for noncurrent versions; the plugin does not request bucket-management permission.

## Beta boundary

- Automated tests cover deletion resurrection after cache loss, edit/delete, edit/edit, clean Markdown merge, conflicts, history restore, encrypted migration comparison, Head CAS, snapshots, mobile deferral, and bulk-delete blocking.
- The generated bundle contains no Node/Electron runtime import, but Android and iOS 50 MB transfer behavior still requires real-device validation.
- S3 integration is implemented for Amazon S3 virtual-hosted endpoints and requires a real prefix-scoped integration test before trusted use with personal data.
- Desktop transfers currently have no configured size limit but use Obsidian's whole-file binary API; streaming multipart transfer remains required before claiming arbitrarily large-file support.
- Downloads authenticate and hash the complete plaintext before calling Obsidian's binary write API, but resumable chunk staging is not yet available. Mobile upload and final materialization therefore still have whole-file memory exposure and remain Beta even below the configured 50 MB ceiling.
- Restore operations enforce the 30-day deadline using AWS-observed time. Removing expired metadata, physical orphan-blob garbage collection, and shared audit browsing remain follow-up hardening work; S3 Versioning is the operational fallback during Beta.
- Repair Mode prevents further writes when Head is missing or invalid. During Beta, selecting a previous Head version is performed in the AWS console; an in-plugin S3 Versioning browser is not yet implemented.
