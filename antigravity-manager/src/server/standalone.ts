import 'reflect-metadata';
import { bootstrapNestServer, stopNestServer } from './main';
import { DEFAULT_APP_CONFIG, type ProxyConfig } from '@/modules/config/types';

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const port = numberFromEnv('ANTIGRAVITY_MANAGER_PORT', numberFromEnv('PORT', 8045));

const config: ProxyConfig = {
  ...DEFAULT_APP_CONFIG.proxy,
  enabled: true,
  auto_start: true,
  port,
  api_key: process.env.ANTIGRAVITY_MANAGER_API_KEY?.trim() ?? '',
  request_timeout: numberFromEnv('ANTIGRAVITY_MANAGER_REQUEST_TIMEOUT', 300),
  upstream_proxy: {
    enabled: Boolean(process.env.ANTIGRAVITY_MANAGER_UPSTREAM_PROXY_URL?.trim()),
    url: process.env.ANTIGRAVITY_MANAGER_UPSTREAM_PROXY_URL?.trim() ?? '',
  },
};

async function main() {
  const result = await bootstrapNestServer(config);
  if (!result.success) {
    console.error(result.message);
    process.exit(1);
  }
}

async function shutdown() {
  await stopNestServer();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});

void main();
