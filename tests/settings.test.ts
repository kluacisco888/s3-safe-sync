import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";

const mocks = vi.hoisted(() => {
  class Element {
    classes = new Set<string>();
    empty() {}
    addClass(value: string) { this.classes.add(value); }
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
    setValue() { return this; }
    onChange() { return this; }
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
      callback(new ToggleComponent());
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
      getProgressLabel: () => undefined,
      getSettings: () => ({ ...DEFAULT_SETTINGS, vaultId: "vault-id" }),
      getStatusText: () => "Idle: Ready to sync.",
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
    expect(accessKey.buttons[0]?.buttonText).toBe("Show");
    expect(secretKey.buttons[0]?.buttonText).toBe("Show");

    await accessKey.buttons[0]?.click();
    expect(accessKey.texts[0]?.inputEl.type).toBe("text");
    expect(accessKey.buttons[0]?.buttonText).toBe("Hide");

    const vaultPassword = findSetting("Vault password");
    expect(vaultPassword.description).toContain("Unlocked on this device");
    expect(vaultPassword.description).toContain("password is not stored");
    expect(vaultPassword.buttons[0]?.buttonText).toBe("Show");
    const vaultEncryption = findSetting("Vault encryption");
    expect(vaultEncryption.buttons[0]?.disabled).toBe(true);
    vaultPassword.texts[0]?.trigger("vault-password");
    expect(vaultEncryption.buttons[0]?.disabled).toBe(false);
    expect(vaultEncryption.buttons[0]?.buttonText).toBe("Unlock again");

    const save = findSetting("Save AWS credentials").buttons[0];
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
});
