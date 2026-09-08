/*
Copyright (C) 2025 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Collapse,
  Descriptions,
  Modal,
  Spin,
  Tag,
  Typography,
} from '@douyinfe/semi-ui';
import { API, showError } from '../../../../helpers';
import { MOBILE_BREAKPOINT } from '../../../../hooks/common/useIsMobile';

const { Text } = Typography;

const getDisplayText = (value) => {
  if (value == null) return '';
  return String(value).trim();
};

const isMobileViewport = () =>
  typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT;

const getAntigravityAccountsModalLayout = () => {
  if (isMobileViewport()) {
    return {
      width: 'calc(100vw - 16px)',
      style: {
        top: 8,
        maxWidth: 'calc(100vw - 16px)',
        margin: '0 auto',
      },
      bodyStyle: {
        maxHeight: 'calc(100vh - 148px)',
        overflowY: 'auto',
        padding: '16px 16px 12px',
      },
    };
  }

  return {
    width: 900,
    style: {
      top: 24,
      maxWidth: 'min(900px, 92vw)',
    },
    bodyStyle: {
      maxHeight: 'calc(100vh - 172px)',
      overflowY: 'auto',
      padding: '20px 24px 16px',
    },
  };
};

const formatUnixSeconds = (unixSeconds) => {
  const v = Number(unixSeconds);
  if (!Number.isFinite(v) || v <= 0) return '-';
  try {
    return new Date(v * 1000).toLocaleString();
  } catch (error) {
    return String(unixSeconds);
  }
};

const clampQuotaPercentage = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
};

const roundQuotaPercentage = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
};

const formatQuotaPercent = (value) => {
  const rounded = roundQuotaPercentage(value);
  if (rounded == null) return '-';
  return `${rounded}%`;
};

const formatAiCredits = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);
};

const getQuotaTone = (percentage) => {
  const value = Number(percentage);
  if (value > 80) return { text: '#16a34a', bar: '#22c55e' };
  if (value > 20) return { text: '#ca8a04', bar: '#eab308' };
  return { text: '#dc2626', bar: '#ef4444' };
};

const formatModelDisplayName = (modelName, info) =>
  getDisplayText(info?.display_name) || String(modelName || '').replace(/^models\//i, '');

const formatResetTime = (resetTime, tt) => {
  const text = getDisplayText(resetTime);
  if (!text) return tt('重置时间未知');
  const target = new Date(text);
  if (Number.isNaN(target.getTime())) return text;

  const diffMs = target.getTime() - Date.now();
  if (diffMs <= 0) return tt('即将重置');

  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${tt('重置')}: ${days}d ${hours}h`;
  return `${tt('重置')}: ${hours}h ${minutes}m`;
};

const getQuotaWindowInfo = (info, kind) => {
  const windows = info?.quota_windows || {};
  if (kind === 'weekly') {
    return info?.weekly || info?.weekly_quota || windows.weekly || null;
  }
  return (
    info?.five_hour ||
    info?.fiveHour ||
    info?.five_hour_quota ||
    windows.five_hour ||
    windows.fiveHour || {
      percentage: info?.percentage,
      resetTime: info?.resetTime,
    }
  );
};

const hasQuotaWindow = (windowInfo) => Number.isFinite(Number(windowInfo?.percentage));

const getQuotaEntries = (account) => {
  const quotaModels = account?.quota?.models;
  if (!quotaModels || typeof quotaModels !== 'object') return [];
  return Object.entries(quotaModels)
    .map(([modelName, info]) => {
      const safeInfo = info || {};
      const weekly = getQuotaWindowInfo(safeInfo, 'weekly');
      const fiveHour = getQuotaWindowInfo(safeInfo, 'five_hour');
      return {
        modelName,
        info: safeInfo,
        weekly,
        fiveHour,
        percentage: Number(fiveHour?.percentage ?? weekly?.percentage ?? safeInfo?.percentage),
      };
    })
    .filter((item) => Number.isFinite(item.percentage))
    .sort((a, b) => b.percentage - a.percentage);
};

const averageQuotaPercentage = (entries) => {
  if (!entries.length) return null;
  return roundQuotaPercentage(
    entries.reduce((sum, item) => sum + item.percentage, 0) / entries.length,
  );
};

const groupQuotaEntries = (entries) => {
  const groups = [
    {
      title: 'Claude',
      entries: entries.filter((item) => /claude/i.test(item.modelName)),
    },
    {
      title: 'Gemini',
      entries: entries.filter((item) => /gemini/i.test(item.modelName)),
    },
    {
      title: 'Other',
      entries: entries.filter(
        (item) => !/claude/i.test(item.modelName) && !/gemini/i.test(item.modelName),
      ),
    },
  ];
  return groups.filter((group) => group.entries.length > 0);
};

const CopyableValue = ({ t, value, onCopy, monospace = false }) => {
  const tt = typeof t === 'function' ? t : (v) => v;
  const text = getDisplayText(value);

  return (
    <div className='flex min-w-0 items-start justify-between gap-2'>
      <div
        className={`min-w-0 flex-1 break-all text-xs leading-5 text-semi-color-text-1 ${
          monospace ? 'font-mono' : ''
        }`}
      >
        {text || '-'}
      </div>
      <Button
        size='small'
        type='tertiary'
        theme='borderless'
        className='shrink-0 px-1 text-xs'
        disabled={!text}
        onClick={() => onCopy?.(text)}
      >
        {tt('复制')}
      </Button>
    </div>
  );
};

const QuotaWindowCell = ({ t, windowInfo }) => {
  const tt = typeof t === 'function' ? t : (v) => v;
  if (!hasQuotaWindow(windowInfo)) {
    return <div className='min-w-[118px] text-right text-xs text-semi-color-text-2'>-</div>;
  }

  const percentage = clampQuotaPercentage(Number(windowInfo.percentage));
  const tone = getQuotaTone(percentage);

  return (
    <div className='flex min-w-[118px] flex-col items-end gap-1'>
      <div
        className='text-[11px] leading-none text-semi-color-text-2'
        title={getDisplayText(windowInfo?.resetTime)}
      >
        {formatResetTime(windowInfo?.resetTime, tt)}
      </div>
      <div className='flex items-center gap-2'>
        <span className='font-mono text-xs font-semibold' style={{ color: tone.text }}>
          {formatQuotaPercent(percentage)}
        </span>
        <div className='h-1.5 w-16 overflow-hidden rounded-full bg-semi-color-fill-1'>
          <div
            className='h-full rounded-full'
            style={{ width: `${percentage}%`, backgroundColor: tone.bar }}
          />
        </div>
      </div>
    </div>
  );
};

const QuotaModelRow = ({ t, item }) => {
  return (
    <div className='grid grid-cols-[minmax(0,1fr)_118px_118px] items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-semi-color-fill-0'>
      <div
        className='min-w-0 truncate text-sm font-medium text-semi-color-text-1'
        title={item.modelName}
      >
        {formatModelDisplayName(item.modelName, item.info)}
      </div>
      <QuotaWindowCell t={t} windowInfo={item.weekly} />
      <QuotaWindowCell t={t} windowInfo={item.fiveHour} />
    </div>
  );
};

const QuotaGroup = ({ t, title, entries }) => {
  if (!entries.length) return null;
  return (
    <div className='space-y-1'>
      <div className='flex items-center gap-2 px-2 py-1'>
        <span className='text-[10px] font-bold uppercase tracking-wide text-semi-color-text-2'>
          {title}
        </span>
        <div className='h-px flex-1 bg-semi-color-border' />
      </div>
      <div className='grid grid-cols-[minmax(0,1fr)_118px_118px] gap-3 px-2 pb-1 text-[11px] font-medium text-semi-color-text-2'>
        <span>{t('模型')}</span>
        <span className='text-right'>{t('每周限额')}</span>
        <span className='text-right'>{t('5小时限额')}</span>
      </div>
      {entries.map((item) => (
        <QuotaModelRow key={item.modelName} t={t} item={item} />
      ))}
    </div>
  );
};

const AccountQuotaSection = ({ t, account }) => {
  const tt = typeof t === 'function' ? t : (v) => v;
  const quotaEntries = getQuotaEntries(account);
  const groupedEntries = groupQuotaEntries(quotaEntries);
  const averageQuota = averageQuotaPercentage(quotaEntries);
  const usedQuota = averageQuota == null ? null : roundQuotaPercentage(100 - averageQuota);
  const credits = formatAiCredits(account?.quota?.ai_credits?.credits ?? account?.ai_credits?.credits);
  const creditsExpiry =
    account?.quota?.ai_credits?.expiryDate || account?.ai_credits?.expiryDate || '';

  return (
    <div className='mt-3 rounded-lg border border-semi-color-border p-3'>
      <div className='mb-3 flex flex-wrap items-center justify-between gap-2'>
        <div>
          <div className='text-sm font-semibold text-semi-color-text-0'>
            {tt('额度')}
          </div>
          <div className='mt-0.5 text-xs text-semi-color-text-2'>
            {averageQuota == null
              ? tt('暂无模型额度数据')
              : `${tt('已用')}: ${formatQuotaPercent(usedQuota)} / ${tt('剩余')}: ${formatQuotaPercent(averageQuota)}`}
          </div>
        </div>
        <div className='flex flex-wrap gap-2'>
          {averageQuota != null ? (
            <Tag color='green' type='light' shape='circle'>
              {tt('平均剩余')}: {formatQuotaPercent(averageQuota)}
            </Tag>
          ) : null}
          {credits ? (
            <Tag color='violet' type='light' shape='circle'>
              AI Credits: {credits}
            </Tag>
          ) : null}
        </div>
      </div>

      {creditsExpiry ? (
        <div className='mb-3 text-xs text-semi-color-text-2'>
          Credits Expiry: {creditsExpiry}
        </div>
      ) : null}

      {groupedEntries.length > 0 ? (
        <div className='space-y-3'>
          {groupedEntries.map((group) => (
            <QuotaGroup
              key={group.title}
              t={tt}
              title={group.title}
              entries={group.entries}
            />
          ))}
        </div>
      ) : (
        <Text type='tertiary' size='small'>
          {tt('暂无额度数据，请刷新后重试')}
        </Text>
      )}
    </div>
  );
};

const SummaryCard = ({ label, value, description }) => (
  <div className='rounded-xl border border-semi-color-border bg-semi-color-bg-0 p-3'>
    <div className='text-xs font-medium text-semi-color-text-2'>{label}</div>
    <div className='mt-1 text-2xl font-semibold text-semi-color-text-0'>
      {value}
    </div>
    {description ? (
      <div className='mt-1 text-xs text-semi-color-text-2'>{description}</div>
    ) : null}
  </div>
);

const AccountCard = ({ t, account, index, onCopy }) => {
  const tt = typeof t === 'function' ? t : (v) => v;
  const models = Array.isArray(account?.models) ? account.models : [];
  const ok = account?.status === 'ok';
  const credits = formatAiCredits(account?.quota?.ai_credits?.credits ?? account?.ai_credits?.credits);

  return (
    <div className='rounded-xl border border-semi-color-border bg-semi-color-bg-0 p-3'>
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div className='min-w-0'>
          <div className='text-sm font-semibold text-semi-color-text-0'>
            {account?.name || account?.email || account?.account_id || `Account ${index + 1}`}
          </div>
          <div className='mt-1 text-xs text-semi-color-text-2'>
            {account?.subscription_tier || '-'}
          </div>
        </div>
        <div className='flex flex-wrap gap-2'>
          <Tag color={ok ? 'green' : 'red'} type='light' shape='circle'>
            {ok ? tt('可用') : tt('错误')}
          </Tag>
          <Tag color='light-blue' type='light' shape='circle'>
            {tt('模型')}: {account?.model_count ?? models.length}
          </Tag>
          {credits ? (
            <Tag color='violet' type='light' shape='circle'>
              AI Credits: {credits}
            </Tag>
          ) : null}
        </div>
      </div>

      <div className='mt-3 rounded-lg bg-semi-color-fill-0 px-3 py-2'>
        <Descriptions>
          <Descriptions.Item itemKey='Account ID'>
            <CopyableValue
              t={tt}
              value={account?.account_id}
              onCopy={onCopy}
              monospace={true}
            />
          </Descriptions.Item>
          <Descriptions.Item itemKey={tt('邮箱')}>
            <CopyableValue t={tt} value={account?.email} onCopy={onCopy} />
          </Descriptions.Item>
          <Descriptions.Item itemKey='Project ID'>
            <CopyableValue
              t={tt}
              value={account?.project_id}
              onCopy={onCopy}
              monospace={true}
            />
          </Descriptions.Item>
          <Descriptions.Item itemKey={tt('过期时间')}>
            {formatUnixSeconds(account?.expiry_timestamp)}
          </Descriptions.Item>
          <Descriptions.Item itemKey='OAuth Client'>
            {account?.oauth_client_key || '-'}
          </Descriptions.Item>
          <Descriptions.Item itemKey='Credits Expiry'>
            {account?.quota?.ai_credits?.expiryDate || account?.ai_credits?.expiryDate || '-'}
          </Descriptions.Item>
        </Descriptions>
      </div>

      <AccountQuotaSection t={tt} account={account} />

      <div className='mt-3 rounded-lg border border-semi-color-border p-3'>
        <div className='mb-2 text-sm font-semibold text-semi-color-text-0'>
          {tt('模型列表')}
        </div>
        {models.length > 0 ? (
          <div className='flex flex-wrap gap-1'>
            {models.map((model) => (
              <Tag key={`${account?.account_id}-${model}`} color='grey' type='light'>
                {model}
              </Tag>
            ))}
          </div>
        ) : (
          <Text type={account?.error ? 'danger' : 'tertiary'} size='small'>
            {account?.error || '-'}
          </Text>
        )}
      </div>
    </div>
  );
};

const AntigravityAccountsView = ({ t, record, payload, onCopy, onRefresh }) => {
  const tt = typeof t === 'function' ? t : (v) => v;
  const [showRawJson, setShowRawJson] = useState(false);
  const accounts = Array.isArray(payload?.data?.data) ? payload.data.data : [];
  const okAccounts = accounts.filter((item) => item?.status === 'ok');
  const failedAccounts = accounts.filter((item) => item?.status === 'error');
  const totalModels = okAccounts.reduce(
    (sum, item) => sum + Number(item?.model_count ?? item?.models?.length ?? 0),
    0,
  );
  const allQuotaEntries = okAccounts.flatMap((account) => getQuotaEntries(account));
  const averageQuota = averageQuotaPercentage(allQuotaEntries);
  const usedQuota = averageQuota == null ? null : roundQuotaPercentage(100 - averageQuota);
  const totalCredits = okAccounts.reduce((sum, account) => {
    const value = Number(account?.quota?.ai_credits?.credits ?? account?.ai_credits?.credits);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
  const errorMessage =
    payload?.success === false
      ? getDisplayText(payload?.message) || tt('获取账号信息失败')
      : '';
  const rawText = JSON.stringify(payload ?? {}, null, 2);

  return (
    <div className='flex flex-col gap-4'>
      {errorMessage ? (
        <div className='rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700'>
          {errorMessage}
        </div>
      ) : null}

      <div className='rounded-xl border border-semi-color-border bg-semi-color-bg-0 p-3'>
        <div className='flex flex-wrap items-start justify-between gap-2'>
          <div className='min-w-0'>
            <div className='text-xs font-medium text-semi-color-text-2'>
              Antigravity {tt('账号信息')}
            </div>
            <div className='mt-2 flex flex-wrap items-center gap-2'>
              <Tag color={okAccounts.length > 0 ? 'green' : 'grey'} type='light' shape='circle'>
                {okAccounts.length > 0 ? tt('可用') : tt('待确认')}
              </Tag>
              {failedAccounts.length > 0 ? (
                <Tag color='red' type='light' shape='circle'>
                  {tt('错误')}: {failedAccounts.length}
                </Tag>
              ) : null}
              <Tag color='grey' type='light' shape='circle'>
                {tt('上游状态码')}: {payload?.upstream_status ?? '-'}
              </Tag>
            </div>
          </div>
          <Button size='small' type='tertiary' theme='outline' onClick={onRefresh}>
            {tt('刷新')}
          </Button>
        </div>

        <div className='mt-3 grid grid-cols-1 gap-3 md:grid-cols-3'>
          <SummaryCard
            label={tt('已用/剩余')}
            value={
              averageQuota == null
                ? '-'
                : `${formatQuotaPercent(usedQuota)} / ${formatQuotaPercent(averageQuota)}`
            }
            description={tt('按可用模型平均计算')}
          />
          <SummaryCard
            label={tt('账号信息')}
            value={accounts.length}
            description={`${tt('可用')}: ${okAccounts.length} / ${tt('异常')}: ${failedAccounts.length}`}
          />
          <SummaryCard
            label={tt('模型')}
            value={totalModels}
            description={
              totalCredits > 0
                ? `AI Credits: ${formatAiCredits(totalCredits)}`
                : tt('当前账号可见模型总数')
            }
          />
        </div>

        <div className='mt-2 text-xs text-semi-color-text-2'>
          {tt('通道')}: {record?.name || '-'} ({tt('编号')}: {record?.id || '-'})
        </div>
      </div>

      <div className='space-y-3'>
        {accounts.length > 0 ? (
          accounts.map((account, index) => (
            <AccountCard
              key={`${account?.account_id || 'account'}-${index}`}
              t={tt}
              account={account}
              index={index}
              onCopy={onCopy}
            />
          ))
        ) : (
          <div className='rounded-xl border border-semi-color-border bg-semi-color-bg-0 p-4 text-sm text-semi-color-text-2'>
            {tt('暂无账号信息')}
          </div>
        )}
      </div>

      <Collapse
        activeKey={showRawJson ? ['raw-json'] : []}
        onChange={(activeKey) => {
          const keys = Array.isArray(activeKey) ? activeKey : [activeKey];
          setShowRawJson(keys.includes('raw-json'));
        }}
      >
        <Collapse.Panel header='Raw JSON' itemKey='raw-json'>
          <div className='mb-2 flex justify-end'>
            <Button
              size='small'
              type='primary'
              theme='outline'
              onClick={() => onCopy?.(rawText)}
              disabled={!rawText}
            >
              {tt('复制')}
            </Button>
          </div>
          <pre className='max-h-[50vh] overflow-y-auto rounded-lg bg-semi-color-fill-0 p-3 text-xs text-semi-color-text-0'>
            {rawText}
          </pre>
        </Collapse.Panel>
      </Collapse>
    </div>
  );
};

const AntigravityAccountsLoader = ({ t, record, initialPayload, onCopy }) => {
  const tt = typeof t === 'function' ? t : (v) => v;
  const [loading, setLoading] = useState(!initialPayload);
  const [payload, setPayload] = useState(initialPayload ?? null);
  const hasShownErrorRef = useRef(false);
  const mountedRef = useRef(true);
  const recordId = record?.id;

  const fetchAccounts = useCallback(async () => {
    if (!recordId) {
      if (mountedRef.current) setPayload(null);
      return;
    }

    if (mountedRef.current) setLoading(true);
    try {
      const res = await API.get(`/api/channel/${recordId}/antigravity/accounts`, {
        skipErrorHandler: true,
      });
      if (!mountedRef.current) return;
      setPayload(res?.data ?? null);
      if (!res?.data?.success && !hasShownErrorRef.current) {
        hasShownErrorRef.current = true;
        showError(tt('获取账号信息失败'));
      }
    } catch (error) {
      if (!mountedRef.current) return;
      if (!hasShownErrorRef.current) {
        hasShownErrorRef.current = true;
        showError(tt('获取账号信息失败'));
      }
      setPayload({ success: false, message: String(error) });
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [recordId, tt]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (initialPayload) return;
    fetchAccounts().catch(() => {});
  }, [fetchAccounts, initialPayload]);

  if (loading) {
    return (
      <div className='flex items-center justify-center py-10'>
        <Spin spinning={true} size='large' tip={tt('加载中...')} />
      </div>
    );
  }

  return (
    <AntigravityAccountsView
      t={tt}
      record={record}
      payload={payload}
      onCopy={onCopy}
      onRefresh={fetchAccounts}
    />
  );
};

export const openAntigravityAccountsModal = ({ t, record, payload, onCopy }) => {
  const tt = typeof t === 'function' ? t : (v) => v;
  const layout = getAntigravityAccountsModalLayout();

  Modal.info({
    title: `Antigravity ${tt('账号信息')}`,
    centered: false,
    width: layout.width,
    style: layout.style,
    bodyStyle: layout.bodyStyle,
    content: (
      <AntigravityAccountsLoader
        t={tt}
        record={record}
        initialPayload={payload}
        onCopy={onCopy}
      />
    ),
    footer: (
      <div className='flex justify-end gap-2'>
        <Button type='primary' theme='solid' onClick={() => Modal.destroyAll()}>
          {tt('关闭')}
        </Button>
      </div>
    ),
  });
};
