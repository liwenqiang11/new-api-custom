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

import React, { useState } from 'react';
import { Card, Tabs, TabPane } from '@douyinfe/semi-ui';
import { BarChart2, ChartColumn } from 'lucide-react';
import { VChart } from '@visactor/react-vchart';

const ChartCard = ({
  title,
  icon,
  activeKey,
  onChange,
  tabs,
  spec,
  CARD_PROPS,
  CHART_CONFIG,
  FLEX_CENTER_GAP2,
}) => (
  <Card
    {...CARD_PROPS}
    className='!rounded-2xl'
    title={
      <div className='flex flex-col lg:flex-row lg:items-center lg:justify-between w-full gap-3'>
        <div className={FLEX_CENTER_GAP2}>
          {icon}
          <span className='text-sm font-semibold text-gray-900 dark:text-gray-100'>
            {title}
          </span>
        </div>
        <Tabs type='slash' activeKey={activeKey} onChange={onChange}>
          {tabs.map((tab) => (
            <TabPane
              key={tab.key}
              tab={<span>{tab.label}</span>}
              itemKey={tab.key}
            />
          ))}
        </Tabs>
      </div>
    }
    bodyStyle={{ padding: 0 }}
  >
    <div className='h-96 p-2'>
      <VChart spec={spec} option={CHART_CONFIG} />
    </div>
  </Card>
);

const ChartsPanel = ({
  spec_line,
  spec_model_line,
  spec_pie,
  spec_rank_bar,
  spec_user_rank,
  spec_user_trend,
  spec_token_line,
  spec_token_model_line,
  spec_token_pie,
  spec_token_rank_bar,
  spec_user_token_trend,
  isAdminUser,
  CARD_PROPS,
  CHART_CONFIG,
  FLEX_CENTER_GAP2,
  hasApiInfoPanel,
  t,
}) => {
  const [quotaTab, setQuotaTab] = useState('distribution');
  const [tokenTab, setTokenTab] = useState('distribution');

  const quotaTabs = [
    { key: 'distribution', label: t('消耗分布'), spec: spec_line },
    { key: 'trend', label: t('调用趋势'), spec: spec_model_line },
    { key: 'count_distribution', label: t('调用次数分布'), spec: spec_pie },
    { key: 'count_rank', label: t('调用次数排行'), spec: spec_rank_bar },
    ...(isAdminUser
      ? [
          { key: 'user_rank', label: t('用户消耗排行'), spec: spec_user_rank },
          { key: 'user_trend', label: t('用户消耗趋势'), spec: spec_user_trend },
        ]
      : []),
  ];

  const tokenTabs = [
    { key: 'distribution', label: t('消耗分布'), spec: spec_token_line },
    { key: 'trend', label: t('调用趋势'), spec: spec_token_model_line },
    { key: 'token_distribution', label: t('调用 Token 分布'), spec: spec_token_pie },
    { key: 'token_rank', label: t('调用 Token 排行'), spec: spec_token_rank_bar },
    ...(isAdminUser
      ? [
          {
            key: 'user_token_trend',
            label: t('用户消耗趋势'),
            spec: spec_user_token_trend,
          },
        ]
      : []),
  ];

  const quotaSpec =
    quotaTabs.find((tab) => tab.key === quotaTab)?.spec || spec_line;
  const tokenSpec =
    tokenTabs.find((tab) => tab.key === tokenTab)?.spec || spec_token_line;

  return (
    <div className={`space-y-4 ${hasApiInfoPanel ? 'lg:col-span-3' : ''}`}>
      <ChartCard
        title={t('模型消耗分布')}
        icon={<ChartColumn size={16} />}
        activeKey={quotaTab}
        onChange={setQuotaTab}
        tabs={quotaTabs}
        spec={quotaSpec}
        CARD_PROPS={CARD_PROPS}
        CHART_CONFIG={CHART_CONFIG}
        FLEX_CENTER_GAP2={FLEX_CENTER_GAP2}
      />
      <ChartCard
        title={t('模型 Token 用量分布')}
        icon={<BarChart2 size={16} />}
        activeKey={tokenTab}
        onChange={setTokenTab}
        tabs={tokenTabs}
        spec={tokenSpec}
        CARD_PROPS={CARD_PROPS}
        CHART_CONFIG={CHART_CONFIG}
        FLEX_CENTER_GAP2={FLEX_CENTER_GAP2}
      />
    </div>
  );
};

export default ChartsPanel;
