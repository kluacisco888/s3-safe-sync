import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";

const mocks = vi.hoisted(() => {
  class Element {
    classes = new Set<string>();
    children: Element[] = [];
    text = "";
    empty() { this.children = []; }
    addClass(value: string) { this.classes.add(value); }
    createEl(_tag: string, options: { text?: string } = {}) {
      const child = new Element();
      child.text = options.text ?? "";
      this.children.push(child);
      return child;
    }
    createDiv() {
      const child = new Element();
      this.children.push(child);
      return child;
    }
    allText(): string[] { return [this.text, ...this.children.flatMap((child) => child.allText())].filter(Boolean); }
  }

  class TextComponent {
    inputEl = { type: "text" };
    placeholder = "";
    value = "";
    private change: (value: string) => void = () => {};
    setPlaceholder(value: string) { this.placeholder = value; return this; }
    setValue(value: string) { this.value = value; return this; }
    onChange(callback: (value: string) => void) { this.change = callback; return this; }
    trigger(value: string) { this.value = value; this.change(value); }
  }

  class ButtonComponent {
    buttonText = "";
    disabled = false;
    private clickHandler: () => void | Promise<void> = () => {};
    setButtonText(value: string) { this.buttonText = value; return this; }
    setDisabled(value: boolean) { this.disabled = value; return this; }
    onClick(callback: () => void | Promise<void>) { this.clickHandler = callback; return this; }
    async click() { await this.clickHandler(); }
  }

  class ToggleComponent {
    value = false;
    disabled = false;
    private change: (value: boolean) => unknown = () => {};
    setValue(value: boolean) { this.value = value; return this; }
    setDisabled(value: boolean) { this.disabled = value; return this; }
    onChange(callback: (value: boolean) => unknown) { this.change = callback; return this; }
    async trigger(value: boolean) { this.value = value; await this.change(value); }
  }

  class DropdownComponent {
    addOption() { return this; }
    setValue() { return this; }
    onChange() { return this; }
  }

  class Setting {
    static instances: Setting[] = [];
    name = "";
    description = "";
    readonly settingEl = new Element();
    readonly texts: TextComponent[] = [];
    readonly buttons: ButtonComponent[] = [];
    readonly toggles: ToggleComponent[] = [];
    constructor(_container: Element) { Setting.instances.push(this); }
    setName(value: string) { this.name = value; return this; }
    setDesc(value: string) { this.description = value; return this; }
    addText(callback: (component: TextComponent) => void) {
      const component = new TextComponent();
      this.texts.push(component);
      callback(component);
      return this;
    }
    addButton(callback: (component: ButtonComponent) => void) {
      const component = new ButtonComponent();
      this.buttons.push(component);
      callback(component);
      return this;
    }
    addToggle(callback: (component: ToggleComponent) => void) {
      const component = new ToggleComponent();
      this.toggles.push(component);
      callback(component);
      return this;
    }
    addDropdown(callback: (component: DropdownComponent) => void) {
      callback(new DropdownComponent());
      return this;
    }
  }

  return { ButtonComponent, Element, Setting, TextComponent };
});

vi.mock("obsidian", () => ({
  App: class {},
  Plugin: class {},
  PluginSettingTab: class {
    containerEl = new mocks.Element();
    constructor(_app: unknown, _plugin: unknown) {}
    hide() {}
  },
  Setting: mocks.Setting,
}));

import {
  DEFAULT_SETTINGS,
  S3VaultSyncSettingsTab,
  type SettingsController,
} from "../src/plugin/settings";

// 与清理过期内容无关的用例：这一节不显示
const withoutCleanup = {
  getPluginVersion: () => "0.1.9",
  isExpiredContentCleanupAvailable: () => false,
  isExpiredContentCleanupEnabled: () => false,
  previewExpiredContentCleanup: async () => { throw new Error("unexpected preview"); },
  setExpiredContentCleanupEnabled: async () => { throw new Error("unexpected toggle"); },
};

const findSetting = (name: string): InstanceType<typeof mocks.Setting> => {
  const setting = mocks.Setting.instances.find((candidate) => candidate.name === name);
  if (!setting) throw new Error(`Missing setting ${name}`);
  return setting;
};

