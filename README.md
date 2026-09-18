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

Uploads are read back, decrypted, and hash-verified before their Commit can become Head. Downloads are authenticated and hash-verified before local replacement. Local replacement uses a staged file, recovery journal, verified backup, and no-overwrite promotion.

The plugin asks for confirmation before propagating more than 100 deletions or more than 20 percent of the current Vault.

Folder moves recorded during synchronization retain their Entry identities even if a later move makes the intermediate paths disappear from the local cache. Ambiguous missing/new paths appear as a collapsed summary with **Review and resolve**: confirm one-to-one moves to keep file history, or explicitly treat them as separate deletions and additions. Each decision is rechecked against fresh file hashes and the remote Commit; a changed plan requires a new review, and bulk deletion still requires its separate confirmation.

When a new or reinstalled device has different local content at an existing remote path, use **Review versions**. The preservation action creates a uniquely named local-copy file, uploads and verifies it, then accepts the reviewed remote state at the original path. Other unreviewed files keep their previous synchronization bases. This also handles edits made while a conflict or deferred download was pending; existing remote conflicts and deletion records remain intact. The decision expires if either side changes. Large files and unsupported paths show the device restriction instead of bypassing it. Every local issue offers specific resolution guidance and affected paths can be opened or copied.

Error notices, the desktop status bar, and the settings page link to sync status. Its actions and issue lists update after background checks; bulk-delete confirmation and recovery guidance do not require reopening the window. Status includes settings, troubleshooting, and copy-status actions. Conflict candidates have authenticated text previews before selection. Failed restore, import, or transfer actions retain an error and can be retried; failed unlocks keep the typed password only in the current input so it can be corrected or retried. Repair Mode and filesystem restrictions provide guidance for the necessary external action, not an automatic overwrite or reset.

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
