import os from 'os';
import path from 'path';

export const app = {
  getAppPath() {
    return process.cwd();
  },
  getPath(name: string) {
    if (name === 'userData') {
      return process.env.ANTIGRAVITY_MANAGER_USER_DATA_DIR || path.join(os.homedir(), '.antigravity-agent');
    }
    return os.homedir();
  },
};

export const safeStorage = {
  isEncryptionAvailable() {
    return false;
  },
  encryptString(value: string) {
    return Buffer.from(value, 'utf-8');
  },
  decryptString(value: Buffer) {
    return value.toString('utf-8');
  },
};

export default {
  app,
  safeStorage,
};
