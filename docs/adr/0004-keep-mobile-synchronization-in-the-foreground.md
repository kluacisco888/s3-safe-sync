# Keep mobile synchronization in the foreground

The Android and iOS plugin will synchronize only while Obsidian is running in the foreground, using checkpointed work that can resume after interruption. Reliable background execution would require native host capabilities or a companion application outside the scope of a pure Obsidian plugin.
