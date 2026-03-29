import { Notice } from "obsidian";

const PREFIX = "Team Vault:";

export function notifyInfo(message: string, timeout = 4000): void {
  new Notice(`${PREFIX} ${message}`, timeout);
}

export function notifyError(message: string, timeout = 8000): void {
  new Notice(`${PREFIX} Error — ${message}`, timeout);
}

export function notifySuccess(message: string, timeout = 4000): void {
  new Notice(`${PREFIX} ${message}`, timeout);
}
