import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import crypto from 'crypto';
import fs from 'fs';
import { isEmpty, isNumber, isString } from 'lodash-es';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccount, CloudQuotaData } from '@/modules/cloud-account/types';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { getServerConfig } from '../../../server/server-config';
import { RateLimitReason, RateLimitTracker } from './rate-limit-tracker';
import { updateDynamicForwardingRules } from '../antigravity/ModelMapping';
import { GeminiClient } from './clients/gemini.client';
import { GeminiInternalRequest } from '../antigravity/types';
import { resolveRequestUserAgent } from './request-user-agent';

interface TokenData {
  email: string;
  account_id: string;
  access_token: string;
  refresh_token: string;
  id_token?: string;
  oauth_client_key?: string;
  token_type: string;
  expires_in: number;
  expiry_timestamp: number;
  project_id?: string;
  session_id?: string;
  upstream_proxy_url?: string;
  quota?: CloudQuotaData;
  model_quotas: Record<string, number>;
  model_limits: Record<string, number>;
  model_reset_times: Record<string, string>;
  model_forwarding_rules: Record<string, string>;
  source_scope?: string;
}

export interface AccountInspectionResult {
  account_id: string;
  email: string;
  name?: string;
  avatar_url?: string;
  token_type: string;
  expiry_timestamp: number;
  oauth_client_key?: string;
  project_id?: string;
  subscription_tier?: string;
  ai_credits?: { credits: number; expiryDate: string };
  quota?: CloudQuotaData;
  models: string[];
  model_count: number;
  status: 'ok' | 'error';
  error?: string;
}

type ExternalCredentialObject = Record<string, unknown>;

type SchedulingMode = 'cache-first' | 'balance' | 'performance-first';

interface GetNextTokenOptions {
  sessionKey?: string;
  excludeAccountIds?: string[];
  model?: string;
  scopeKey?: string;
}

type TokenEntry = [string, TokenData];

function normalizeProjectId(projectId: string | null | undefined): string | undefined {
  if (!isString(projectId)) {
    return undefined;
  }

  const trimmedProjectId = projectId.trim();
  if (trimmedProjectId === '' || /^cloud-code-\d+$/i.test(trimmedProjectId)) {
    return undefined;
  }

  if (/^projects(?:\/.*)?$/i.test(trimmedProjectId)) {
    return undefined;
  }

  return trimmedProjectId;
}

