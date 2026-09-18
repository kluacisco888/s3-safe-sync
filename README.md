# S3 Safe Sync

S3 Safe Sync synchronizes Obsidian Vault files through an Amazon S3 bucket you control. It encrypts file content, paths, hashes, deletion records, conflicts, and synchronization history before upload.

> [!WARNING]
> This project is in beta. Keep an independent backup and enable S3 Versioning. Android has been tested with encrypted synchronization; iOS still needs real-device validation.

## Why it exists

The plugin is designed around two rules:

- A file deleted on one device must not reappear when an old device comes online.
- Concurrent or interrupted work must stop or become recoverable instead of being silently overwritten.

It uses stable entry identities, permanent deletion records, immutable encrypted revisions, three-way reconciliation, and conditional S3 Head updates. Previous file revisions and deleted content remain available for recovery for 30 days.

## Features

- Amazon S3 storage, including AWS China regions.
- End-to-end encryption for file content and synchronization metadata.
- Startup, edit-triggered, foreground polling, shutdown-attempt, and manual synchronization.
- Deletion propagation without stale-device resurrection.
- Three-way Markdown merge and a shared encrypted Conflict Center.
- Thirty-day version history and deleted-file preview/restore.
- Conditional Head publication so concurrent devices cannot silently overwrite each other.
- Incremental scans with streamed desktop hashing.
- Android ranged downloads and multipart uploads.
- Per-device pause and mobile transfer limits.
- Remotely Save Rclone Crypt migration comparison.

## Installation with BRAT

1. Install **BRAT** from Obsidian's Community Plugins browser.
2. Run **BRAT: Add a beta plugin**.
3. Enter `https://github.com/kluacisco888/s3-safe-sync`.
4. Enable **S3 Safe Sync** in Community Plugins.

BRAT installs and updates the release assets while preserving this plugin's `data.json` and Obsidian SecretStorage values. Do not change the plugin ID or delete its entire plugin directory if you want to retain the existing local configuration.

## Configuration

For each device, enter:

- AWS region.
- S3 bucket.
- A new, dedicated prefix.
- An AWS access key and secret key scoped to that bucket and prefix.
- The same Vault password on every device.

Credentials and the unlocked Vault key are stored in Obsidian SecretStorage. The Vault password itself is not stored. Vault Markdown files remain ordinary local files; encryption protects data placed in S3.

Credential and password fields are masked by default and provide temporary Show/Hide controls. On mobile, each secret uses its own full-width row. After a successful unlock, the settings page reports that the device is unlocked; the password field remains empty because the stored Vault Key, not the password, is reused across restarts.

For a new shared Vault, initialize one trusted desktop first. Let it finish, then configure other devices with the same bucket, prefix, and password. Disable Remotely Save before migrating and never let both plugins write to the same data during cutover.

## Suggested IAM policy

