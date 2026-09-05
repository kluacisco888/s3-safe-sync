# Store immutable commits behind a conditional Head

Replicas will upload immutable content and Sync Commits before conditionally advancing one Head object with the ETag they previously read. A concurrent update rejects the stale Head write, causing that Replica to read, reconcile, and retry instead of silently overwriting another Replica's changes.
