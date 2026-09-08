/**
 * Gateway IPC Handlers
 * Provides ORPC handlers for controlling the API Gateway service (NestJS version)
 */
import {
  bootstrapNestServer,
  stopNestServer,
  getNestServerStatus,
  type NestServerStartResult,
} from '@/server/main';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '@/shared/logging/logger';

/**
 * Start the gateway server (NestJS)
 */
export const startGateway = async (port: number): Promise<NestServerStartResult> => {
  try {
    // Stop if already running
    await stopNestServer();

    // Load full config and start NestJS server
    const config = ConfigManager.loadConfig();
    const proxyConfig = { ...config.proxy, port };

    return await bootstrapNestServer(proxyConfig);
  } catch (e) {
    logger.error('Failed to start gateway:', e);
    return {
      success: false,
      reason: 'unknown',
      port,
      message: e instanceof Error ? e.message : 'Failed to start gateway',
    };
  }
};

/**
 * Stop the gateway server (NestJS)
 */
export const stopGateway = async (): Promise<boolean> => {
  try {
    return await stopNestServer();
  } catch (e) {
    logger.error('Failed to stop gateway:', e);
    return false;
  }
};

/**
 * Get gateway status (NestJS)
 */
export const getGatewayStatus = async () => {
  return getNestServerStatus();
};

/**
 * Generate a new API key
 */
export const generateApiKey = async (): Promise<string> => {
  const newKey = `sk-${uuidv4().replace(/-/g, '')}`;

  // Save to config
  const config = ConfigManager.loadConfig();
  config.proxy.api_key = newKey;
  await ConfigManager.saveConfig(config);

  return newKey;
};