function normalizeModelId(modelId: string | null | undefined): string | undefined {
  if (!isString(modelId)) {
    return undefined;
  }
  const normalized = modelId.replace(/^models\//i, '').trim();
  return normalized !== '' ? normalized : undefined;
}

function normalizeClientKey(clientKey: string | undefined): string | undefined {
  if (!isString(clientKey)) {
    return undefined;
  }
  const normalized = clientKey.trim().toLowerCase();
  return normalized !== '' ? normalized : undefined;
}

function isGeneratedImageVariant(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return normalized.startsWith('gemini-3-pro-image') || normalized.includes('-image-');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

@Injectable()
export class TokenManagerService implements OnModuleInit {
  private readonly logger = new Logger(TokenManagerService.name);
  private readonly defaultFallbackProjectId = 'silver-orbit-5m7qc';
  private readonly modelProbeCacheTtlMs = 60 * 60 * 1000;
  private currentIndex = 0;
  private readonly stickySessionTtlMs = 10 * 60 * 1000;
  private readonly rateLimitCooldownMs = 5 * 60 * 1000;
  private readonly forbiddenCooldownMs = 30 * 60 * 1000;
  private readonly defaultBackoffSteps = [60, 300, 1800, 7200];

  private tokens: Map<string, TokenData> = new Map();
  private accountCooldowns: Map<string, number> = new Map();
  private sessionBindings: Map<string, { accountId: string; expiresAt: number }> = new Map();
  private rateLimitTracker = new RateLimitTracker();
  private refreshLocks: Map<string, Promise<void>> = new Map();
  private projectIdLocks: Map<string, Promise<string | undefined>> = new Map();
  private externalCredentialsMtimeMs = 0;
  private scopedCredentialFingerprints: Map<string, string> = new Map();

  private shadowComparisonCount = 0;
  private shadowMismatchCount = 0;
  private parityRequestCount = 0;
  private parityErrorCount = 0;
  private noGoBlocked = false;
  private modelProbeCache: Map<string, { ok: boolean; checkedAt: number; reason?: string }> =
    new Map();
  private modelProbeLocks: Map<string, Promise<boolean>> = new Map();

  constructor(@Inject(GeminiClient) private readonly geminiClient: GeminiClient) {}

  async onModuleInit() {
    await this.loadAccounts();
  }

  async loadAccounts(): Promise<number> {
    try {
      const accounts = await CloudAccountRepo.getAccounts();
      let count = 0;

      this.tokens.clear();
      this.modelProbeCache.clear();
      this.modelProbeLocks.clear();

      for (const account of accounts) {
        const tokenData = this.mapAccountToTokenData(account);
        if (tokenData) {
          this.tokens.set(account.id, tokenData);
          count++;
        }
      }

      count += this.loadExternalCredentialAccounts();

      this.logger.log(`Token manager loaded ${count} cloud accounts into cache`);
      return count;
    } catch (e) {
      this.logger.error('Failed to load cloud accounts into token cache', e);
      return 0;
    }
  }

  async reloadAllAccounts(): Promise<number> {
    const count = await this.loadAccounts();
    this.clearAllRateLimits();
    this.clearAllSessions();
    return count;
  }

  upsertScopedExternalCredentials(scopeKey: string, credentials: ExternalCredentialObject[]): number {
    const normalizedScopeKey = scopeKey.trim();
    if (!normalizedScopeKey || credentials.length === 0) {
      return 0;
    }

    const fingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify(credentials))
      .digest('hex');
    if (this.scopedCredentialFingerprints.get(normalizedScopeKey) === fingerprint) {
      return credentials.length;
    }

    const activeScopedIds = new Set<string>();
    let count = 0;
    for (const item of credentials) {
      const tokenData = this.mapExternalCredentialToTokenData(item);
      if (!tokenData) {
        continue;
      }
      const scopedAccountId = `${normalizedScopeKey}:${tokenData.account_id}`;
      tokenData.account_id = scopedAccountId;
      tokenData.source_scope = normalizedScopeKey;
      this.tokens.set(scopedAccountId, tokenData);
      activeScopedIds.add(scopedAccountId);
      count++;
    }

    for (const [accountId, tokenData] of this.tokens.entries()) {
      if (tokenData.source_scope === normalizedScopeKey && !activeScopedIds.has(accountId)) {
        this.tokens.delete(accountId);
        this.accountCooldowns.delete(accountId);
        this.rateLimitTracker.clear(accountId);
      }
    }

    this.scopedCredentialFingerprints.set(normalizedScopeKey, fingerprint);
    return count;
  }

  clearAllSessions(): void {
    this.sessionBindings.clear();
  }

  clearAllRateLimits(): void {
    this.accountCooldowns.clear();
    this.rateLimitTracker.clearAll();
  }

  recordParityError(): void {
    if (!this.isParitySchedulingEnabled()) {
      return;
    }

    this.parityErrorCount++;
    const threshold = this.getNoGoErrorRateThreshold();
    const errorRate = this.parityErrorCount / Math.max(1, this.parityRequestCount);
    if (errorRate > threshold) {
      this.noGoBlocked = true;
      this.logger.error(
        `Parity no-go triggered by error threshold: rate=${errorRate.toFixed(4)}, requests=${this.parityRequestCount}, errors=${this.parityErrorCount}`,
      );
    }
  }

  setPreferredAccount(accountId?: string): void {
    const config = getServerConfig();
    if (!config) {
      return;
    }
    config.preferred_account_id = accountId ?? '';
  }

  isRateLimited(accountIdOrEmail: string, model?: string): boolean {
    const accountId = this.resolveAccountId(accountIdOrEmail) ?? accountIdOrEmail;
    const now = Date.now();
    const legacyCooldownUntil = this.accountCooldowns.get(accountId);
    if (legacyCooldownUntil && legacyCooldownUntil > now) {
      return true;
    }
    return this.rateLimitTracker.isRateLimited(accountId, model);
  }

  markAsRateLimited(accountIdOrEmail: string) {
    this.setAccountCooldown(accountIdOrEmail, 'rate limited', this.rateLimitCooldownMs);
  }

  markAsForbidden(accountIdOrEmail: string) {
    this.setAccountCooldown(accountIdOrEmail, 'forbidden', this.forbiddenCooldownMs);
  }

  async markFromUpstreamError(params: {
    accountIdOrEmail: string;
    status?: number;
    retryAfter?: string;
    body?: string;
    model?: string;
  }): Promise<void> {
    const accountId = this.resolveAccountId(params.accountIdOrEmail) ?? params.accountIdOrEmail;
    const normalizedModel = normalizeModelId(params.model);
    const hasExplicitRetryWindow =
      Boolean(isString(params.retryAfter) && !isEmpty(params.retryAfter.trim())) ||
      Boolean(params.body && params.body.includes('quotaResetDelay'));

    if (!hasExplicitRetryWindow && (params.status ?? 0) === 429) {
      const reason = this.detectRateLimitReasonFromBody(params.body);
      const shouldAttemptPreciseLockout =
        reason === RateLimitReason.QuotaExhausted || reason === RateLimitReason.Unknown;

      if (!shouldAttemptPreciseLockout) {
        const parsed = this.rateLimitTracker.trackFromUpstreamError({
          accountId,
          status: params.status,
          retryAfter: params.retryAfter,
          body: params.body,
          model: normalizedModel,
          backoffSteps: this.getCircuitBreakerBackoffSteps(),
        });

        if (!parsed) {
          return;
        }

        if (
          parsed.reason !== RateLimitReason.QuotaExhausted ||
          !parsed.model ||
          isEmpty(parsed.model.trim())
        ) {
          this.accountCooldowns.set(accountId, Date.now() + parsed.retryAfterSec * 1000);
        }
        return;
      }

      const isLockedByRealtimeQuota = await this.refreshRealtimeQuotaAndSetPreciseLockout(
        accountId,
        reason,
        normalizedModel,
      );
      if (isLockedByRealtimeQuota) {
        return;
      }

      const isLockedByQuotaCache = this.setPreciseLockoutFromCachedQuota(
        accountId,
        reason,
        normalizedModel,
      );
      if (isLockedByQuotaCache) {
        return;
      }
    }

    const parsed = this.rateLimitTracker.trackFromUpstreamError({
      accountId,
      status: params.status,
      retryAfter: params.retryAfter,
      body: params.body,
      model: normalizedModel,
      backoffSteps: this.getCircuitBreakerBackoffSteps(),
    });

    if (!parsed) {
      return;
    }

    // Keep legacy account-level cooldown for reasons that affect the full account.
    if (
      parsed.reason !== RateLimitReason.QuotaExhausted ||
      !parsed.model ||
      isEmpty(parsed.model.trim())
    ) {
      this.accountCooldowns.set(accountId, Date.now() + parsed.retryAfterSec * 1000);
    }

    this.logger.warn(
      `Recorded upstream limit for account ${accountId}: reason=${parsed.reason}, wait=${parsed.retryAfterSec}s, model=${parsed.model ?? 'n/a'}`,
    );
  }

  async getNextToken(options?: GetNextTokenOptions): Promise<CloudAccount | null> {
    try {
      const requestedScopeKey = options?.scopeKey?.trim();
      if (!requestedScopeKey) {
        await this.reloadExternalCredentialsIfChanged();
      }
      if (this.tokens.size === 0) {
        await this.loadAccounts();
      }
      if (this.tokens.size === 0) {
        return null;
      }

      const now = Date.now();
      const nowSeconds = Math.floor(now / 1000);
      const scopeKey = requestedScopeKey;
      const sessionKey = this.buildScopedSessionKey(scopeKey, options?.sessionKey?.trim());
      const model = options?.model;
      const excludedAccountIds = new Set(options?.excludeAccountIds ?? []);

      this.clearExpiredSessionBindings(now);
      this.rateLimitTracker.cleanupExpired();

      const fullAccountPool = Array.from(this.tokens.entries()).filter(([, tokenData]) => {
        if (!scopeKey) {
          return tokenData.source_scope === undefined;
        }
        return tokenData.source_scope === scopeKey;
      });
      const filteredAccountPool = fullAccountPool.filter(
        ([accountId]) => !excludedAccountIds.has(accountId),
      );
      const candidateAccountPool =
        filteredAccountPool.length > 0 ? filteredAccountPool : fullAccountPool;

      if (filteredAccountPool.length === 0 && excludedAccountIds.size > 0) {
        this.logger.warn(
          'Exclusion filter removed all accounts; retrying with the full account pool',
        );
      }

      if (candidateAccountPool.length === 0) {
        this.logger.warn('No eligible account found after exclusion filtering');
        return null;
      }

      if (this.shouldExecuteShadowComparison()) {
        this.executeShadowComparison(candidateAccountPool, sessionKey, model);
      }

      const selectedTokenEntry = this.isParitySchedulingEnabled()
        ? await this.selectParityTokenCandidate(candidateAccountPool, sessionKey, model, now)
        : this.selectLegacyTokenCandidate(candidateAccountPool, sessionKey, now);

      if (!selectedTokenEntry) {
        return null;
      }

      if (this.isParitySchedulingEnabled()) {
        this.parityRequestCount++;
      }

      const [accountId, tokenData] = selectedTokenEntry;
      return this.finalizeSelectedToken(accountId, tokenData, nowSeconds, sessionKey);
    } catch (error) {
      this.logger.error('Failed to select the next account token', error);
      return null;
    }
  }

  private shouldExecuteShadowComparison(): boolean {
    const config = getServerConfig();
    return (
      Boolean(config?.parity_shadow_enabled) &&
      !this.isParitySchedulingEnabled() &&
      !this.noGoBlocked
    );
  }

  private isParitySchedulingEnabled(): boolean {
    const config = getServerConfig();
    if (!config) {
      return false;
    }
    if (config.parity_kill_switch) {
      return false;
    }
    if (this.noGoBlocked) {
      return false;
    }
    return Boolean(config.parity_enabled);
  }

  private getSchedulingMode(): SchedulingMode {
    const config = getServerConfig();
    const mode = (config?.scheduling_mode ?? 'balance').toLowerCase();
    if (mode === 'cache-first' || mode === 'performance-first' || mode === 'balance') {
      return mode;
    }
    return 'balance';
  }

  private getMaxWaitDurationMs(): number {
    const config = getServerConfig();
    const seconds = config?.max_wait_seconds ?? 60;
    return Math.max(0, seconds) * 1000;
  }

  private getCircuitBreakerBackoffSteps(): number[] {
    const config = getServerConfig();
    const configured = config?.circuit_breaker_backoff_steps ?? this.defaultBackoffSteps;
    const normalized = configured
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Math.ceil(value));
    if (normalized.length > 0) {
      return normalized;
    }
    return this.defaultBackoffSteps;
  }

  private getPreferredAccountId(): string | undefined {
    const config = getServerConfig();
    const preferred = config?.preferred_account_id?.trim();
    return preferred ? preferred : undefined;
  }

  private buildScopedSessionKey(
    scopeKey: string | undefined,
    sessionKey: string | undefined,
  ): string | undefined {
    if (!sessionKey) {
      return undefined;
    }
    if (!scopeKey) {
      return sessionKey;
    }
    return `${scopeKey}:${sessionKey}`;
  }

  private getNoGoMismatchRateThreshold(): number {
    const config = getServerConfig();
    const threshold = config?.parity_no_go_mismatch_rate ?? 0.15;
    if (!Number.isFinite(threshold)) {
      return 0.15;
    }
    return Math.min(1, Math.max(0, threshold));
  }

  private getNoGoErrorRateThreshold(): number {
    const config = getServerConfig();
    const threshold = config?.parity_no_go_error_rate ?? 0.4;
    if (!Number.isFinite(threshold)) {
      return 0.4;
    }
    return Math.min(1, Math.max(0, threshold));
  }

  private collectEligibleTokens(
    allTokens: TokenEntry[],
    model: string | undefined,
    now: number,
  ): TokenEntry[] {
    return allTokens.filter(([accountId]) => {
      const cooldownUntil = this.accountCooldowns.get(accountId);
      if (cooldownUntil && cooldownUntil > now) {
        return false;
      }
      return !this.rateLimitTracker.isRateLimited(accountId, model);
    });
  }

  private getValidSessionBinding(
    sessionKey: string | undefined,
    now: number,
  ): { accountId: string; expiresAt: number } | null {
    if (!sessionKey) {
      return null;
    }
    const stickyBinding = this.sessionBindings.get(sessionKey);
    if (!stickyBinding || stickyBinding.expiresAt <= now) {
      return null;
    }
    return stickyBinding;
  }

  private findStickySessionToken(
    candidates: TokenEntry[],
    sessionKey: string | undefined,
    now: number,
  ): TokenEntry | null {
    const stickyBinding = this.getValidSessionBinding(sessionKey, now);
    if (!stickyBinding) {
      return null;
    }

    return candidates.find(([accountId]) => accountId === stickyBinding.accountId) ?? null;
  }

  public resetSelectionState(): void {
    this.currentIndex = 0;
  }

  private pickRoundRobinEntry(candidates: TokenEntry[]): TokenEntry | null {
    if (candidates.length === 0) {
      return null;
    }
    const picked = candidates[this.currentIndex % candidates.length];
    this.currentIndex++;
    return picked;
  }

  private peekRoundRobinCandidateAccountId(candidates: TokenEntry[]): string | null {
    if (candidates.length === 0) {
      return null;
    }
    return candidates[this.currentIndex % candidates.length][0];
  }

  private selectLegacyTokenCandidate(
    allTokens: TokenEntry[],
    sessionKey: string | undefined,
    now: number,
  ): TokenEntry | null {
    const availableByCooldown = allTokens.filter(([accountId]) => {
      const cooldownUntil = this.accountCooldowns.get(accountId);
      return !cooldownUntil || cooldownUntil <= now;
    });

    const candidateAccountPool = availableByCooldown.length > 0 ? availableByCooldown : allTokens;
    if (candidateAccountPool.length === 0) {
      return null;
    }

    if (availableByCooldown.length === 0) {
      this.logger.warn(
        'All accounts are cooling down; temporarily bypassing cooldown gate to preserve availability',
      );
    }

    const stickyToken = this.findStickySessionToken(candidateAccountPool, sessionKey, now);
    if (stickyToken) {
      return stickyToken;
    }

    return this.pickRoundRobinEntry(candidateAccountPool);
  }

  private async selectParityTokenCandidate(
    allTokens: TokenEntry[],
    sessionKey: string | undefined,
    model: string | undefined,
    now: number,
  ): Promise<TokenEntry | null> {
    const mode = this.getSchedulingMode();
    const availableTokens = this.collectEligibleTokens(allTokens, model, now);
    if (availableTokens.length === 0) {
      return null;
    }

    const preferredAccountId = this.getPreferredAccountId();
    if (preferredAccountId) {
      const preferred = availableTokens.find(([accountId]) => accountId === preferredAccountId);
      if (preferred) {
        return preferred;
      }
    }

    const stickyToken = this.findStickySessionToken(availableTokens, sessionKey, now);
    if (stickyToken) {
      return stickyToken;
    }

    const stickyBinding = this.getValidSessionBinding(sessionKey, now);
    if (stickyBinding && mode === 'cache-first') {
      const waitSec = this.rateLimitTracker.getRemainingWaitSeconds(stickyBinding.accountId, model);
      const waitMs = waitSec * 1000;
      const maxWaitMs = this.getMaxWaitDurationMs();
      if (waitMs > 0 && waitMs <= maxWaitMs) {
        await delay(waitMs);
        const refreshedAvailable = this.collectEligibleTokens(allTokens, model, Date.now());
        const stickyAfterWait =
          refreshedAvailable.find(([accountId]) => accountId === stickyBinding.accountId) ?? null;
        if (stickyAfterWait) {
          return stickyAfterWait;
        }
        if (refreshedAvailable.length > 0) {
          return this.pickRoundRobinEntry(refreshedAvailable);
        }
      }
    }

    return this.pickRoundRobinEntry(availableTokens);
  }

  private predictLegacyAccountCandidateId(
    allTokens: TokenEntry[],
    sessionKey: string | undefined,
    now: number,
  ): string | null {
    const availableByCooldown = allTokens.filter(([accountId]) => {
      const cooldownUntil = this.accountCooldowns.get(accountId);
      return !cooldownUntil || cooldownUntil <= now;
    });
    const candidateAccountPool = availableByCooldown.length > 0 ? availableByCooldown : allTokens;
    if (candidateAccountPool.length === 0) {
      return null;
    }

    const stickyToken = this.findStickySessionToken(candidateAccountPool, sessionKey, now);
    if (stickyToken) {
      return stickyToken[0];
    }

    return this.peekRoundRobinCandidateAccountId(candidateAccountPool);
  }

  private predictParityAccountCandidateId(
    allTokens: TokenEntry[],
    sessionKey: string | undefined,
    model: string | undefined,
    now: number,
  ): string | null {
    const availableTokens = this.collectEligibleTokens(allTokens, model, now);
    if (availableTokens.length === 0) {
      return null;
    }

    const preferredAccountId = this.getPreferredAccountId();
    if (preferredAccountId) {
      const preferred = availableTokens.find(([accountId]) => accountId === preferredAccountId);
      if (preferred) {
        return preferred[0];
      }
    }

    const stickyToken = this.findStickySessionToken(availableTokens, sessionKey, now);
    if (stickyToken) {
      return stickyToken[0];
    }

    return this.peekRoundRobinCandidateAccountId(availableTokens);
  }

  private executeShadowComparison(
    allTokens: TokenEntry[],
    sessionKey: string | undefined,
    model: string | undefined,
  ): void {
    const now = Date.now();
    const legacyAccountId = this.predictLegacyAccountCandidateId(allTokens, sessionKey, now);
    const parityAccountId = this.predictParityAccountCandidateId(allTokens, sessionKey, model, now);

    this.updateShadowStats(legacyAccountId, parityAccountId);
  }

  private updateShadowStats(legacyId: string | null, parityId: string | null): void {
    this.shadowComparisonCount++;

    if (legacyId !== parityId) {
      this.shadowMismatchCount++;
      this.logger.warn(
        `Parity shadow mismatch detected: legacy=${legacyId ?? 'n/a'}, parity=${parityId ?? 'n/a'}`,
      );
    }

    const mismatchRate = this.shadowMismatchCount / Math.max(1, this.shadowComparisonCount);
    if (mismatchRate > this.getNoGoMismatchRateThreshold()) {
      this.noGoBlocked = true;
      this.logger.error(
        `Parity no-go triggered by mismatch threshold: rate=${mismatchRate.toFixed(4)}, comparisons=${this.shadowComparisonCount}`,
      );
    }
  }

  private detectRateLimitReasonFromBody(body: string | undefined): RateLimitReason {
    const lowerBody = (body ?? '').toLowerCase();
    if (lowerBody.includes('model_capacity')) {
      return RateLimitReason.ModelCapacityExhausted;
    }
    if (lowerBody.includes('exhausted') || lowerBody.includes('quota')) {
      return RateLimitReason.QuotaExhausted;
    }
    if (
      lowerBody.includes('per minute') ||
      lowerBody.includes('rate limit') ||
      lowerBody.includes('rate_limit')
    ) {
      return RateLimitReason.RateLimitExceeded;
    }
    return RateLimitReason.Unknown;
  }

  private extractQuotaSnapshot(quota: CloudQuotaData | undefined): {
    modelQuotas: Record<string, number>;
    modelLimits: Record<string, number>;
    modelResetTimes: Record<string, string>;
    modelForwardingRules: Record<string, string>;
  } {
    const modelQuotas: Record<string, number> = {};
    const modelLimits: Record<string, number> = {};
    const modelResetTimes: Record<string, string> = {};
    const modelForwardingRules: Record<string, string> = {};

    for (const [modelName, modelInfo] of Object.entries(quota?.models ?? {})) {
      const normalizedModel = normalizeModelId(modelName);
      if (!normalizedModel) {
        continue;
      }

      if (Number.isFinite(modelInfo.percentage)) {
        modelQuotas[normalizedModel] = Math.floor(modelInfo.percentage);
      }

      const limitCandidate = modelInfo.max_output_tokens ?? modelInfo.max_tokens;
      if (isNumber(limitCandidate) && Number.isFinite(limitCandidate) && limitCandidate > 0) {
        modelLimits[normalizedModel] = Math.floor(limitCandidate);
      }

      if (isString(modelInfo.resetTime) && !isEmpty(modelInfo.resetTime.trim())) {
        modelResetTimes[normalizedModel] = modelInfo.resetTime;
      }
    }

    for (const [oldModel, newModel] of Object.entries(quota?.model_forwarding_rules ?? {})) {
      const normalizedOld = normalizeModelId(oldModel);
      const normalizedNew = normalizeModelId(newModel);
      if (!normalizedOld || !normalizedNew) {
        continue;
      }
      modelForwardingRules[normalizedOld] = normalizedNew;
      updateDynamicForwardingRules(normalizedOld, normalizedNew);
    }

    return {
      modelQuotas,
      modelLimits,
      modelResetTimes,
      modelForwardingRules,
    };
  }

  private findEarliestQuotaResetTime(modelResetTimes: Record<string, string>): string | null {
    const validTimes = Object.values(modelResetTimes).filter((value) => !isEmpty(value.trim()));
    if (validTimes.length === 0) {
      return null;
    }
    return [...validTimes].sort()[0];
  }

  private setPreciseLockoutFromCachedQuota(
    accountId: string,
    reason: RateLimitReason,
    model?: string,
  ): boolean {
    const tokenData = this.tokens.get(accountId);
    if (!tokenData) {
      return false;
    }

    const resetTime = this.findEarliestQuotaResetTime(tokenData.model_reset_times);
    if (!resetTime) {
      return false;
    }

    return this.rateLimitTracker.setLockoutUntilIso(accountId, resetTime, reason, model);
  }

  private async refreshRealtimeQuotaAndSetPreciseLockout(
    accountId: string,
    reason: RateLimitReason,
    model?: string,
  ): Promise<boolean> {
    const tokenData = this.tokens.get(accountId);
    if (!tokenData) {
      return false;
    }

    try {
      const latestQuota = await GoogleAPIService.fetchQuota(tokenData.access_token);
      const extractedState = this.extractQuotaSnapshot(latestQuota);

      tokenData.quota = latestQuota;
      tokenData.model_quotas = extractedState.modelQuotas;
      tokenData.model_limits = extractedState.modelLimits;
      tokenData.model_reset_times = extractedState.modelResetTimes;
      tokenData.model_forwarding_rules = extractedState.modelForwardingRules;
      this.tokens.set(accountId, tokenData);

      await CloudAccountRepo.updateQuota(accountId, latestQuota);

      const resetTime = this.findEarliestQuotaResetTime(extractedState.modelResetTimes);
      if (!resetTime) {
        return false;
      }
      return this.rateLimitTracker.setLockoutUntilIso(accountId, resetTime, reason, model);
    } catch (error) {
      this.logger.warn(`Failed to refresh realtime quota for account ${accountId}`, error);
      return false;
    }
  }

  private mapAccountToTokenData(account: CloudAccount): TokenData | null {
    if (!account.token) {
      return null;
    }

    const quota = account.quota;
    const extractedState = this.extractQuotaSnapshot(quota);

    return {
      account_id: account.id,
      email: account.email,
      access_token: account.token.access_token,
      refresh_token: account.token.refresh_token,
      id_token: account.token.id_token,
      oauth_client_key: normalizeClientKey(account.token.oauth_client_key),
      token_type: account.token.token_type || 'Bearer',
      expires_in: account.token.expires_in,
      expiry_timestamp: account.token.expiry_timestamp,
      project_id: account.token.project_id || undefined,
      session_id: account.token.session_id || this.generateSessionId(),
      upstream_proxy_url: account.token.upstream_proxy_url || account.proxy_url || undefined,
      quota,
      model_quotas: extractedState.modelQuotas,
      model_limits: extractedState.modelLimits,
      model_reset_times: extractedState.modelResetTimes,
      model_forwarding_rules: extractedState.modelForwardingRules,
    };
  }

  private getExternalCredentialsFile(): string {
    return (
      process.env.ANTIGRAVITY_MANAGER_CREDENTIALS_FILE?.trim() ||
      process.env.ANTIGRAVITY_CREDENTIALS_FILE?.trim() ||
      ''
    );
  }

  private async reloadExternalCredentialsIfChanged(): Promise<void> {
    const file = this.getExternalCredentialsFile();
    if (!file) {
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      if (this.externalCredentialsMtimeMs !== 0) {
        await this.loadAccounts();
      }
      return;
    }
    if (stat.mtimeMs !== this.externalCredentialsMtimeMs) {
      await this.loadAccounts();
    }
  }

  private loadExternalCredentialAccounts(): number {
    const file = this.getExternalCredentialsFile();
    if (!file) {
      return 0;
    }

    let stat: fs.Stats;
    let raw: string;
    try {
      stat = fs.statSync(file);
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      this.externalCredentialsMtimeMs = 0;
      return 0;
    }

    const parsed = this.parseExternalCredentialPayload(raw);
    this.externalCredentialsMtimeMs = stat.mtimeMs;
    if (parsed.length === 0) {
      return 0;
    }

    let count = 0;
    for (const item of parsed) {
      const tokenData = this.mapExternalCredentialToTokenData(item);
      if (!tokenData) {
        continue;
      }
      this.tokens.set(tokenData.account_id, tokenData);
      count++;
    }
    this.logger.log(`Loaded ${count} external Antigravity credential(s) from ${file}`);
    return count;
  }

  private parseExternalCredentialPayload(raw: string): ExternalCredentialObject[] {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter(this.isExternalCredentialObject);
      }
      if (this.isExternalCredentialObject(parsed)) {
        const accounts = parsed.accounts;
        if (Array.isArray(accounts)) {
          return accounts.filter(this.isExternalCredentialObject);
        }
        return [parsed];
      }
    } catch (error) {
      this.logger.warn('Failed to parse external Antigravity credentials file', error);
    }
    return [];
  }

  private isExternalCredentialObject(value: unknown): value is ExternalCredentialObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private mapExternalCredentialToTokenData(item: ExternalCredentialObject): TokenData | null {
    const tokenObject = this.isExternalCredentialObject(item.token) ? item.token : item;
    const accessToken = this.readString(tokenObject, 'access_token', 'accessToken');
    const refreshToken = this.readString(tokenObject, 'refresh_token', 'refreshToken');
    if (!accessToken || !refreshToken) {
      return null;
    }

    const fingerprint = crypto
      .createHash('sha256')
      .update(`${accessToken}:${refreshToken}`)
      .digest('hex')
      .slice(0, 16);
    const email =
      this.readString(tokenObject, 'email') ||
      this.readString(item, 'email') ||
      `newapi-${fingerprint}@external.local`;
    const accountId =
      this.readString(tokenObject, 'account_id', 'accountId') ||
      this.readString(item, 'account_id', 'accountId') ||
      `external-${fingerprint}`;
    const expiresIn = this.readNumber(tokenObject, 'expires_in', 'expiresIn') ?? 3600;
    const expiryTimestamp =
      this.normalizeExternalExpiryTimestamp(tokenObject, expiresIn) ??
      Math.floor(Date.now() / 1000) + expiresIn;

    return {
      account_id: accountId,
      email,
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: this.readString(tokenObject, 'id_token', 'idToken'),
      oauth_client_key: normalizeClientKey(
        this.readString(tokenObject, 'oauth_client_key', 'oauthClientKey'),
      ),
      token_type: this.readString(tokenObject, 'token_type', 'tokenType') || 'Bearer',
      expires_in: expiresIn,
      expiry_timestamp: expiryTimestamp,
      project_id: this.readString(tokenObject, 'project_id', 'projectId'),
      session_id: this.readString(tokenObject, 'session_id', 'sessionId') || this.generateSessionId(),
      upstream_proxy_url: this.readString(tokenObject, 'upstream_proxy_url', 'upstreamProxyUrl'),
      model_quotas: {},
      model_limits: {},
      model_reset_times: {},
      model_forwarding_rules: {},
    };
  }

  private readString(source: ExternalCredentialObject, ...keys: string[]): string | undefined {
    for (const key of keys) {
      const value = source[key];
      if (isString(value) && !isEmpty(value.trim())) {
        return value.trim();
      }
    }
    return undefined;
  }

  private readNumber(source: ExternalCredentialObject, ...keys: string[]): number | undefined {
    for (const key of keys) {
      const value = source[key];
      if (isNumber(value) && Number.isFinite(value)) {
        return Math.floor(value);
      }
      if (isString(value)) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return Math.floor(parsed);
        }
      }
    }
    return undefined;
  }

  private normalizeExternalExpiryTimestamp(
    source: ExternalCredentialObject,
    expiresIn: number,
  ): number | undefined {
    const numeric = this.readNumber(source, 'expiry_timestamp', 'expiryTimestamp');
    if (numeric !== undefined && numeric > 0) {
      return numeric > 1_000_000_000_000 ? Math.floor(numeric / 1000) : numeric;
    }

    const expiry = this.readString(source, 'expiry', 'expired');
    if (!expiry) {
      return undefined;
    }
    const parsed = Date.parse(expiry);
    if (!Number.isFinite(parsed)) {
      return Math.floor(Date.now() / 1000) + expiresIn;
    }
    return Math.floor(parsed / 1000);
  }

  private generateSessionId(): string {
    const min = 1_000_000_000_000_000_000n;
    const max = 9_000_000_000_000_000_000n;
    const range = max - min;
    const rand = BigInt(Math.floor(Math.random() * Number(range)));
    return (-(min + rand)).toString();
  }

  private async finalizeSelectedToken(
    accountId: string,
    tokenData: TokenData,
    nowSeconds: number,
    sessionKey?: string,
  ): Promise<CloudAccount | null> {
    try {
      let effectiveProjectId: string | undefined;

      await this.refreshSelectedTokenIfNeeded(accountId, tokenData, nowSeconds);
      await this.refreshScopedQuotaSnapshotIfNeeded(accountId, tokenData);

      if (normalizeProjectId(tokenData.project_id) === undefined) {
        tokenData.project_id = undefined;
      }
      effectiveProjectId = tokenData.project_id;

      if (!effectiveProjectId) {
        effectiveProjectId = await this.resolveProjectIdWithLock(accountId, tokenData);
      }

      if (!effectiveProjectId) {
        const fallbackProjectId = this.resolveFallbackProjectId();
        effectiveProjectId = fallbackProjectId;
        this.logger.warn(
          `Using non-persistent fallback project ID for ${tokenData.email}: ${fallbackProjectId}`,
        );
      }

      this.rateLimitTracker.markSuccess(accountId);

      if (sessionKey) {
        this.sessionBindings.set(sessionKey, {
          accountId,
          expiresAt: Date.now() + this.stickySessionTtlMs,
        });
      }

      const timestamp = Date.now();
      return {
        id: accountId,
        provider: 'google',
        email: tokenData.email,
        token: {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          id_token: tokenData.id_token,
          token_type: tokenData.token_type,
          expires_in: tokenData.expires_in,
          expiry_timestamp: tokenData.expiry_timestamp,
          project_id: effectiveProjectId,
          oauth_client_key: tokenData.oauth_client_key,
          session_id: tokenData.session_id,
          upstream_proxy_url: tokenData.upstream_proxy_url,
        },
        created_at: timestamp,
        last_used: timestamp,
      };
    } catch (error) {
      this.logger.error('Failed to finalize selected account token', error);
      return null;
    }
  }

  private async refreshSelectedTokenIfNeeded(
    accountId: string,
    tokenData: TokenData,
    nowSeconds: number,
  ): Promise<void> {
    if (nowSeconds < tokenData.expiry_timestamp - 300) {
      return;
    }

    await this.runAccountLock(this.refreshLocks, accountId, () =>
      this.refreshSelectedTokenLocked(accountId, tokenData, nowSeconds),
    );
    this.syncTokenDataFromCache(accountId, tokenData);
  }

  private async refreshScopedQuotaSnapshotIfNeeded(
    accountId: string,
    tokenData: TokenData,
  ): Promise<void> {
    if (!tokenData.source_scope || tokenData.quota) {
      return;
    }

    try {
      const latestQuota = await GoogleAPIService.fetchQuota(
        tokenData.access_token,
        tokenData.upstream_proxy_url,
      );
      const extractedState = this.extractQuotaSnapshot(latestQuota);
      tokenData.quota = latestQuota;
      tokenData.model_quotas = extractedState.modelQuotas;
      tokenData.model_limits = extractedState.modelLimits;
      tokenData.model_reset_times = extractedState.modelResetTimes;
      tokenData.model_forwarding_rules = extractedState.modelForwardingRules;
      this.tokens.set(accountId, tokenData);
    } catch (error) {
      this.logger.warn(
        `Failed to refresh scoped quota snapshot for ${tokenData.email}`,
        error,
      );
    }
  }

  private async refreshSelectedTokenLocked(
    accountId: string,
    tokenData: TokenData,
    nowSeconds: number,
  ): Promise<void> {
    const latestToken = this.tokens.get(accountId);
    if (latestToken && nowSeconds < latestToken.expiry_timestamp - 300) {
      Object.assign(tokenData, latestToken);
      this.logger.debug(`Access token already refreshed by another request for ${tokenData.email}`);
      return;
    }

    const tokenToRefresh = latestToken ?? tokenData;
    this.logger.log(`Access token near expiry for ${tokenToRefresh.email}; refreshing`);
    try {
      const refreshedToken = await GoogleAPIService.refreshAccessToken(
        tokenToRefresh.refresh_token,
        tokenToRefresh.upstream_proxy_url,
        tokenToRefresh.oauth_client_key,
      );
      tokenToRefresh.access_token = refreshedToken.access_token;
      tokenToRefresh.refresh_token = refreshedToken.refresh_token ?? tokenToRefresh.refresh_token;
      tokenToRefresh.id_token = refreshedToken.id_token ?? tokenToRefresh.id_token;
      tokenToRefresh.expires_in = refreshedToken.expires_in;
      tokenToRefresh.expiry_timestamp = nowSeconds + refreshedToken.expires_in;
      tokenToRefresh.oauth_client_key = this.normalizeRefreshedOauthClientKey(
        tokenToRefresh,
        refreshedToken.oauth_client_key,
      );
      Object.assign(tokenData, tokenToRefresh);
      await this.persistTokenState(accountId, tokenToRefresh);
      this.tokens.set(accountId, tokenToRefresh);
      this.logger.log(`Access token refreshed for ${tokenToRefresh.email}`);
    } catch (error) {
      this.logger.error(`Failed to refresh access token for ${tokenToRefresh.email}`, error);
    }
  }

  private async resolveProjectIdWithLock(
    accountId: string,
    tokenData: TokenData,
  ): Promise<string | undefined> {
    const existingProjectId = normalizeProjectId(this.tokens.get(accountId)?.project_id);
    if (existingProjectId) {
      tokenData.project_id = existingProjectId;
      return existingProjectId;
    }

    const projectId = await this.runAccountLock(this.projectIdLocks, accountId, () =>
      this.resolveProjectIdLocked(accountId, tokenData),
    );
    if (projectId) {
      tokenData.project_id = projectId;
    }

    return projectId;
  }

  private async runAccountLock<T>(
    locks: Map<string, Promise<T>>,
    accountId: string,
    createPromise: () => Promise<T>,
  ): Promise<T> {
    const existingPromise = locks.get(accountId);
    if (existingPromise) {
      return existingPromise;
    }

    const promise = createPromise();
    locks.set(accountId, promise);
    try {
      return await promise;
    } finally {
      if (locks.get(accountId) === promise) {
        locks.delete(accountId);
      }
    }
  }

  private syncTokenDataFromCache(accountId: string, tokenData: TokenData): void {
    const latestToken = this.tokens.get(accountId);
    if (latestToken) {
      Object.assign(tokenData, latestToken);
    }
  }

  private async resolveProjectIdLocked(
    accountId: string,
    tokenData: TokenData,
  ): Promise<string | undefined> {
    const latestToken = this.tokens.get(accountId) ?? tokenData;
    const existingProjectId = normalizeProjectId(latestToken.project_id);
    if (existingProjectId) {
      tokenData.project_id = existingProjectId;
      return existingProjectId;
    }

    try {
      const fetchedProjectId = await GoogleAPIService.fetchProjectId(latestToken.access_token);
      const normalizedProjectId = normalizeProjectId(fetchedProjectId);
      if (normalizedProjectId) {
        latestToken.project_id = normalizedProjectId;
        tokenData.project_id = normalizedProjectId;
        await this.persistTokenState(accountId, latestToken);
        this.tokens.set(accountId, latestToken);
        this.logger.log(`Resolved project ID for ${latestToken.email}: ${normalizedProjectId}`);
        return normalizedProjectId;
      }

      this.logger.warn(
        `Project ID unavailable for ${latestToken.email}; continuing without project context`,
      );
    } catch (error) {
      this.logger.warn(`Unable to resolve project ID for ${latestToken.email}`, error);
    }

    return undefined;
  }

  private resolveAccountId(accountIdOrEmail: string): string | null {
    if (this.tokens.has(accountIdOrEmail)) {
      return accountIdOrEmail;
    }

    for (const [accountId, tokenData] of this.tokens.entries()) {
      if (tokenData.email === accountIdOrEmail) {
        return accountId;
      }
    }

    return null;
  }

  private clearExpiredSessionBindings(now: number): void {
    for (const [sessionKey, binding] of this.sessionBindings.entries()) {
      if (binding.expiresAt <= now) {
        this.sessionBindings.delete(sessionKey);
      }
    }
  }

  private setAccountCooldown(
    accountIdOrEmail: string,
    reason: 'rate limited' | 'forbidden',
    durationMs: number,
  ): void {
    const accountId = this.resolveAccountId(accountIdOrEmail) ?? accountIdOrEmail;
    const cooldownUntil = Date.now() + durationMs;

    this.accountCooldowns.set(accountId, cooldownUntil);
    this.logger.warn(
      `Applied ${reason} cooldown: source=${accountIdOrEmail}, accountId=${accountId}, until=${new Date(cooldownUntil).toISOString()}`,
    );
  }

  private async persistTokenState(accountId: string, tokenData: TokenData) {
    if (accountId.startsWith('external-')) {
      return;
    }
    try {
      const persistedAccount = await CloudAccountRepo.getAccount(accountId);
      if (persistedAccount?.token) {
        const updatedToken = {
          ...persistedAccount.token,
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          id_token: tokenData.id_token ?? persistedAccount.token.id_token,
          expires_in: tokenData.expires_in,
          expiry_timestamp: tokenData.expiry_timestamp,
          project_id: tokenData.project_id ?? persistedAccount.token.project_id,
          oauth_client_key:
            tokenData.oauth_client_key ??
            normalizeClientKey(persistedAccount.token.oauth_client_key) ??
            persistedAccount.token.oauth_client_key,
          session_id: tokenData.session_id ?? persistedAccount.token.session_id,
          upstream_proxy_url:
            tokenData.upstream_proxy_url ?? persistedAccount.token.upstream_proxy_url,
        };
        await CloudAccountRepo.updateToken(accountId, updatedToken);
      }
    } catch (error) {
      this.logger.error('Failed to persist token state to database', error);
    }
  }

  getAccountCount(): number {
    return this.tokens.size;
  }

  private normalizeRefreshedOauthClientKey(
    currentToken: { oauth_client_key?: string; project_id?: string },
    refreshedClientKey?: string,
  ): string | undefined {
    return GoogleAPIService.normalizeRefreshedOAuthClientKey(currentToken, refreshedClientKey);
  }

  getAllCollectedModels(): Set<string> {
    const allModels = new Set<string>();
    for (const tokenData of this.tokens.values()) {
      for (const modelId of Object.keys(tokenData.model_quotas)) {
        allModels.add(modelId);
      }
    }
    return allModels;
  }

  async getUsableModelIds(candidateModels: Iterable<string>): Promise<string[]> {
    const collectedModels = this.getAllCollectedModels();
    const collectedModelSet = new Set(
      [...collectedModels].map((modelId) => normalizeModelId(modelId)?.toLowerCase()).filter(isString),
    );
    const normalizedCandidates = [...new Set([...candidateModels].map(normalizeModelId).filter(isString))]
      .filter((modelId) => {
        if (!isGeneratedImageVariant(modelId)) {
          return true;
        }
        return collectedModelSet.has(modelId.toLowerCase());
      })
      .sort();
    const usableModels: string[] = [];

    for (const modelId of normalizedCandidates) {
      if (await this.canAnyAccountUseModel(modelId)) {
        usableModels.push(modelId);
      }
    }

    return usableModels;
  }

  private async canAnyAccountUseModel(modelId: string): Promise<boolean> {
    for (const [accountId, tokenData] of this.tokens.entries()) {
      if (await this.canTokenUseModel(accountId, tokenData, modelId)) {
        return true;
      }
    }
    return false;
  }

  private async canTokenUseModel(
    accountId: string,
    tokenData: TokenData,
    modelId: string,
  ): Promise<boolean> {
    const normalizedModel = normalizeModelId(modelId);
    if (!normalizedModel) {
      return false;
    }

    const cacheKey = `${accountId}:${normalizedModel}`;
    const cached = this.modelProbeCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.checkedAt < this.modelProbeCacheTtlMs) {
      return cached.ok;
    }

    const locked = this.modelProbeLocks.get(cacheKey);
    if (locked) {
      return locked;
    }

    const probe = this.probeModelForToken(tokenData, normalizedModel)
      .then((ok) => {
        this.modelProbeCache.set(cacheKey, { ok, checkedAt: Date.now() });
        return ok;
      })
      .catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.modelProbeCache.set(cacheKey, { ok: false, checkedAt: Date.now(), reason });
        return false;
      })
      .finally(() => {
        this.modelProbeLocks.delete(cacheKey);
      });

    this.modelProbeLocks.set(cacheKey, probe);
    return probe;
  }

  private async probeModelForToken(tokenData: TokenData, modelId: string): Promise<boolean> {
    const accountId = this.resolveAccountId(tokenData.account_id) ?? tokenData.account_id;
    const nowSeconds = Math.floor(Date.now() / 1000);
    await this.refreshSelectedTokenIfNeeded(accountId, tokenData, nowSeconds);

    if (normalizeProjectId(tokenData.project_id) === undefined) {
      tokenData.project_id = undefined;
    }

    if (!tokenData.project_id) {
      tokenData.project_id = await this.resolveProjectIdWithLock(accountId, tokenData);
    }

    const requestUserAgent = await resolveRequestUserAgent();
    const project = normalizeProjectId(tokenData.project_id);
    const body: GeminiInternalRequest = {
      requestId: `agent/${Date.now()}/${crypto.randomBytes(4).toString('hex')}`,
      request: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'ping' }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 16,
        },
      },
      model: modelId,
      userAgent: requestUserAgent,
      requestType: 'agent',
      enabledCreditTypes: ['GOOGLE_ONE_AI'],
    };

    if (project) {
      body.project = project;
    }

    try {
      const stream = await this.geminiClient.streamGenerateInternal(
        body,
        tokenData.access_token,
        tokenData.upstream_proxy_url,
      );
      const destroyable = stream as NodeJS.ReadableStream & { destroy?: () => void };
      destroyable.destroy?.();
      return true;
    } catch (error) {
      this.logger.warn(
        `[Model-Probe] account=${tokenData.account_id || tokenData.email} model=${modelId} unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private getAvailableModelsFromToken(tokenData: TokenData): Set<string> {
    const availableModels = new Set<string>();

    for (const modelId of Object.keys(tokenData.model_quotas ?? {})) {
      const normalized = normalizeModelId(modelId)?.toLowerCase();
      if (normalized) {
        availableModels.add(normalized);
      }
    }

    for (const modelId of Object.keys(tokenData.quota?.models ?? {})) {
      const normalized = normalizeModelId(modelId)?.toLowerCase();
      if (normalized) {
        availableModels.add(normalized);
      }
    }

    return availableModels;
  }

  private buildDynamicModelCandidates(modelName: string, tokenData?: TokenData): string[] | null {
    const normalizedModel = normalizeModelId(modelName)?.toLowerCase();
    if (!normalizedModel) {
      return null;
    }

    const proFamily = new Set([
      'gemini-3-pro',
      'gemini-3-pro-preview',
      'gemini-3-pro-high',
      'gemini-3-pro-low',
      'gemini-3.1-pro',
      'gemini-3.1-pro-preview',
      'gemini-3.1-pro-high',
      'gemini-3.1-pro-low',
    ]);

    const candidates: string[] = [];
    const seen = new Set<string>();
    const pushCandidate = (candidate: string) => {
      const normalizedCandidate = normalizeModelId(candidate)?.toLowerCase();
      if (normalizedCandidate && !seen.has(normalizedCandidate)) {
        seen.add(normalizedCandidate);
        candidates.push(normalizedCandidate);
      }
    };

    const forwardingTarget = tokenData?.model_forwarding_rules?.[normalizedModel];
    if (forwardingTarget) {
      pushCandidate(forwardingTarget);
    }

    // Some external account states expose "high" aliases that are not actually
    // routable upstream. Keep 3.1 Pro requests on the probed account-safe low path.
    if (proFamily.has(normalizedModel)) {
      if (
        normalizedModel === 'gemini-3.1-pro-high' ||
        normalizedModel === 'gemini-3.1-pro' ||
        normalizedModel === 'gemini-3.1-pro-preview'
      ) {
        pushCandidate('gemini-3.1-pro-low');
      } else {
        pushCandidate(normalizedModel);
      }

      pushCandidate('gemini-3-pro-preview');
      pushCandidate('gemini-3-pro-high');
      pushCandidate('gemini-3.1-pro-low');
      pushCandidate('gemini-3-pro-low');
    }

    if (normalizedModel === 'claude-sonnet-4-6-thinking' || normalizedModel === 'claude-sonnet-4-6') {
      pushCandidate('claude-sonnet-4-6');
      pushCandidate('claude-sonnet-4-6-thinking');
    }

    if (normalizedModel === 'claude-opus-4-6-thinking' || normalizedModel === 'claude-opus-4-6') {
      pushCandidate('claude-opus-4-6-thinking');
    }

    return candidates.length > 0 ? candidates : null;
  }

  async inspectCredentials(
    credentials: ExternalCredentialObject[],
  ): Promise<AccountInspectionResult[]> {
    const results: AccountInspectionResult[] = [];

    for (const credential of credentials) {
      const tokenData = this.mapExternalCredentialToTokenData(credential);
      if (!tokenData) {
        results.push({
          account_id: '',
          email: '',
          token_type: 'Bearer',
          expiry_timestamp: 0,
          models: [],
          model_count: 0,
          status: 'error',
          error: 'Invalid Antigravity credential: access_token / refresh_token missing',
        });
        continue;
      }

      try {
        let effectiveToken = { ...tokenData };
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (effectiveToken.expiry_timestamp <= nowSeconds+300) {
          const refreshed = await GoogleAPIService.refreshAccessToken(
            effectiveToken.refresh_token,
            effectiveToken.upstream_proxy_url,
            effectiveToken.oauth_client_key,
          );
          effectiveToken = {
            ...effectiveToken,
            access_token: refreshed.access_token,
            refresh_token: refreshed.refresh_token || effectiveToken.refresh_token,
            id_token: refreshed.id_token || effectiveToken.id_token,
            token_type: refreshed.token_type || effectiveToken.token_type,
            expires_in: refreshed.expires_in || effectiveToken.expires_in,
            expiry_timestamp: nowSeconds + (refreshed.expires_in || effectiveToken.expires_in || 3600),
            oauth_client_key:
              normalizeClientKey(refreshed.oauth_client_key) || effectiveToken.oauth_client_key,
          };
        }

        const [userInfo, quota] = await Promise.all([
          GoogleAPIService.getUserInfo(
            effectiveToken.access_token,
            effectiveToken.upstream_proxy_url,
          ).catch(() => null),
          GoogleAPIService.fetchQuota(
            effectiveToken.access_token,
            effectiveToken.upstream_proxy_url,
          ),
        ]);

        const aiCredits = await GoogleAPIService.fetchAICredits(
          effectiveToken.access_token,
          effectiveToken.upstream_proxy_url,
        ).catch(() => null);

        if (aiCredits) {
          quota.ai_credits = aiCredits;
        }

        const usableModels = await this.getUsableModelsForToken(effectiveToken, Object.keys(quota.models ?? {}));
        const visibleModels = usableModels.length > 0 ? usableModels : Object.keys(quota.models ?? {});

        results.push({
          account_id: effectiveToken.account_id,
          email: userInfo?.email || effectiveToken.email,
          name: userInfo?.name,
          avatar_url: userInfo?.picture,
          token_type: effectiveToken.token_type,
          expiry_timestamp: effectiveToken.expiry_timestamp,
          oauth_client_key: effectiveToken.oauth_client_key,
          project_id: effectiveToken.project_id,
          subscription_tier: quota.subscription_tier,
          ai_credits: quota.ai_credits,
          quota,
          models: visibleModels.sort(),
          model_count: visibleModels.length,
          status: 'ok',
        });
      } catch (error) {
        results.push({
          account_id: tokenData.account_id,
          email: tokenData.email,
          token_type: tokenData.token_type,
          expiry_timestamp: tokenData.expiry_timestamp,
          oauth_client_key: tokenData.oauth_client_key,
          project_id: tokenData.project_id,
          models: [],
          model_count: 0,
          status: 'error',
          error: error instanceof Error ? error.message : 'Failed to inspect account',
        });
      }
    }

    return results;
  }

  private async getUsableModelsForToken(
    tokenData: TokenData,
    candidateModels: Iterable<string>,
  ): Promise<string[]> {
    const normalizedCandidates = [...new Set([...candidateModels].map(normalizeModelId).filter(isString))].sort();
    const usableModels: string[] = [];

    for (const modelId of normalizedCandidates) {
      if (await this.canTokenUseModel(tokenData.account_id, tokenData, modelId)) {
        usableModels.push(modelId);
      }
    }

    return usableModels;
  }

  resolveDynamicModelForAccount(accountId: string, mappedModel: string): string {
    const tokenData = this.tokens.get(accountId);
    if (!tokenData) {
      return mappedModel;
    }

    const candidates = this.buildDynamicModelCandidates(mappedModel, tokenData);
    if (!candidates) {
      return mappedModel;
    }

    const availableModels = this.getAvailableModelsFromToken(tokenData);
    if (availableModels.size === 0) {
      return candidates[0] ?? mappedModel;
    }

    const normalizedMappedModel = normalizeModelId(mappedModel)?.toLowerCase() ?? mappedModel;

    for (const candidate of candidates) {
      if (!availableModels.has(candidate)) {
        continue;
      }

      if (candidate !== normalizedMappedModel) {
        this.logger.log(
          `[Dynamic-Model-Rewrite] account=${accountId} ${mappedModel} -> ${candidate}`,
        );
      }
      return candidate;
    }

    return mappedModel;
  }

  getModelOutputLimitForAccount(accountId: string, modelName: string): number | undefined {
    const tokenData = this.tokens.get(accountId);
    const normalizedModel = normalizeModelId(modelName);
    if (!tokenData || !normalizedModel) {
      return undefined;
    }
    return tokenData.model_limits[normalizedModel];
  }

  getModelThinkingBudgetForAccount(accountId: string, modelName: string): number | undefined {
    const tokenData = this.tokens.get(accountId);
    const normalizedModel = normalizeModelId(modelName);
    if (!tokenData || !normalizedModel) {
      return undefined;
    }

    for (const [quotaModelName, modelInfo] of Object.entries(tokenData.quota?.models ?? {})) {
      if (normalizeModelId(quotaModelName) !== normalizedModel) {
        continue;
      }
      const budget = modelInfo?.thinking_budget;
      if (isNumber(budget) && Number.isFinite(budget) && budget >= 0) {
        return Math.floor(budget);
      }
    }
    return undefined;
  }

  private resolveFallbackProjectId(): string {
    const fromEnv = process.env.PROXY_FALLBACK_PROJECT_ID?.trim();
    const normalizedFromEnv = normalizeProjectId(fromEnv);
    if (normalizedFromEnv) {
      return normalizedFromEnv;
    }
    return this.defaultFallbackProjectId;
  }
}
