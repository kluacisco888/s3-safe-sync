# Treat local sync state as a rebuildable cache

All state required to distinguish live, deleted, restored, and conflicting entries will exist in the encrypted Remote Store; each Replica's local sync database is only a rebuildable cache. Losing or recreating a local database therefore triggers a safe bootstrap instead of erasing deletion history or turning stale files into new changes.
