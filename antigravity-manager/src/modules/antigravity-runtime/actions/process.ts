import { ipc } from '@/ipc/manager';
import type { AntigravityAppTarget } from '@/modules/account/types';

export function isProcessRunning(target?: AntigravityAppTarget) {
  return ipc.client.proc.isProcessRunning({ target });
}

export function closeAntigravity(target?: AntigravityAppTarget) {
  return ipc.client.proc.closeAntigravity({ target });
}

export function startAntigravity(target?: AntigravityAppTarget) {
  return ipc.client.proc.startAntigravity({ target });
}