describe("S3VaultSyncSettingsTab mobile credentials", () => {
  beforeEach(() => {
    mocks.Setting.instances = [];
  });

  it("gives each secret a separate revealable field and clearly reports a persisted unlock", async () => {
    const saveAwsCredentials = vi.fn(async () => {});
    const controller: SettingsController = {
      openStatus: () => {},
      getProgressLabel: () => undefined,
      getSettings: () => ({ ...DEFAULT_SETTINGS, vaultId: "vault-id" }),
      getStatusText: () => "空闲：Ready to sync.",
      hasAwsCredentials: () => true,
      initializeOrUnlock: async () => {},
      isVaultUnlocked: () => true,
      onStatusChange: () => () => {},
      saveAwsCredentials,
      saveSettings: async () => {},
      syncNow: async () => {},
      togglePause: async () => {},
      verifyAllFiles: async () => {},
      ...withoutCleanup,
    };
    const tab = new S3VaultSyncSettingsTab({} as App, controller as never);

    tab.display();

    const accessKey = findSetting("Access Key ID");
    const secretKey = findSetting("Secret Access Key");
    expect(accessKey.texts).toHaveLength(1);
    expect(secretKey.texts).toHaveLength(1);
    expect(accessKey.texts[0]?.inputEl.type).toBe("password");
    expect(secretKey.texts[0]?.inputEl.type).toBe("password");
    expect(accessKey.settingEl.classes.has("s3-vault-sync-secret-setting")).toBe(true);
    expect(secretKey.settingEl.classes.has("s3-vault-sync-secret-setting")).toBe(true);
    expect(accessKey.buttons[0]?.buttonText).toBe("显示");
    expect(secretKey.buttons[0]?.buttonText).toBe("显示");

    await accessKey.buttons[0]?.click();
    expect(accessKey.texts[0]?.inputEl.type).toBe("text");
    expect(accessKey.buttons[0]?.buttonText).toBe("隐藏");

    const vaultPassword = findSetting("仓库密码");
    expect(vaultPassword.description).toContain("本设备已解锁");
    expect(vaultPassword.description).toContain("密码不会被保存");
    expect(vaultPassword.buttons[0]?.buttonText).toBe("显示");
    const vaultEncryption = findSetting("仓库加密");
    expect(vaultEncryption.buttons[0]?.disabled).toBe(true);
    vaultPassword.texts[0]?.trigger("vault-password");
    expect(vaultEncryption.buttons[0]?.disabled).toBe(false);
    expect(vaultEncryption.buttons[0]?.buttonText).toBe("重新解锁");

    const save = findSetting("保存 AWS 凭证").buttons[0];
    expect(save?.disabled).toBe(true);
    accessKey.texts[0]?.trigger("AKIAEXAMPLE");
    secretKey.texts[0]?.trigger("secret-example");
    expect(save?.disabled).toBe(false);
    await save?.click();
    expect(saveAwsCredentials).toHaveBeenCalledWith({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secret-example",
    });
  });

  it("keeps a failed unlock retryable and provides a status entry point", async () => {
    const openStatus = vi.fn();
    const initializeOrUnlock = vi.fn().mockRejectedValueOnce(new Error("Connection closed")).mockResolvedValueOnce(undefined);
    const controller: SettingsController = {
      openStatus, initializeOrUnlock, getProgressLabel: () => undefined,
      getSettings: () => ({...DEFAULT_SETTINGS}), getStatusText: () => "Not configured",
      hasAwsCredentials: () => true, isVaultUnlocked: () => false, onStatusChange: () => () => {},
      saveAwsCredentials: async () => {}, saveSettings: async () => {}, syncNow: async () => {},
      togglePause: async () => {}, verifyAllFiles: async () => {}, ...withoutCleanup,
    };
    const tab = new S3VaultSyncSettingsTab({} as App, controller as never);
    tab.display();
    await findSetting("状态").buttons[0]!.click();
    expect(openStatus).toHaveBeenCalledOnce();
    const password = findSetting("仓库密码").texts[0]!;
    password.trigger("typed-password");
    const encryption = findSetting("仓库加密");
    const button = encryption.buttons[0]!;
    await button.click();
    expect(encryption.description).toBe("Connection closed");
    expect(password.value).toBe("typed-password");
    expect(button.disabled).toBe(false);
    await button.click();
    expect(initializeOrUnlock).toHaveBeenNthCalledWith(2, "typed-password");
  });
});

