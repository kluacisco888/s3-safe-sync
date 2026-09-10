import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  type ButtonComponent,
  type TextComponent,
} from "obsidian";

import type { AwsCredentials } from "./credential-store";
import {
  DEFAULT_FULL_HASH_VERIFICATION_INTERVAL_DAYS,
  SUPPORTED_FULL_HASH_VERIFICATION_INTERVAL_DAYS,
  normalizeFullHashVerificationIntervalDays,
} from "../sync/full-hash-verification-policy";

export interface S3VaultSyncSettings {
  bucket: string;
  confirmedRemotelySaveDisabled: boolean;
  deviceName: string;
  fullHashVerificationIntervalDays: number;
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
  fullHashVerificationIntervalDays:
    DEFAULT_FULL_HASH_VERIFICATION_INTERVAL_DAYS,
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
  hasAwsCredentials(): boolean;
  initializeOrUnlock(password: string): Promise<void>;
  isVaultUnlocked(): boolean;
  onStatusChange(
    listener: (status: SyncStatusDisplay) => void,
  ): () => void;
  saveAwsCredentials(credentials: AwsCredentials): Promise<void>;
  saveSettings(): Promise<void>;
  togglePause(): Promise<void>;
  syncNow(): Promise<void>;
  verifyAllFiles(): Promise<void>;
}

const asPasswordInput = (component: TextComponent): TextComponent => {
  component.inputEl.type = "password";
  component.inputEl.autocomplete = "off";
  component.inputEl.autocapitalize = "none";
  component.inputEl.spellcheck = false;
  return component;
};

