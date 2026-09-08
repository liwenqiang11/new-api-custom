import { app } from 'electron';
import * as Sentry from '@sentry/electron/main';
import path from 'path';
import fs from 'fs';
import { getAgentDir } from './shared/platform/paths';
import { logger } from './shared/logging/logger';
import {
  initializeOpenTelemetry,
  shutdownOpenTelemetry,
} from './shared/observability/openTelemetry';

function getQuickConfig() {
  try {
    const configPath = path.join(getAgentDir(), 'gui_config.json');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content);
      return {
        errorReportingEnabled: config.error_reporting_enabled !== false,
        telemetryEnabled: config.telemetry_enabled !== false,
      };
    }
  } catch (e) {
    logger.error('Failed to read config for observability init:', e);
  }
  return {
    errorReportingEnabled: true,
    telemetryEnabled: true,
  };
}

const quickConfig = getQuickConfig();

initializeOpenTelemetry({
  enabled: quickConfig.telemetryEnabled,
  serviceVersion: app.getVersion(),
});

app.on('before-quit', () => {
  shutdownOpenTelemetry().catch((error) => {
    logger.warn('Failed to flush OpenTelemetry before quit', error);
  });
});

if (quickConfig.errorReportingEnabled) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: `antigravity-manager@${app.getVersion()}`,
    beforeSend(event) {
      if (event.exception?.values?.[0]?.value) {
        event.exception.values[0].value = event.exception.values[0].value.replace(
          /Users\\\\[^\\\\]+/g,
          'Users\\\\***',
        );
      }
      return event;
    },
  });
  logger.setErrorReportingEnabled(true);
  logger.setSentryReporter((payload) => {
    Sentry.withScope((scope) => {
      scope.setTag('log_level', payload.level);
      scope.setContext('recent_logs', {
        entries: payload.logs.map((entry) => ({
          timestamp: new Date(entry.timestamp).toISOString(),
          level: entry.level,
          message: entry.message,
          formatted: entry.formatted,
        })),
      });
      scope.setExtra('log_message', payload.message);
      if (payload.error) {
        Sentry.captureException(payload.error);
        return;
      }
      Sentry.captureMessage(payload.message, 'error');
    });
  });
} else {
  logger.setErrorReportingEnabled(false);
  logger.setSentryReporter(null);
}
