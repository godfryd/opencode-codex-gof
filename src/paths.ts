import os from "node:os"
import path from "node:path"

export function dataDir(): string {
  const env = process.env.OPENCODE_DATA_DIR
  if (env) return path.join(env, "codex")
  if (process.platform === "darwin" || process.platform === "linux") {
    const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
    return path.join(xdg, "opencode", "codex")
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    return path.join(base, "opencode", "codex")
  }
  return path.join(os.homedir(), ".opencode", "codex")
}

export function accountsFile(): string {
  return path.join(dataDir(), "accounts.json")
}
