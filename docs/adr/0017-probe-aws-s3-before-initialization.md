# Probe AWS S3 before initialization

Before creating a Remote Store in the user-selected prefix, the plugin will create, conditionally update, read, list, and delete small probe objects to verify AWS S3 semantics and the provided IAM permissions. Any failed capability or unexpected existing data stops initialization without creating protocol state.

After preflight, a local checkpoint records the target and new Vault ID before the Key Envelope is written. A password-authenticated retry may resume content uploading only with that matching checkpoint and no remote commit history. Immediately before the first Head write, initialization persists a publishing checkpoint. Missing Head after that point, or after any remote commit exists, remains repair-only even if a stale local checkpoint is restored. The protocol's immutable objects and remote layout are unchanged.
