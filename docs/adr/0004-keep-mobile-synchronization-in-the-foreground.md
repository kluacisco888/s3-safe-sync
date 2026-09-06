# Keep mobile synchronization in the foreground

The Android and iOS plugin will synchronize while Obsidian is running in the foreground, using checkpointed work that can resume after interruption. It requests one best-effort sync when the app becomes hidden or the page begins unloading, but the mobile host may terminate before that request completes. Reliable execution after Obsidian closes would require native host capabilities or a companion application outside the scope of a pure Obsidian plugin; the next foreground startup scan remains the recovery guarantee.
