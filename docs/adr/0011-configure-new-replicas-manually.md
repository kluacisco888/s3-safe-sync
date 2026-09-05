# Configure new Replicas manually

A new Replica will be configured by manually entering its AWS region, bucket, prefix, device-specific fixed Access Key ID, Secret Access Key, and Vault password. Each Replica's credentials are restricted to the selected S3 prefix and stored locally through Obsidian SecretStorage, allowing one lost device to be revoked without affecting the others. Connection-profile export, QR transfer, temporary credentials, and role refresh are deferred beyond the first release.
