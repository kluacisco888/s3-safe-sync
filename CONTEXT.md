# Vault Synchronization

This context describes how one Obsidian vault is shared safely across independently operating devices.

## Language

**Vault**:
The body of user-owned Obsidian content that is eligible to be shared across devices.
_Avoid_: Repository, database

**Replica**:
A device-local view of a Vault that may accept changes while disconnected from every other Replica.
_Avoid_: Client, secondary copy

**Remote Store**:
The shared S3 location through which Replicas exchange Vault changes; it is not itself a privileged Replica.
_Avoid_: Master, source of truth, server

**Vault Entry**:
A synchronizable item with a stable identity whose name and path may change over time.
_Avoid_: Path, file

**Deletion Record**:
The durable fact that a Vault Entry was deleted, retained independently from any recoverable copy of its content.
_Avoid_: Missing file, deleted file

**Recovery Copy**:
Content retained for 30 days after deletion or replacement so that a user can explicitly restore it without silently recreating the original Vault Entry.
_Avoid_: Live copy, resurrected file

**Conflict**:
Two changes whose relationship cannot be reconciled without choosing user intent; every conflicting version remains recoverable until that choice is made.
_Avoid_: Sync error, latest version

**Conflict Center**:
The encrypted shared holding area where every Replica can inspect unresolved versions outside the live Vault until the user chooses their outcome.
_Avoid_: Conflict folder, duplicate notes

**Restore**:
An explicit decision to make a deleted Vault Entry live again in a new version generation while preserving its stable identity.
_Avoid_: Re-upload, recreate

**Import Candidate**:
A local item on a new or reinstalled Replica whose relationship to the Remote Store cannot be proven and therefore requires an explicit import decision.
_Avoid_: Local change, conflict

**Sync Scope**:
The set of ordinary Vault files eligible for synchronization, excluding Obsidian configuration, hidden paths, underscore paths, version-control data, and temporary files by default.
_Avoid_: Entire Vault, backup set

**Deferred Download**:
A Remote Store Revision known to a mobile Replica but intentionally not materialized there because it exceeds the 50 MB mobile limit; its local absence is not a deletion.
_Avoid_: Pending transfer, ignored file, placeholder

**Unsynced Local Entry**:
A device-local Vault Entry that cannot be uploaded safely, such as a mobile file above 50 MB, and therefore remains explicitly reported as unprotected.
_Avoid_: Deferred Download, synced file

**Bulk Deletion**:
A Sync Plan that would delete more than 100 Vault Entries or more than 20 percent of the current Vault and therefore requires explicit confirmation.
_Avoid_: Empty Vault, normal cleanup

**Sync Commit**:
An immutable record of one accepted set of Vault changes and its relationship to earlier accepted changes.
_Avoid_: Sync run, timestamp

**Head**:
The single Remote Store pointer identifying the latest accepted Sync Commit from which every Replica resumes synchronization.
_Avoid_: Master copy, latest file

**Migration Baseline**:
The user-verified desktop Vault state from which the new synchronization history begins after the final Remotely Save run.
_Avoid_: Remote snapshot, automatic merge

**Path Collision**:
Two distinct Vault Entries whose displayed paths cannot coexist safely on at least one supported platform because of case or Unicode normalization.
_Avoid_: Duplicate file, conflict winner

**Revision**:
One immutable encrypted content version of a Vault Entry; superseded Revisions remain recoverable for 30 days.
_Avoid_: Backup, copy

**Sync Cache**:
Rebuildable device-local state that accelerates synchronization but never determines whether a deletion remains valid.
_Avoid_: Source of truth, deletion history

**Sync Audit**:
A shared encrypted 30-day, content-free history of synchronization plans, outcomes, and failures that excludes secrets and note contents; detailed Debug Logs remain device-local for seven days.
_Avoid_: Debug log, note history

**Vault Key**:
A randomly generated secret that encrypts one Vault's content and metadata independently from the user's password.
_Avoid_: Password, S3 credential

**Key Envelope**:
The encrypted form of a Vault Key that another Replica can unlock only with the user's password.
_Avoid_: Password file, recovery key

**Replica Identity**:
A random installation identifier with a user-editable device name, used only to attribute Sync Commits, conflicts, and audit records.
_Avoid_: Account, device authority

**Version History**:
The user-visible sequence of a Vault Entry's recoverable Revisions from the preceding 30 days.
_Avoid_: Sync Audit, permanent backup

**Repair Mode**:
A read-only synchronization state entered when Head or its referenced history cannot be authenticated, requiring an explicitly selected valid state before writes resume.
_Avoid_: Automatic rollback, retry mode

**Staged Revision**:
A downloaded Revision written to a plugin-private temporary file after decryption and content verification, then promoted behind a hash-verified recoverable backup only while the target still matches the Sync Plan. Ambiguous interrupted state remains journaled for explicit review.
_Avoid_: Partial file, temporary note

**Orphan Blob**:
An encrypted immutable object uploaded by an interrupted or rejected Sync Commit and not referenced by the accepted Head history.
_Avoid_: Deleted file, corrupt object
