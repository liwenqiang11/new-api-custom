import { useMemo, useState } from 'react'
import {
  AlertCircle,
  Boxes,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Mail,
  RefreshCw,
  ShieldCheck,
  User,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import dayjs from '@/lib/dayjs'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { StatusBadge } from '@/components/status-badge'

type AntigravityAccountItem = {
  account_id?: string
  email?: string
  name?: string
  avatar_url?: string
  token_type?: string
  expiry_timestamp?: number
  oauth_client_key?: string
  project_id?: string
  subscription_tier?: string
  ai_credits?: { credits?: number; expiryDate?: string }
  quota?: {
    models?: Record<
      string,
      {
        percentage?: number
        resetTime?: string
      }
    >
  }
  models?: string[]
  model_count?: number
  status?: 'ok' | 'error'
  error?: string
}

export type AntigravityAccountsDialogData = {
  success: boolean
  message?: string
  upstream_status?: number
  data?: {
    object?: string
    data?: AntigravityAccountItem[]
  }
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  channelName?: string
  channelId?: number
  configuredModels?: string[]
  response: AntigravityAccountsDialogData | null
  onRefresh?: () => void
  isRefreshing?: boolean
}

function formatUnixSeconds(unixSeconds: unknown): string {
  const v = Number(unixSeconds)
  if (!Number.isFinite(v) || v <= 0) return '-'
  try {
    return dayjs(v * 1000).format('YYYY-MM-DD HH:mm:ss')
  } catch {
    return String(unixSeconds)
  }
}

function CopyableField(props: {
  icon: React.ReactNode
  label: string
  value?: string | null
  mono?: boolean
}) {
  const { copyToClipboard, copiedText } = useCopyToClipboard({ notify: false })
  const text = props.value?.trim() || ''
  const hasCopied = copiedText === text

  return (
    <div className='flex items-center justify-between gap-2 py-1'>
      <div className='flex min-w-0 items-center gap-2'>
        <span className='text-muted-foreground flex-shrink-0'>
          {props.icon}
        </span>
        <span className='text-muted-foreground flex-shrink-0 text-xs'>
          {props.label}
        </span>
        <span
          className={`min-w-0 truncate text-xs ${props.mono ? 'font-mono' : ''}`}
        >
          {text || '-'}
        </span>
      </div>
      {text && (
        <Button
          type='button'
          variant='ghost'
          size='sm'
          className='h-6 w-6 flex-shrink-0 p-0'
          onClick={() => copyToClipboard(text)}
        >
          {hasCopied ? (
            <Check className='h-3 w-3 text-green-600' />
          ) : (
            <Copy className='h-3 w-3' />
          )}
        </Button>
      )}
    </div>
  )
}

type QuotaRow = {
  model: string
  percentage?: number
  resetTime?: string
  hasQuota: boolean
}

function normalizeModelId(model: string): string {
  return model.trim().replace(/^models\//i, '').toLowerCase()
}

function getQuotaGroup(model: string): 'claude' | 'gemini' | 'other' {
  const normalized = normalizeModelId(model)
  if (normalized.includes('claude')) return 'claude'
  if (normalized.includes('gemini')) return 'gemini'
  return 'other'
}

function buildQuotaRows(
  account: AntigravityAccountItem,
  configuredModels: string[] = []
): QuotaRow[] {
  const rows = new Map<string, QuotaRow>()

  for (const [model, info] of Object.entries(account.quota?.models ?? {})) {
    const key = normalizeModelId(model)
    if (!key) continue
    rows.set(key, {
      model,
      percentage:
        typeof info?.percentage === 'number' && Number.isFinite(info.percentage)
          ? Math.max(0, Math.min(100, Math.floor(info.percentage)))
          : undefined,
      resetTime: info?.resetTime,
      hasQuota: true,
    })
  }

  for (const model of configuredModels) {
    const key = normalizeModelId(model)
    if (!key || rows.has(key)) continue
    rows.set(key, {
      model,
      hasQuota: false,
    })
  }

  return Array.from(rows.values()).sort((a, b) => {
    const groupOrder = { claude: 0, gemini: 1, other: 2 }
    const groupDelta = groupOrder[getQuotaGroup(a.model)] - groupOrder[getQuotaGroup(b.model)]
    if (groupDelta !== 0) return groupDelta
    return a.model.localeCompare(b.model)
  })
}

function formatResetTime(resetTime?: string): string {
  if (!resetTime?.trim()) return '-'
  const date = dayjs(resetTime)
  if (!date.isValid()) return resetTime
  return date.format('MM-DD HH:mm')
}

function QuotaSection(props: {
  account: AntigravityAccountItem
  configuredModels?: string[]
}) {
  const { t } = useTranslation()
  const rows = buildQuotaRows(props.account, props.configuredModels)
  const rowsWithQuota = rows.filter((row) => row.hasQuota && typeof row.percentage === 'number')
  const averageRemaining =
    rowsWithQuota.length > 0
      ? Math.floor(
          rowsWithQuota.reduce((sum, row) => sum + Number(row.percentage), 0) /
            rowsWithQuota.length
        )
      : null
  const groupedRows = rows.reduce<Record<string, QuotaRow[]>>((acc, row) => {
    const group = getQuotaGroup(row.model).toUpperCase()
    acc[group] = acc[group] ?? []
    acc[group].push(row)
    return acc
  }, {})

  if (rows.length === 0) return null

  return (
    <div className='mt-3 rounded-md border p-3'>
      <div className='mb-2 flex flex-wrap items-center justify-between gap-2'>
        <div className='text-sm font-medium'>{t('Quota')}</div>
        <div className='flex flex-wrap gap-2'>
          {averageRemaining !== null && (
            <StatusBadge
              label={`${t('Average Remaining')}: ${averageRemaining}%`}
              variant='success'
              size='sm'
              copyable={false}
            />
          )}
          {typeof props.account.ai_credits?.credits === 'number' && (
            <StatusBadge
              label={`AI Credits: ${props.account.ai_credits.credits}`}
              variant='purple'
              size='sm'
              copyable={false}
            />
          )}
        </div>
      </div>
      {averageRemaining !== null && (
        <div className='text-muted-foreground mb-3 text-xs'>
          {t('Used:')} {100 - averageRemaining}% / {t('Remaining:')}{' '}
          {averageRemaining}%
        </div>
      )}
      <div className='space-y-4'>
        {Object.entries(groupedRows).map(([group, groupRows]) => (
          <div key={group}>
            <div className='text-muted-foreground mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wide uppercase'>
              <span>{group}</span>
              <span className='h-px flex-1 bg-border' />
            </div>
            <div className='space-y-2'>
              {groupRows.map((row) => (
                <div
                  key={row.model}
                  className='grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-xs'
                >
                  <div className='truncate font-medium'>{row.model}</div>
                  {row.hasQuota && typeof row.percentage === 'number' ? (
                    <div className='flex min-w-[132px] items-center justify-end gap-2'>
                      <span className='text-emerald-600 dark:text-emerald-400'>
                        {row.percentage}%
                      </span>
                      <div className='h-1.5 w-14 overflow-hidden rounded-full bg-muted'>
                        <div
                          className='h-full rounded-full bg-emerald-500'
                          style={{ width: `${row.percentage}%` }}
                        />
                      </div>
                      <span className='text-muted-foreground min-w-12 text-right'>
                        {formatResetTime(row.resetTime)}
                      </span>
                    </div>
                  ) : (
                    <StatusBadge
                      label={t('Quota not returned')}
                      variant='neutral'
                      size='sm'
                      copyable={false}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function AntigravityAccountsDialog({
  open,
  onOpenChange,
  channelName,
  channelId,
  configuredModels = [],
  response,
  onRefresh,
  isRefreshing,
}: Props) {
  const { t } = useTranslation()
  const [showRawJson, setShowRawJson] = useState(false)
  const { copyToClipboard, copiedText } = useCopyToClipboard({ notify: false })

  const accounts = useMemo(
    () => response?.data?.data ?? [],
    [response?.data?.data]
  )

  const okAccounts = accounts.filter((item) => item.status === 'ok')
  const failedAccounts = accounts.filter((item) => item.status === 'error')
  const totalModels = okAccounts.reduce(
    (sum, item) => sum + Number(item.model_count || item.models?.length || 0),
    0
  )

  const rawJsonText = useMemo(() => {
    if (!response) return ''
    try {
      return JSON.stringify(
        {
          success: response.success,
          message: response.message,
          upstream_status: response.upstream_status,
          data: response.data,
        },
        null,
        2
      )
    } catch {
      return String(response?.data ?? '')
    }
  }, [response])

  const errorMessage =
    response?.success === false
      ? response?.message?.trim() || t('Failed to fetch account info')
      : ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-4xl'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            {t('Antigravity Account Info')}
          </DialogTitle>
          <DialogDescription>
            {t('Channel:')} <strong>{channelName || '-'}</strong>{' '}
            {channelId ? `(#${channelId})` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className='space-y-4'>
          {errorMessage && (
            <div className='rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400'>
              {errorMessage}
            </div>
          )}

          <div className='rounded-lg border p-4'>
            <div className='flex flex-wrap items-center justify-between gap-2'>
              <div className='flex flex-wrap items-center gap-2'>
                <StatusBadge
                  label={okAccounts.length > 0 ? t('Available') : t('Pending')}
                  variant={okAccounts.length > 0 ? 'success' : 'neutral'}
                  copyable={false}
                />
                {failedAccounts.length > 0 && (
                  <StatusBadge
                    label={`${t('Errors')}: ${failedAccounts.length}`}
                    variant='danger'
                    copyable={false}
                  />
                )}
                {typeof response?.upstream_status === 'number' && (
                  <StatusBadge
                    label={`${t('Status:')} ${response.upstream_status}`}
                    variant='neutral'
                    copyable={false}
                  />
                )}
              </div>
              {onRefresh && (
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={onRefresh}
                  disabled={Boolean(isRefreshing)}
                >
                  <RefreshCw className='mr-1.5 h-3.5 w-3.5' />
                  {t('Refresh')}
                </Button>
              )}
            </div>

            <div className='mt-4 grid grid-cols-1 gap-3 md:grid-cols-3'>
              <div className='rounded-md border p-3'>
                <div className='text-muted-foreground text-xs'>{t('Accounts')}</div>
                <div className='mt-1 text-2xl font-semibold'>{accounts.length}</div>
                <div className='text-muted-foreground mt-1 text-xs'>
                  {t('Used:')} {okAccounts.length} / {t('Remaining:')}{' '}
                  {Math.max(accounts.length - okAccounts.length, 0)}
                </div>
              </div>
              <div className='rounded-md border p-3'>
                <div className='text-muted-foreground text-xs'>
                  {t('Account Info')}
                </div>
                <div className='mt-1 text-2xl font-semibold'>
                  {okAccounts.length}
                </div>
                <div className='text-muted-foreground mt-1 text-xs'>
                  {t('Healthy account(s) ready for routing')}
                </div>
              </div>
              <div className='rounded-md border p-3'>
                <div className='text-muted-foreground text-xs'>{t('Models')}</div>
                <div className='mt-1 text-2xl font-semibold'>{totalModels}</div>
                <div className='text-muted-foreground mt-1 text-xs'>
                  {t('Aggregated visible models from current accounts')}
                </div>
              </div>
            </div>
          </div>

          <ScrollArea className='max-h-[48vh] pr-2'>
            <div className='space-y-4'>
              {accounts.map((account, index) => {
                const models = account.models ?? []
                const accountStatusOk = account.status === 'ok'
                const aiCredits =
                  typeof account.ai_credits?.credits === 'number'
                    ? `${account.ai_credits.credits}`
                    : ''

                return (
                  <div key={`${account.account_id || 'account'}-${index}`} className='rounded-lg border p-4'>
                    <div className='flex flex-wrap items-center justify-between gap-2'>
                      <div className='flex min-w-0 items-center gap-2'>
                        {accountStatusOk ? (
                          <ShieldCheck className='h-4 w-4 text-emerald-500' />
                        ) : (
                          <AlertCircle className='h-4 w-4 text-red-500' />
                        )}
                        <div className='min-w-0'>
                          <div className='truncate text-sm font-semibold'>
                            {account.name || account.email || account.account_id || '-'}
                          </div>
                          <div className='text-muted-foreground text-xs'>
                            {account.subscription_tier || '-'}
                          </div>
                        </div>
                      </div>
                      <div className='flex flex-wrap gap-2'>
                        <StatusBadge
                          label={accountStatusOk ? t('Available') : t('Error')}
                          variant={accountStatusOk ? 'success' : 'danger'}
                          copyable={false}
                        />
                        <StatusBadge
                          label={`${t('Models')}: ${account.model_count ?? models.length}`}
                          variant='info'
                          copyable={false}
                        />
                        {aiCredits && (
                          <StatusBadge
                            label={`AI Credits: ${aiCredits}`}
                            variant='purple'
                            copyable={false}
                          />
                        )}
                      </div>
                    </div>

                    <div className='bg-muted/30 mt-3 rounded-md px-3 py-2'>
                      <CopyableField
                        icon={<User className='h-3.5 w-3.5' />}
                        label='Account ID'
                        value={account.account_id}
                        mono
                      />
                      <CopyableField
                        icon={<Mail className='h-3.5 w-3.5' />}
                        label={t('Email')}
                        value={account.email}
                      />
                      <CopyableField
                        icon={<ShieldCheck className='h-3.5 w-3.5' />}
                        label={t('Project ID')}
                        value={account.project_id}
                        mono
                      />
                    </div>

                    <div className='mt-3 grid grid-cols-1 gap-3 md:grid-cols-3'>
                      <div className='rounded-md border p-3'>
                        <div className='text-muted-foreground text-xs'>
                          {t('Expires at')}
                        </div>
                        <div className='mt-1 text-sm font-medium'>
                          {formatUnixSeconds(account.expiry_timestamp)}
                        </div>
                      </div>
                      <div className='rounded-md border p-3'>
                        <div className='text-muted-foreground text-xs'>
                          {t('OAuth Client')}
                        </div>
                        <div className='mt-1 truncate text-sm font-medium'>
                          {account.oauth_client_key || '-'}
                        </div>
                      </div>
                      <div className='rounded-md border p-3'>
                        <div className='text-muted-foreground text-xs'>
                          {t('Credits Expiry')}
                        </div>
                        <div className='mt-1 text-sm font-medium'>
                          {account.ai_credits?.expiryDate || '-'}
                        </div>
                      </div>
                    </div>

                    <QuotaSection
                      account={account}
                      configuredModels={configuredModels}
                    />

                    <div className='mt-3 rounded-md border p-3'>
                      <div className='mb-2 flex items-center gap-2 text-sm font-medium'>
                        <Boxes className='h-4 w-4' />
                        <span>{t('Models')}</span>
                      </div>
                      <div className='flex flex-wrap gap-1'>
                        {models.length > 0 ? (
                          models.map((model) => (
                            <StatusBadge
                              key={`${account.account_id}-${model}`}
                              label={model}
                              variant='neutral'
                              size='sm'
                              copyable={false}
                            />
                          ))
                        ) : (
                          <div className='text-muted-foreground text-xs'>
                            {account.error || '-'}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </ScrollArea>

          <div className='rounded-lg border'>
            <button
              type='button'
              className='hover:bg-muted/40 flex w-full items-center justify-between gap-2 p-3 transition-colors'
              onClick={() => setShowRawJson((v) => !v)}
            >
              <div className='text-sm font-medium'>{t('Raw JSON')}</div>
              {showRawJson ? (
                <ChevronUp className='text-muted-foreground h-4 w-4' />
              ) : (
                <ChevronDown className='text-muted-foreground h-4 w-4' />
              )}
            </button>
            {showRawJson && (
              <>
                <div className='border-t px-3 py-2'>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={() => copyToClipboard(rawJsonText)}
                  >
                    {copiedText === rawJsonText ? (
                      <Check className='mr-2 h-3.5 w-3.5 text-green-600' />
                    ) : (
                      <Copy className='mr-2 h-3.5 w-3.5' />
                    )}
                    {t('Copy JSON')}
                  </Button>
                </div>
                <ScrollArea className='max-h-64 border-t'>
                  <pre className='overflow-x-auto p-3 text-xs leading-5 whitespace-pre-wrap'>
                    {rawJsonText || '-'}
                  </pre>
                </ScrollArea>
              </>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            {t('Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
