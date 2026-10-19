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
      togglePause: async () => {}, verifyAllFiles: async () => {},
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

  it("points to the status window instead of offering a preview, a confirmation or a switch", () => {
    const controller: SettingsController = {
      openStatus: () => {}, initializeOrUnlock: async () => {}, getProgressLabel: () => undefined,
      getSettings: () => ({ ...DEFAULT_SETTINGS, vaultId: "vault-id" }), getStatusText: () => "空闲",
      hasAwsCredentials: () => true, isVaultUnlocked: () => true, onStatusChange: () => () => {},
      saveAwsCredentials: async () => {}, saveSettings: async () => {}, syncNow: async () => {},
      togglePause: async () => {}, verifyAllFiles: async () => {},
    };
    new S3VaultSyncSettingsTab({} as App, controller as never).display();

    const names = mocks.Setting.instances.map((setting) => setting.name);
    expect(names).not.toContain("预览过期内容");
    expect(names).not.toContain("启用清理过期内容");
    expect(names.some((name) => name.includes("所有设备都已更新"))).toBe(false);
    const line = findSetting("清理过期内容");
    expect(line.description).toBe("在同步状态窗口的按钮栏里点「待清理」，勾选后手动删除。只在电脑上。");
    expect(line.buttons).toEqual([]);
    expect(line.toggles).toEqual([]);
  });
});