const addVisibilityButton = (
  setting: Setting,
  component: TextComponent,
): void => {
  setting.addButton((button) =>
    button.setButtonText("Show").onClick(() => {
      const showing = component.inputEl.type === "text";
      component.inputEl.type = showing ? "password" : "text";
      button.setButtonText(showing ? "Show" : "Hide");
    }),
  );
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
    let saveCredentialsButton: ButtonComponent | undefined;
    const updateCredentialButton = (): void => {
      saveCredentialsButton?.setDisabled(!accessKeyId || !secretAccessKey);
    };
    const credentialDescription = this.controller.hasAwsCredentials()
      ? "Credentials are saved in Obsidian SecretStorage on this device. Enter both fields to replace them."
      : "Stored only in Obsidian SecretStorage on this device.";
    const accessKeySetting = new Setting(containerEl)
      .setName("Access Key ID")
      .setDesc(credentialDescription);
    accessKeySetting.settingEl.addClass("s3-vault-sync-secret-setting");
    accessKeySetting.addText((text) => {
      asPasswordInput(text)
        .setPlaceholder("Access Key ID")
        .onChange((value) => {
          accessKeyId = value.trim();
          updateCredentialButton();
        });
      addVisibilityButton(accessKeySetting, text);
    });

    const secretKeySetting = new Setting(containerEl)
      .setName("Secret Access Key");
    secretKeySetting.settingEl.addClass("s3-vault-sync-secret-setting");
    secretKeySetting.addText((text) => {
      asPasswordInput(text)
        .setPlaceholder("Secret Access Key")
        .onChange((value) => {
          secretAccessKey = value;
          updateCredentialButton();
        });
      addVisibilityButton(secretKeySetting, text);
    });

    new Setting(containerEl)
      .setName("Save AWS credentials")
      .setDesc("Both values are required when saving or replacing credentials.")
      .addButton((button) => {
        saveCredentialsButton = button;
        button
          .setButtonText("Save credentials")
          .setDisabled(true)
          .onClick(async () => {
            await this.controller.saveAwsCredentials({
              accessKeyId,
              secretAccessKey,
            });
            accessKeyId = "";
            secretAccessKey = "";
            this.display();
          });
      });

    let password = "";
    let initializationRunning = false;
    let initializeButton: ButtonComponent | undefined;
    let renderStatus = (): void => {};
    const vaultUnlocked = this.controller.isVaultUnlocked();
    const passwordDescription = vaultUnlocked
      ? "Unlocked on this device. The password is not stored; the Vault Key is kept in Obsidian SecretStorage."
      : "The password is not stored. After a successful unlock, the Vault Key is kept in Obsidian SecretStorage.";
    const passwordSetting = new Setting(containerEl)
      .setName("Vault password")
      .setDesc(passwordDescription);
    passwordSetting.settingEl.addClass("s3-vault-sync-secret-setting");
    passwordSetting.addText((text) => {
      asPasswordInput(text).onChange((value) => {
        password = value;
        initializeButton?.setDisabled(!password || initializationRunning);
        initializeButton?.setButtonText(
          vaultUnlocked ? "Unlock again" : "Initialize or unlock",
        );
      });
      addVisibilityButton(passwordSetting, text);
    });

    const encryptionSetting = new Setting(containerEl)
      .setName("Vault encryption")
      .setDesc(
        vaultUnlocked
          ? "This device remains unlocked across restarts unless its Obsidian SecretStorage is cleared."
          : "Creates a new encrypted remote Vault or unlocks an existing one.",
      )
      .addButton((button) => {
        initializeButton = button;
        button
          .setButtonText(vaultUnlocked ? "Unlock again" : "Initialize or unlock")
          .setDisabled(true)
          .onClick(async () => {
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
          if (value !== settings.paused) await this.controller.togglePause();
        }),
      );

    new Setting(containerEl)
      .setName("Full integrity check interval")
      .setDesc(
        "Automatic sync remains incremental. This interval controls how often every eligible file is read and hashed.",
      )
      .addDropdown((dropdown) => {
        for (const days of SUPPORTED_FULL_HASH_VERIFICATION_INTERVAL_DAYS) {
          dropdown.addOption(
            String(days),
            days === 1 ? "Every day" : `Every ${days} days`,
          );
        }
        return dropdown
          .setValue(
            String(
              normalizeFullHashVerificationIntervalDays(
                settings.fullHashVerificationIntervalDays,
              ),
            ),
          )
          .onChange(async (value) => {
            settings.fullHashVerificationIntervalDays =
              normalizeFullHashVerificationIntervalDays(Number(value));
            await this.controller.saveSettings();
          });
      });

    const syncDescription =
      "Checks the encrypted remote Head and reconciles this device.";
    let manualSyncRunning = false;
    let fullVerificationRunning = false;
    let syncButton: ButtonComponent | undefined;
    const syncSetting = new Setting(containerEl)
      .setName("Sync now")
      .setDesc(syncDescription)
      .addButton((button) => {
        syncButton = button;
        button.setButtonText("Sync now").onClick(async () => {
          manualSyncRunning = true;
          renderStatus();
          try {
            await this.controller.syncNow();
          } finally {
            manualSyncRunning = false;
            this.display();
          }
        });
      });

    let fullVerificationButton: ButtonComponent | undefined;
    const fullVerificationSetting = new Setting(containerEl)
      .setName("Full integrity check")
      .setDesc(
        "Reads and hashes every eligible file. This can take a long time for large Vaults.",
      )
      .addButton((button) => {
        fullVerificationButton = button;
        button.setButtonText("Check all files").onClick(async () => {
          fullVerificationRunning = true;
          renderStatus();
          try {
            await this.controller.verifyAllFiles();
          } finally {
            fullVerificationRunning = false;
            this.display();
          }
        });
      });

    renderStatus = (): void => {
      const status = this.controller.getStatusText();
      const progressLabel = this.controller.getProgressLabel();
      statusSetting.setDesc(status);
      if (initializationRunning && initializeButton) {
        encryptionSetting.setDesc(status);
        initializeButton.setButtonText(progressLabel ?? "Initializing…");
      }
      if (manualSyncRunning && syncButton) {
        syncSetting.setDesc(status);
        syncButton.setButtonText(progressLabel ?? "Syncing…");
      }
      if (fullVerificationRunning && fullVerificationButton) {
        fullVerificationSetting.setDesc(status);
        fullVerificationButton.setButtonText(
          progressLabel ?? "Checking all files…",
        );
      }
      syncButton?.setDisabled(
        manualSyncRunning || fullVerificationRunning,
      );
      fullVerificationButton?.setDisabled(
        manualSyncRunning || fullVerificationRunning,
      );
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
