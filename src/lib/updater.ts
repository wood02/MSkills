import { getBundleType, getVersion } from "@tauri-apps/api/app";

export type UpdateChannel = "stable" | "beta";

export interface UpdateInfo {
  currentVersion: string;
  availableVersion: string;
  notes?: string;
  pubDate?: string;
  manualInstall: boolean;
}

export interface CheckOptions {
  timeout?: number;
  channel?: UpdateChannel;
}

export async function getCurrentVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "";
  }
}

export async function checkForUpdate(
  opts: CheckOptions = {},
): Promise<
  { status: "up-to-date" } | { status: "available"; info: UpdateInfo }
> {
  // 动态引入，避免在未安装插件时导致打包期问题
  const { check } = await import("@tauri-apps/plugin-updater");

  const update = await check({ timeout: opts.timeout ?? 30000 });

  if (!update) {
    return { status: "up-to-date" };
  }

  try {
    const bundleType = await getBundleType().catch(() => null);
    return {
      status: "available",
      info: {
        currentVersion: update.currentVersion,
        availableVersion: update.version,
        notes: update.body,
        pubDate: update.date,
        manualInstall: !["app", "msi", "appimage"].includes(bundleType ?? ""),
      },
    };
  } finally {
    await update.close();
  }
}