Replace `YOUR_BUCKET` and `YOUR_PREFIX`. Keep S3 Block Public Access enabled.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::YOUR_BUCKET",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["YOUR_PREFIX", "YOUR_PREFIX/*"]
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload"
      ],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/YOUR_PREFIX/*"
    }
  ]
}
```

Enable S3 Versioning and retain noncurrent versions for at least 30 days as an independent recovery layer.

## Synchronization behavior

Each run compares three states: the last state accepted by this device, current local files, and the encrypted remote Head. Only one-sided edits are applied automatically. Concurrent Markdown edits merge only when a clean three-way merge is possible; otherwise both versions remain recoverable as a conflict.

Uploads are read back, decrypted, and hash-verified before their Commit can become Head. Downloads are authenticated and hash-verified before local replacement. Local replacement uses a staged file, recovery journal, verified backup, and no-overwrite promotion. Interrupted replacement restores a missing target with the same no-overwrite copy rule, verifies both copies, then moves the backup to local Trash. A newly recreated target or changed backup stops recovery and retains the recovery files for review.

The plugin asks for confirmation before propagating more than 100 deletions or more than 20 percent of the current Vault.

Folder moves recorded during synchronization retain their Entry identities even if a later move makes the intermediate paths disappear from the local cache. Ambiguous missing/new paths appear as a collapsed summary with **Review and resolve**: confirm one-to-one moves to keep file history, or explicitly treat them as separate deletions and additions. Each decision is rechecked against fresh file hashes and the remote Commit; a changed plan requires a new review, and bulk deletion still requires its separate confirmation.

**Review path collision** opens a dedicated path/identity review, including local and S3 previews, previously accepted paths and pending moves. A single displayed path can mean an occupied move destination, not an invalid filename. Rename the selected local file or S3 record to an unused, portable sibling name, then retry sync. S3 renames retain the complete Entry and version history; local moves are hash-checked and preserve confirmed identities. If the local identity is already deleted in S3, **Preserve as new file and sync** verifies a new independent encrypted copy before moving local content, leaving the old deletion record intact. File/directory collisions (including empty local folders) and occupied targets are rejected. Links referring to the old path may need updating; other affected paths can still require review after one rename.

Local path repair saves a durable intent before moving files. Before subsequent sync or manual operations, an unchanged source can cancel an unstarted move and a verified destination can complete it. Changed or ambiguous files stay blocked and expose source/target identity-confirmation buttons in the collision review. Unlocking an existing encrypted store remains available without remote writes so a missing saved key cannot prevent recovery review; initialization stays blocked until recovery is resolved. Recovery never deletes either file; if neither path remains, restore one from Trash or an independent backup before continuing. Content-fingerprint rename inference cannot take over a path already owned by a different live S3 Entry.

Finish any interrupted path repair before downgrading the plugin or clearing its local data; older versions cannot interpret the device-local rename journal.

When a new or reinstalled device has different local content at an existing remote path, use **Compare and resolve**. The read-only comparison highlights remote-only and local-only lines with line numbers and nearby context; it does not infer which version is newer. Line-ending format, a final newline, edge spaces, tabs, and BOM markers remain visible. Full text versions are available in collapsed sections. Text previews are limited to 256 KiB per version, expensive comparisons fall back to full previews, and at most 400 comparison rows are rendered with an explicit truncation notice.

When both local and S3 files exist, the actions above the previews offer three explicit choices:

- **Use local version** keeps local content at the original path and publishes it to S3; the previous S3 version stays recoverable in encrypted history for 30 days.
- **Use S3 version** uploads and verifies the unpublished local content as encrypted 30-day history before replacing the original file with S3 content. It does not create an extra visible note.
- **Keep both (local copy)** creates a uniquely named, synced local-copy file, verifies it in S3, then accepts S3 content at the original path. This separate note has no automatic 30-day expiry.

None of these choices merges contents. **Decide later** closes the review without resolving it. Local filesystem modification time and the S3 version-recording time are shown separately in the device's locale; neither timestamp nor file size determines which version wins. The completion view links to **Open version history**, with authenticated previews, expiry dates and restoration. It remains accessible by opening the file and running **S3 Safe Sync: Open version history for the current file** from the command palette.

Other unreviewed files keep their previous synchronization bases. Existing remote conflicts or deletion records still use the separate-local-copy preservation flow rather than the three live-file choices. The decision expires if either side changes; all replacement choices require authenticated backup content and conditional Head publication before local replacement. Large files and unsupported paths show the device restriction instead of bypassing it. Each local issue has inline, expandable **Why this needs attention** guidance, distinct from its actual action buttons; affected paths can be opened or copied. A missing common version can result from first connection or reinstalling, not only cache loss.

**Upload as new file** (previously **Import**) explicitly adds an unknown local path to S3. It does not restore an old file identity after a move; check for the note at its old remote path before importing a moved file.

Manual review, import, download, and restore actions accept only their selected Entries. A persisted `bootstrapPending` flag keeps unknown local files behind Import confirmation until a full bootstrap reconciliation completes, including across restarts. Reviews select the current owner when a path also has historical deletion records. Local-copy filenames fit within 255 UTF-8 bytes without splitting Unicode characters; ordinary extensions are preserved, while an extension too long to fit with the unique suffix is omitted from the copy name. Shortening affects only the copy's name, not its bytes or the original path.

Error notices, the desktop status bar, and the settings page link to sync status. Its actions and issue lists update after background checks; bulk-delete confirmation and recovery guidance do not require reopening the window. A successful manual import, download, restore, or conflict resolution keeps **Action required** while known issues remain, respects pause, and does not replace an active sync's status. Downloads deferred only by device size limits remain informational, with their count shown. Status includes settings, troubleshooting, and copy-status actions. Conflict candidates have authenticated text previews before selection. Failed restore, import, or transfer actions retain an error and can be retried; failed unlocks keep the typed password only in the current input so it can be corrected or retried. Repair Mode and filesystem restrictions provide guidance for the necessary external action, not an automatic overwrite or reset.

Reported remote integrity and Repair Mode failures are saved on this device, bound to the bucket, region, normalized prefix, and Vault ID. Unrelated manual success, pause, or plugin reload does not dismiss them. After repairing the reported remote state, resume if paused and use **Sync now**: before writing, the plugin rechecks the authenticated metadata and only the affected content or recovery copies, not every file in S3. Each verified issue is cleared separately; network failures retain the issue. Automatic rechecks respect device transfer limits; an explicitly requested oversized download can also clear its corresponding issue after authenticating and verifying that content. A rejected upload's Blob can stop blocking when the authenticated current state no longer references it.

## Scope and limits

The plugin synchronizes ordinary Vault files. It excludes Obsidian configuration, dot-prefixed and underscore-prefixed path segments, version-control directories, `node_modules`, and temporary Office files.

- Mobile automatic file limit: 50 MiB.
- Mobile attachment limit away from confirmed Wi-Fi: 10 MiB.
- Network transfer is not resumable across app restarts.
- Encryption and decryption can still hold a complete file in memory.
- Shutdown synchronization is best effort; the next startup scan is the recovery path.
- A scheduled full integrity scan runs every seven days by default.

## Network and privacy disclosure

The plugin connects directly to the Amazon S3 endpoint for the region and bucket configured by the user. It has no developer-operated server, account system, advertisements, or telemetry. S3 can still observe the bucket and prefix, fixed control-object roles, ciphertext sizes, object counts, and request timing. AWS storage and request charges are the user's responsibility.

## Development

Requires Node.js 22 or later.

```bash
npm ci
npm test
npm run build
npm run lint
```

Release builds produce `main.js`. A GitHub release must attach `main.js`, `manifest.json`, and `styles.css` as individual assets, and its tag must exactly match the version in `manifest.json`.

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.txt](./THIRD_PARTY_NOTICES.txt).
