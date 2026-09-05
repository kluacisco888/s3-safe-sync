# Probe AWS S3 before initialization

Before creating a Remote Store in the user-selected prefix, the plugin will create, conditionally update, read, list, and delete small probe objects to verify AWS S3 semantics and the provided IAM permissions. Any failed capability or unexpected existing data stops initialization without creating protocol state.
