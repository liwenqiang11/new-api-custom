import { execSync } from 'child_process';
import path from 'path';

const WINDOWS_PROCESS_COMMAND_TIMEOUT_MS = 3000;

export interface WindowsProcessInfo {
  pid: number;
  name: string;
  executablePath: string;
  commandLine: string;
}

export function isSafeWindowsImageName(imageName: string): boolean {
  return /^[^"'&|<>]+\.exe$/i.test(imageName);
}

export function isWindowsImageRunning(imageName: string): boolean | null {
  try {
    const output = execSync(`tasklist /FI "IMAGENAME eq ${imageName}" /FO CSV /NH`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: WINDOWS_PROCESS_COMMAND_TIMEOUT_MS,
    });
    return output.toLowerCase().includes(imageName.toLowerCase());
  } catch {
    return null;
  }
}

export function killWindowsImageTree(imageName: string): boolean {
  try {
    execSync(`taskkill /F /T /IM "${imageName}"`, {
      stdio: 'ignore',
      timeout: WINDOWS_PROCESS_COMMAND_TIMEOUT_MS,
    });
    return true;
  } catch {
    return isWindowsImageRunning(imageName) === false;
  }
}

function parseCommandExecutableName(commandLine: string): string {
  const trimmed = commandLine.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('"')) {
    const closingQuoteIndex = trimmed.indexOf('"', 1);
    if (closingQuoteIndex > 1) {
      return path.win32.basename(trimmed.slice(1, closingQuoteIndex));
    }
  }

  const firstSpaceIndex = trimmed.search(/\s/);
  return path.win32.basename(firstSpaceIndex >= 0 ? trimmed.slice(0, firstSpaceIndex) : trimmed);
}

export function parseWmicProcessList(output: string): WindowsProcessInfo[] {
  const processes: WindowsProcessInfo[] = [];
  let commandLine = '';
  let executablePath = '';

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1);
    if (key === 'CommandLine') {
      commandLine = value;
      continue;
    }
    if (key === 'ExecutablePath') {
      executablePath = value;
      continue;
    }
    if (key === 'ProcessId') {
      const pid = Number(value);
      if (Number.isFinite(pid) && pid > 0) {
        processes.push({
          pid,
          name: path.win32.basename(executablePath || parseCommandExecutableName(commandLine)),
          executablePath,
          commandLine,
        });
      }
      commandLine = '';
      executablePath = '';
    }
  }

  return processes;
}

export function queryWindowsProcessesByImageName(imageName: string): WindowsProcessInfo[] | null {
  try {
    const output = execSync(
      `wmic process where "name='${imageName}'" get ProcessId,ExecutablePath,CommandLine /format:list`,
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: WINDOWS_PROCESS_COMMAND_TIMEOUT_MS,
      },
    );
    return parseWmicProcessList(output);
  } catch {
    return null;
  }
}
