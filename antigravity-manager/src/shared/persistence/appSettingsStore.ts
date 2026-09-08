import fs from 'fs';
import path from 'path';
import { getAgentDir } from '@/shared/platform/paths';
import { logger } from '@/shared/logging/logger';

const APP_SETTINGS_FILENAME = 'manager_app_settings.json';

type AppSettings = Record<string, unknown>;

function getAppSettingsPath(): string {
  const appSettingsDir = getAgentDir();
  if (!fs.existsSync(appSettingsDir)) {
    fs.mkdirSync(appSettingsDir, { recursive: true });
  }

  return path.join(appSettingsDir, APP_SETTINGS_FILENAME);
}

function readAppSettings(): AppSettings {
  const settingsPath = getAppSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AppSettings;
    }
  } catch (error) {
    logger.error('AppSettings: Failed to read app settings', error);
  }

  return {};
}

function writeAppSettings(settings: AppSettings): void {
  const settingsPath = getAppSettingsPath();
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (error) {
    logger.error('AppSettings: Failed to write app settings', error);
  }
}

export function getAppSetting<T>(key: string, fallback: T): T {
  const settings = readAppSettings();
  if (!(key in settings)) {
    return fallback;
  }

  return settings[key] as T;
}

export function setAppSetting(key: string, value: unknown): void {
  const settings = readAppSettings();
  settings[key] = value;
  writeAppSettings(settings);
}
