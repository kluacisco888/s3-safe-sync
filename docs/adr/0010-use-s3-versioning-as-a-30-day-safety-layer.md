# Use S3 Versioning as a 30-day safety layer

The AWS bucket will enable Versioning with a 30-day lifecycle for noncurrent versions, using credentials already restricted to the plugin's prefix and object operations. Versioning protects against accidental remote overwrites or deletion, but protocol correctness and user-visible recovery remain independent of bucket version history.
