# Retain deletion records permanently

Deletion records will remain in the synchronization state permanently, while recoverable deleted content expires after 30 days. The small metadata cost avoids device-membership and acknowledgement protocols, and prevents an arbitrarily old or reinstalled Replica from silently recreating deleted entries.
