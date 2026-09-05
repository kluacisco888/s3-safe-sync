# Retain revisions for 30 days and conflicts until resolution

Superseded and deleted content will remain recoverable for 30 days, permanent deletion records will retain no content, and unresolved conflict content will remain until the user explicitly resolves it. These encrypted blobs remain outside the ordinary Vault and are fetched from S3 through the plugin interface when needed. This bounds ordinary history storage without allowing time-based cleanup to discard an unresolved decision.
