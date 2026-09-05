# Stage and verify Revisions before materializing

Downloads will resume into a plugin-private staging area and become live Vault files only after authenticated decryption and content-hash verification succeed. Mobile processes one file at a time, desktop limits parallel work, and cancellation or process termination leaves resumable Staged Revisions rather than partially replacing user content.