describe("S3VaultSyncSettingsTab expired content cleanup", () => {
  beforeEach(() => {
    mocks.Setting.instances = [];
  });

  const preview = {
    missingExpiry: [{ kind: "history" as const, path: "notes/undated.md" }],
    removedHistory: 7,
    removedRecoveries: [
      { deletedAt: "2026-08-01T10:00:00.000Z", path: "notes/older.md" },
      { deletedAt: "2026-08-20T10:00:00.000Z", path: "notes/newer.md" },
    ],
    serverDate: "2026-10-18T10:00:00.000Z",
  };

  const controllerWith = (overrides: Partial<SettingsController> = {}) => {
    const controller = {
      openStatus: () => {}, initializeOrUnlock: async () => {}, getProgressLabel: () => undefined,
      getSettings: () => ({ ...DEFAULT_SETTINGS, vaultId: "vault-id" }), getStatusText: () => "空闲",
      hasAwsCredentials: () => true, isVaultUnlocked: () => true, onStatusChange: () => () => {},
      saveAwsCredentials: async () => {}, saveSettings: async () => {}, syncNow: async () => {},
      togglePause: async () => {}, verifyAllFiles: async () => {},
      getPluginVersion: () => "0.2.0",
      isExpiredContentCleanupAvailable: () => true,
      isExpiredContentCleanupEnabled: () => false,
      previewExpiredContentCleanup: vi.fn(async () => preview),
      setExpiredContentCleanupEnabled: vi.fn(async () => {}),
      ...overrides,
    } satisfies SettingsController;
    const tab = new S3VaultSyncSettingsTab({} as App, controller as never);
    tab.display();
    return { controller, tab };
  };

  it("does not show the cleanup section on a phone", () => {
    const { controller } = controllerWith({ isExpiredContentCleanupAvailable: () => false });
    expect(mocks.Setting.instances.some((setting) => setting.name.includes("清理过期内容"))).toBe(false);
    expect(controller.previewExpiredContentCleanup).not.toHaveBeenCalled();
  });

  it("keeps the switch off and locked until the preview is seen and every device is confirmed updated", async () => {
    const { controller, tab } = controllerWith();
    const enable = findSetting("启用清理过期内容").toggles[0]!;
    const confirm = findSetting("所有设备都已更新到 0.2.0 或更高");
    expect(confirm.description).toContain("没升级的设备在清理后可能卡在修复模式");
    expect(enable.value).toBe(false);
    expect(enable.disabled).toBe(true);

    await confirm.toggles[0]!.trigger(true);
    // 只勾选、没看过预览：仍不能打开
    expect(enable.disabled).toBe(true);

    await findSetting("预览过期内容").buttons[0]!.click();
    expect(enable.disabled).toBe(false);
    const listed = (tab.containerEl as unknown as InstanceType<typeof mocks.Element>).allText();
    // 按删除日期排序，带本地日期
    expect(listed.findIndex((line) => line.startsWith("notes/older.md"))).toBeLessThan(
      listed.findIndex((line) => line.startsWith("notes/newer.md")));
    expect(listed.some((line) => line.startsWith("notes/older.md（删除于 2026-08-0"))).toBe(true);
    expect(listed.some((line) => line.startsWith("notes/undated.md"))).toBe(true);
    expect(findSetting("预览过期内容").description).toContain("2 个已删除文件的恢复副本");
    expect(findSetting("预览过期内容").description).toContain("7 个过期旧版本");
    expect(findSetting("预览过期内容").description).toContain("1 项缺到期时间");

    await enable.trigger(true);
    expect(controller.setExpiredContentCleanupEnabled).toHaveBeenCalledWith(true, true);
  });

  it("does not unlock the switch when the confirmation is withdrawn after the preview", async () => {
    controllerWith();
    const enable = findSetting("启用清理过期内容").toggles[0]!;
    const confirm = findSetting("所有设备都已更新到 0.2.0 或更高").toggles[0]!;
    await findSetting("预览过期内容").buttons[0]!.click();
    await confirm.trigger(true);
    expect(enable.disabled).toBe(false);
    await confirm.trigger(false);
    expect(enable.disabled).toBe(true);
  });

  it("lets an enabled cleanup be turned off without another preview", async () => {
    const { controller } = controllerWith({ isExpiredContentCleanupEnabled: () => true });
    const enable = findSetting("启用清理过期内容").toggles[0]!;
    expect(enable.value).toBe(true);
    expect(enable.disabled).toBe(false);
    await enable.trigger(false);
    expect(controller.setExpiredContentCleanupEnabled).toHaveBeenCalledWith(false, false);
  });
});
