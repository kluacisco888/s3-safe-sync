# Encrypt metadata and use random object identifiers

Vault paths, revisions, deletion records, commits, and conflicts will be encrypted before upload, and S3 objects will use random identifiers without cross-file deduplication. This prevents plaintext names and hashes from leaking through object keys at the cost of storing identical content more than once.
