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

import React from 'react';
import { Button, Select, Tooltip } from '@douyinfe/semi-ui';
import { RefreshCw, Search } from 'lucide-react';

const DashboardHeader = ({
  getGreeting,
  greetingVisible,
  showSearchModal,
  datePreset,
  datePresetOptions,
  onDatePresetChange,
  refresh,
  loading,
  t,
}) => {
  const ICON_BUTTON_CLASS = 'text-white hover:bg-opacity-80 !rounded-full';

  return (
    <div className='flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-4'>
      <h2
        className='text-2xl font-semibold text-gray-800 transition-opacity duration-1000 ease-in-out'
        style={{ opacity: greetingVisible ? 1 : 0 }}
      >
        {getGreeting}
      </h2>
      <div className='flex flex-wrap items-center gap-3'>
        <Tooltip content={t('日期范围仅影响统计次数、资源消耗和图表')}>
          <Select
            value={datePreset}
            optionList={datePresetOptions}
            onChange={onDatePresetChange}
            className='w-36'
          />
        </Tooltip>
        <Button
          type='tertiary'
          icon={<Search size={16} />}
          onClick={showSearchModal}
          className={`bg-green-500 hover:bg-green-600 ${ICON_BUTTON_CLASS}`}
        />
        <Button
          type='tertiary'
          icon={<RefreshCw size={16} />}
          onClick={refresh}
          loading={loading}
          className={`bg-blue-500 hover:bg-blue-600 ${ICON_BUTTON_CLASS}`}
        />
      </div>
    </div>
  );
};

export default DashboardHeader;
