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
  deviceName: "我的设备",
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
  openStatus(): void;
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
    button.setButtonText("显示").onClick(() => {
      const showing = component.inputEl.type === "text";
      component.inputEl.type = showing ? "password" : "text";
      button.setButtonText(showing ? "显示" : "隐藏");
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
      .setName("状态")
      .setDesc(this.controller.getStatusText())
      .addButton(button => button.setButtonText("打开同步状态").onClick(() => this.controller.openStatus()));

    this.textSetting("设备名称", settings.deviceName, async (value) => {
      settings.deviceName = value.trim() || "我的设备";
      await this.controller.saveSettings();
    });
    this.textSetting("AWS 区域", settings.region, async (value) => {
      settings.region = value.trim();
      await this.controller.saveSettings();
    });
    this.textSetting("S3 存储桶", settings.bucket, async (value) => {
      settings.bucket = value.trim();
      await this.controller.saveSettings();
    });
    this.textSetting("S3 前缀", settings.prefix, async (value) => {
      settings.prefix = value.trim();
      await this.controller.saveSettings();
    });
    this.textSetting(
      "Remotely Save 前缀（仅迁移时使用）",
      settings.remotelySavePrefix,
      async (value) => {
        settings.remotelySavePrefix = value.trim();
        await this.controller.saveSettings();
      },
    );
    new Setting(containerEl)
      .setName("已停用 Remotely Save")
      .setDesc(
        "迁移前必须确认，避免切换期间旧插件继续往它的前缀里写入。",
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
      ? "凭证已保存在本设备的 Obsidian SecretStorage 中。两栏都填写即可替换。"
      : "只保存在本设备的 Obsidian SecretStorage 中。";
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
      .setName("保存 AWS 凭证")
      .setDesc("保存或替换凭证时两项都必须填写。")
      .addButton((button) => {
        saveCredentialsButton = button;
        button
          .setButtonText("保存凭证")
          .setDisabled(true)
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await this.controller.saveAwsCredentials({accessKeyId, secretAccessKey});
              accessKeyId = "";
              secretAccessKey = "";
              this.display();
            } catch (error) {
              accessKeySetting.setDesc(error instanceof Error ? error.message : "保存失败。请重试，或打开同步状态查看。");
              updateCredentialButton();
            }
          });
      });

    let password = "";
    let initializationRunning = false;
    let initializeButton: ButtonComponent | undefined;
    let renderStatus = (): void => {};
    const vaultUnlocked = this.controller.isVaultUnlocked();
    const passwordDescription = vaultUnlocked
      ? "本设备已解锁。密码不会被保存；仓库密钥保存在 Obsidian SecretStorage 中。"
      : "密码不会被保存。解锁成功后，仓库密钥会保存在 Obsidian SecretStorage 中。";
    const passwordSetting = new Setting(containerEl)
      .setName("仓库密码")
      .setDesc(passwordDescription);
    passwordSetting.settingEl.addClass("s3-vault-sync-secret-setting");
    passwordSetting.addText((text) => {
      asPasswordInput(text).onChange((value) => {
        password = value;
        initializeButton?.setDisabled(!password || initializationRunning);
        initializeButton?.setButtonText(
          vaultUnlocked ? "重新解锁" : "初始化或解锁",
        );
      });
      addVisibilityButton(passwordSetting, text);
    });

    const encryptionSetting = new Setting(containerEl)
      .setName("仓库加密")
      .setDesc(
        vaultUnlocked
          ? "除非清空本设备的 Obsidian SecretStorage，否则重启后本设备仍保持解锁。"
          : "新建一个加密的远端仓库，或解锁已有的远端仓库。",
      )
      .addButton((button) => {
        initializeButton = button;
        button
          .setButtonText(vaultUnlocked ? "重新解锁" : "初始化或解锁")
          .setDisabled(true)
          .onClick(async () => {
            initializationRunning = true;
            button.setDisabled(true);
            renderStatus();
            try {
              await this.controller.initializeOrUnlock(password);
              password = "";
              this.display();
            } catch (error) {
              encryptionSetting.setDesc(error instanceof Error ? error.message : "解锁失败。请重试，或打开同步状态查看。");
              button.setButtonText(vaultUnlocked ? "重新解锁" : "初始化或解锁");
              button.setDisabled(!password);
            } finally {
              initializationRunning = false;
            }
          });
      });

    new Setting(containerEl)
      .setName("暂停自动同步")
      .setDesc("暂停期间本地改动留在仓库里，恢复同步后再上传。")
      .addToggle((toggle) =>
        toggle.setValue(settings.paused).onChange(async (value) => {
          if (value !== settings.paused) await this.controller.togglePause();
        }),
      );

    new Setting(containerEl)
      .setName("完整校验间隔")
      .setDesc(
        "自动同步只检查有变化的文件。这个间隔决定多久把所有可同步文件完整读一遍并计算哈希。",
      )
      .addDropdown((dropdown) => {
        for (const days of SUPPORTED_FULL_HASH_VERIFICATION_INTERVAL_DAYS) {
          dropdown.addOption(
            String(days),
            days === 1 ? "每天" : `每 ${days} 天`,
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
      "检查加密的远端 Head 指针，并让本设备与之对齐。";
    let manualSyncRunning = false;
    let fullVerificationRunning = false;
    let syncButton: ButtonComponent | undefined;
    const syncSetting = new Setting(containerEl)
      .setName("立即同步")
      .setDesc(syncDescription)
      .addButton((button) => {
        syncButton = button;
        button.setButtonText("立即同步").onClick(async () => {
          manualSyncRunning = true;
          renderStatus();
          try {
            await this.controller.syncNow();
          } catch (error) {
            statusSetting.setDesc(error instanceof Error ? error.message : "同步失败。请打开同步状态查看。");
          } finally {
            manualSyncRunning = false;
            this.display();
          }
        });
      });

    let fullVerificationButton: ButtonComponent | undefined;
    const fullVerificationSetting = new Setting(containerEl)
      .setName("完整校验")
      .setDesc(
        "把所有可同步文件完整读一遍并计算哈希。仓库很大时可能要很久。",
      )
      .addButton((button) => {
        fullVerificationButton = button;
        button.setButtonText("校验全部文件").onClick(async () => {
          fullVerificationRunning = true;
          renderStatus();
          try {
            await this.controller.verifyAllFiles();
          } catch (error) {
            statusSetting.setDesc(error instanceof Error ? error.message : "校验失败。请打开同步状态查看。");
          } finally {
            fullVerificationRunning = false;
            this.display();
          }
        });
      });

    // 清理改在同步状态窗口里手动确认，这里只留一行说明
    new Setting(containerEl)
      .setName("清理过期内容")
      .setDesc("在同步状态窗口的按钮栏里点「待清理」，勾选后手动删除。只在电脑上。");

    renderStatus = (): void => {
      const status = this.controller.getStatusText();
      const progressLabel = this.controller.getProgressLabel();
      statusSetting.setDesc(status);
      if (initializationRunning && initializeButton) {
        encryptionSetting.setDesc(status);
        initializeButton.setButtonText(progressLabel ?? "正在初始化…");
      }
      if (manualSyncRunning && syncButton) {
        syncSetting.setDesc(status);
        syncButton.setButtonText(progressLabel ?? "正在同步…");
      }
      if (fullVerificationRunning && fullVerificationButton) {
        fullVerificationSetting.setDesc(status);
        fullVerificationButton.setButtonText(
          progressLabel ?? "正在校验全部文件…",
        );
      }
      syncButton?.setDisabled(
        manualSyncRunning || fullVerificationRunning || settings.paused,
      );
      fullVerificationButton?.setDisabled(
        manualSyncRunning || fullVerificationRunning || settings.paused,
      );
    };
    this.stopStatusUpdates = this.controller.onStatusChange(renderStatus);
    renderStatus();
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
