export const actionButton = (
  container: HTMLElement,
  text: string,
  action: () => Promise<void>,
): HTMLButtonElement => {
  const button = container.createEl("button", {text});
  let errorMessage: HTMLElement | undefined;
  button.addEventListener("click", () => {
    if (button.disabled) return;
    button.disabled = true;
    errorMessage?.setText("");
    void action().catch((error: unknown) => {
      errorMessage ??= container.createEl("p", {cls: "s3-vault-sync-error"});
      errorMessage.setText(`${error instanceof Error ? error.message : "Operation failed"} Correct the cause and retry, or sync again to refresh the available actions.`);
    }).finally(() => { button.disabled = false; });
  });
  return button;
};
