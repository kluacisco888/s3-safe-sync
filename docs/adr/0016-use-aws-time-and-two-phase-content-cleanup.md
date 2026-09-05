# Use AWS time and two-phase content cleanup

Retention periods will be measured from authenticated Sync Commit times observed from AWS rather than device clocks. Expired content is first made unrecoverable through an accepted Sync Commit, then physically deleted after at least 24 hours; S3 Versioning retains the resulting noncurrent object version for its separate 30-day lifecycle.
