# Stop writes when Head cannot be trusted

If Head is missing, unauthenticated, or references unavailable history, every Replica enters Repair Mode and performs no remote writes. Recovery explicitly selects a valid prior Head, preferably from S3 Versioning, rather than guessing from object timestamps or independently advancing another history branch.
