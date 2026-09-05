import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  type ButtonComponent,
  type TextComponent,
} from "obsidian";

import type { AwsCredentials } from "./credential-store";

export interface S3VaultSyncSettings {
  bucket: string;
  confirmedRemotelySaveDisabled: boolean;
  deviceName: string;
  paused: boolean;
  prefix: string;
  region: string;
  replicaId: string;
  remotelySavePrefix: string;
  vaultId?: string;
}

export const DEFAULT_SETTINGS: S3VaultSyncSettings = {
  bucket: "",
  confirmedRemotelySaveDisabled: false,
  deviceName: "My device",
  paused: false,
  prefix: "obs-sync",
  region: "us-east-1",
  replicaId: "",
  remotelySavePrefix: "",
};

export interface SyncStatusDisplay {
  progressLabel?: string;
  text: string;
}

export interface SettingsController {
  getProgressLabel(): string | undefined;
  getSettings(): S3VaultSyncSettings;
  getStatusText(): string;
  initializeOrUnlock(password: string): Promise<void>;
  onStatusChange(
    listener: (status: SyncStatusDisplay) => void,
  ): () => void;
  saveAwsCredentials(credentials: AwsCredentials): Promise<void>;
  saveSettings(): Promise<void>;
  syncNow(): Promise<void>;
}

const asPasswordInput = (component: TextComponent): TextComponent => {
  component.inputEl.type = "password";
  return component;
};

export class S3VaultSyncSettingsTab extends PluginSettingTab {
  private stopStatusUpdates: (() => void) | undefined;

  constructor(
    app: App,
    private readonly controller: SettingsController & Plugin,
  ) {
    super(app, controller);
  }

  display(): void {
    this.stopStatusUpdates?.();
    const { containerEl } = this;
    const settings = this.controller.getSettings();
    containerEl.empty();
    const statusSetting = new Setting(containerEl)
      .setName("Status")
      .setDesc(this.controller.getStatusText());

    this.textSetting("Device name", settings.deviceName, async (value) => {
      settings.deviceName = value.trim() || "My device";
      await this.controller.saveSettings();
    });
    this.textSetting("AWS region", settings.region, async (value) => {
      settings.region = value.trim();
      await this.controller.saveSettings();
    });
    this.textSetting("S3 bucket", settings.bucket, async (value) => {
      settings.bucket = value.trim();
      await this.controller.saveSettings();
    });
    this.textSetting("S3 prefix", settings.prefix, async (value) => {
      settings.prefix = value.trim();
      await this.controller.saveSettings();
    });
    this.textSetting(
      "Remotely Save prefix (migration only)",
      settings.remotelySavePrefix,
      async (value) => {
        settings.remotelySavePrefix = value.trim();
        await this.controller.saveSettings();
      },
    );
    new Setting(containerEl)
      .setName("Remotely Save is disabled")
      .setDesc(
        "Required before migration so the old plugin cannot write to its prefix during cutover.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(settings.confirmedRemotelySaveDisabled)
          .onChange(async (value) => {
            settings.confirmedRemotelySaveDisabled = value;
            await this.controller.saveSettings();
          }),
      );

    let accessKeyId = "";
    let secretAccessKey = "";
    new Setting(containerEl)
      .setName("AWS credentials")
      .setDesc("Stored only in Obsidian SecretStorage for this Vault.")
      .addText((text) =>
        text
          .setPlaceholder("Access Key ID")
          .onChange((value) => {
            accessKeyId = value.trim();
          }),
      )
      .addText((text) =>
        asPasswordInput(text)
          .setPlaceholder("Secret Access Key")
          .onChange((value) => {
            secretAccessKey = value;
          }),
      )
      .addButton((button) =>
        button.setButtonText("Save credentials").onClick(async () => {
          await this.controller.saveAwsCredentials({
            accessKeyId,
            secretAccessKey,
          });
        }),
      );

    let password = "";
    let initializationRunning = false;
    let initializeButton: ButtonComponent | undefined;
    let renderStatus = (): void => {};
    const passwordDescription =
      "Creates a new encrypted remote Vault or unlocks an existing one.";
    const passwordSetting = new Setting(containerEl)
      .setName("Vault password")
      .setDesc(passwordDescription)
      .addText((text) =>
        asPasswordInput(text).onChange((value) => {
          password = value;
        }),
      )
      .addButton((button) => {
        initializeButton = button;
        button.setButtonText("Initialize or unlock").onClick(async () => {
          initializationRunning = true;
          button.setDisabled(true);
          renderStatus();
          try {
            await this.controller.initializeOrUnlock(password);
          } finally {
            initializationRunning = false;
            password = "";
            this.display();
          }
        });
      });

    new Setting(containerEl)
      .setName("Pause automatic sync")
      .setDesc("Local file changes remain in the Vault until sync resumes.")
      .addToggle((toggle) =>
        toggle.setValue(settings.paused).onChange(async (value) => {
          settings.paused = value;
          await this.controller.saveSettings();
        }),
      );

    const syncDescription =
      "Checks the encrypted remote Head and reconciles this device.";
    let manualSyncRunning = false;
    let syncButton: ButtonComponent | undefined;
    const syncSetting = new Setting(containerEl)
      .setName("Sync now")
      .setDesc(syncDescription)
      .addButton((button) => {
        syncButton = button;
        button.setButtonText("Sync now").onClick(async () => {
          manualSyncRunning = true;
          button.setDisabled(true);
          renderStatus();
          try {
            await this.controller.syncNow();
          } finally {
            manualSyncRunning = false;
            this.display();
          }
        });
      });

    renderStatus = (): void => {
      const status = this.controller.getStatusText();
      const progressLabel = this.controller.getProgressLabel();
      statusSetting.setDesc(status);
      if (initializationRunning && initializeButton) {
        passwordSetting.setDesc(status);
        initializeButton.setButtonText(progressLabel ?? "Initializing…");
      }
      if (manualSyncRunning && syncButton) {
        syncSetting.setDesc(status);
        syncButton.setButtonText(progressLabel ?? "Syncing…");
      }
    };
    this.stopStatusUpdates = this.controller.onStatusChange(renderStatus);
  }

  hide(): void {
    this.stopStatusUpdates?.();
    this.stopStatusUpdates = undefined;
    super.hide();
  }

  private textSetting(
    name: string,
    value: string,
    onChange: (value: string) => Promise<void>,
  ): void {
    new Setting(this.containerEl).setName(name).addText((text) =>
      text.setValue(value).onChange((updated) => {
        void onChange(updated);
      }),
    );
  }
}
