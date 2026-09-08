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

import React, { useContext, useState } from 'react';
import { Button, Typography, TextArea } from '@douyinfe/semi-ui';
import {
  IconCopy,
  IconKey,
  IconFile,
  IconDownload,
  IconRefresh,
  IconEdit,
} from '@douyinfe/semi-icons';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StatusContext } from '../../context/Status';
import { copy, showSuccess, showError } from '../../helpers';

const { Title, Text, Paragraph } = Typography;

const s = {
  copy: '\u590d\u5236',
  copied: '\u5df2\u590d\u5236\u5230\u526a\u5207\u677f',
  download: '\u4e0b\u8f7d',
  reset: '\u91cd\u7f6e',
  edit: '\u7f16\u8f91',
  badge: 'Codex \u914d\u7f6e\u6587\u6863',
  title: '\u6700\u5c0f\u624b\u52a8\u914d\u7f6e\uff1a\u53ea\u7ef4\u62a4\u4e24\u4e2a\u6587\u4ef6',
  intro:
    '\u624b\u52a8\u66ff\u4ee3 ccswitch \u65f6\uff0c\u53ea\u9700\u8981\u7ef4\u62a4 config.toml \u548c cc-switch-model-catalog.json\u3002\u53ef\u5728\u4e0b\u65b9\u76f4\u63a5\u7f16\u8f91\uff0c\u7f16\u8f91\u540e\u590d\u5236\u6216\u4e0b\u8f7d\u5373\u53ef\u4f7f\u7528\u3002cc-switch-model-catalog.json \u4f7f\u7528\u540c\u4e00\u4e2a models \u6570\u7ec4\u58f0\u660e\u591a\u4e2a\u6a21\u578b\uff0c\u672c\u5730\u5df2\u9a8c\u8bc1\u53ef\u540c\u65f6\u663e\u793a gpt-5.5\u3001MiniMax-M3\u3001glm-5.2\u3002\u5176\u4e2d gpt-5.5 \u4e0e MiniMax-M3 \u652f\u6301\u591a\u6a21\u6001\u56fe\u7247\u8f93\u5165\u3002',
  getKey: '\u83b7\u53d6\u5bc6\u94a5',
  step1Title: '1. \u83b7\u53d6\u5bc6\u94a5',
  step1Text: '\u5148\u5728\u63a7\u5236\u53f0\u521b\u5efa\u6216\u590d\u5236\u53ef\u7528\u5bc6\u94a5\u3002',
  step2Title: '2. \u7f16\u8f91 config.toml',
  step2Text: '\u9ed8\u8ba4\u6a21\u578b\u4e3a gpt-5.5\uff0c\u53ef\u6539\u4e3a glm-5.2 \u6216 MiniMax-M3\u3002',
  step3Title: '3. \u786e\u8ba4\u6a21\u578b\u76ee\u5f55',
  step3Text: '\u6a21\u578b\u76ee\u5f55\u9ed8\u8ba4\u5305\u542b gpt-5.5\u3001MiniMax-M3\u3001glm-5.2\uff0c\u4e14\u90fd\u5728\u540c\u4e00\u4e2a models \u6570\u7ec4\u91cc\u3002',
  relationTitle: '\u4e24\u4e2a\u6587\u4ef6\u7684\u5173\u7cfb',
  configDesc: '\u8d1f\u8d23 provider\u3001\u63a5\u53e3\u5730\u5740\u3001\u5bc6\u94a5\u3001\u9ed8\u8ba4\u6a21\u578b\u548c\u6a21\u578b\u5217\u8868\u6587\u4ef6\u3002',
  catalogDesc: '\u8d1f\u8d23\u58f0\u660e\u9ed8\u8ba4\u53ef\u7528\u7684\u4e09\u4e2a\u6a21\u578b\u3001\u6a21\u578b slug\u3001\u4e0a\u4e0b\u6587\u5927\u5c0f\u548c\u591a\u6a21\u6001\u80fd\u529b\u5b57\u6bb5\u3002',
  rule:
    '\u5173\u952e\u89c4\u5219\uff1aconfig.toml \u91cc\u7684 model \u53ea\u51b3\u5b9a\u9ed8\u8ba4\u9009\u4e2d\u54ea\u4e2a\u6a21\u578b\uff0c\u4e0d\u4f1a\u9650\u5236\u6a21\u578b\u5217\u8868\u53ea\u663e\u793a\u4e00\u4e2a\u3002\u591a\u6a21\u578b\u8981\u5199\u5728 cc-switch-model-catalog.json \u7684\u540c\u4e00\u4e2a models \u6570\u7ec4\u4e2d\uff0c\u6bcf\u4e2a models[].slug \u5fc5\u987b\u552f\u4e00\u3002gpt-5.5 \u4e0e MiniMax-M3 \u7684 input_modalities \u4e3a ["text", "image"]\u3002',
  file1: '\u6587\u4ef6 1\uff1aconfig.toml',
  file1Desc: '\u6700\u5c0f\u914d\u7f6e\u53ea\u4fdd\u7559 provider\u3001\u9ed8\u8ba4\u6a21\u578b\u3001\u6a21\u578b\u76ee\u5f55\u3001\u63a5\u53e3\u5730\u5740\u548c\u5bc6\u94a5\u3002\u53ef\u5728\u4e0b\u65b9\u76f4\u63a5\u7f16\u8f91\u3002',
  file2: '\u6587\u4ef6 2\uff1acc-switch-model-catalog.json',
  file2Desc:
    '\u672c\u5730\u5df2\u9a8c\u8bc1\u53ef\u663e\u793a\u591a\u4e2a\u6a21\u578b\u7684 models \u6570\u7ec4\u5199\u6cd5\u3002\u793a\u4f8b\u5305\u542b gpt-5.5\u3001MiniMax-M3\u3001glm-5.2\uff1bgpt-5.5 \u4e0e MiniMax-M3 \u7684 input_modalities \u5305\u542b image\u3002\u53ef\u5728\u4e0b\u65b9\u76f4\u63a5\u7f16\u8f91\u3002',
  commonTitle: '\u5e38\u89c1\u4fee\u6539\u65b9\u5f0f',
  changeDefault: '\u6362\u9ed8\u8ba4\u6a21\u578b\uff1a\u7f16\u8f91 config.toml \u91cc\u7684 model\u3002',
  switchModel: '\u5207\u6362\u5230\u5df2\u9ed8\u8ba4\u914d\u7f6e\u7684\u6a21\u578b\uff1a\u628a config.toml \u7684 model \u6539\u4e3a glm-5.2 \u6216 MiniMax-M3\u3002',
  changeBaseUrl: '\u6362\u63a5\u53e3\u670d\u52a1\uff1a\u7f16\u8f91 config.toml \u91cc\u7684 base_url\u3002',
  changeToken: '\u6362\u5bc6\u94a5\uff1a\u7f16\u8f91 config.toml \u91cc\u7684 experimental_bearer_token\u3002',
  restart: '\u4fee\u6539\u5b8c\u6210\u540e\uff0c\u590d\u5236\u6216\u4e0b\u8f7d\u6587\u4ef6\uff0c\u91cd\u542f Codex \u8ba9\u914d\u7f6e\u751f\u6548\u3002',
  officialTitle: '\u5207\u6362\u4e3a\u5b98\u7f51 OpenAI',
  officialDesc: '\u5982\u9700\u5207\u56de\u5b98\u7f51\uff0c\u5c06 config.toml \u6539\u4e3a\u4ee5\u4e0b\u914d\u7f6e\uff0c\u4e0d\u518d\u9700\u8981 cc-switch-model-catalog.json\u3002',
};

const downloadFile = (filename, content) => {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const EditableCodeBlock = ({ title, description, value, filename }) => {
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);

  const handleReset = () => {
    setText(value);
    setEditing(false);
    showSuccess('\u5df2\u91cd\u7f6e\u4e3a\u9ed8\u8ba4\u6a21\u677f');
  };

  const handleDownload = () => {
    downloadFile(filename, text);
    showSuccess('\u5df2\u4e0b\u8f7d ' + filename);
  };

  const handleCopy = async () => {
    const ok = await copy(text);
    if (ok) {
      showSuccess(s.copied);
    } else {
      showError('\u590d\u5236\u5931\u8d25');
    }
  };

  return (
    <div className='rounded-xl border border-semi-color-border bg-semi-color-bg-1 p-5 shadow-sm'>
      <div className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'>
        <div>
          <div className='text-lg font-semibold text-semi-color-text-0'>
            {title}
          </div>
          <div className='mt-1 text-sm text-semi-color-text-2'>{description}</div>
        </div>
        <div className='flex flex-wrap gap-2'>
          <Button
            size='small'
            theme={editing ? 'solid' : 'light'}
            type={editing ? 'primary' : 'tertiary'}
            icon={<IconEdit />}
            onClick={() => setEditing(!editing)}
          >
            {s.edit}
          </Button>
          <Button size='small' icon={<IconCopy />} onClick={handleCopy}>
            {s.copy}
          </Button>
          <Button size='small' icon={<IconDownload />} onClick={handleDownload}>
            {s.download}
          </Button>
          <Button size='small' icon={<IconRefresh />} onClick={handleReset}>
            {s.reset}
          </Button>
        </div>
      </div>
      {editing ? (
        <TextArea
          value={text}
          onChange={setText}
          autosize={{ minRows: 12, maxRows: 30 }}
          className='mt-4'
          style={{
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: '12px',
            lineHeight: '20px',
          }}
        />
      ) : (
        <pre className='mt-4 max-h-[520px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-semi-color-fill-0 p-4 text-xs leading-5 text-semi-color-text-1'>
          {text}
        </pre>
      )}
    </div>
  );
};

const createModel = ({ slug, description, contextWindow, inputModalities, supportsImage, priority }) => ({
  slug,
  display_name: slug,
  description,
  context_window: contextWindow,
  max_context_window: contextWindow,
  effective_context_window_percent: 95,
  default_reasoning_level: 'high',
  default_reasoning_summary: 'none',
  supported_reasoning_levels: [
    { effort: 'none', description: 'Disable Thinking' },
    { effort: 'high', description: 'Enabled Thinking' },
  ],
  input_modalities: inputModalities,
  supported_in_api: true,
  supports_reasoning_summaries: true,
  supports_parallel_tool_calls: false,
  supports_search_tool: false,
  supports_image_detail_original: supportsImage,
  support_verbosity: false,
  service_tiers: [],
  additional_speed_tiers: [],
  experimental_supported_tools: [],
  shell_type: 'shell_command',
  priority,
  visibility: 'list',
  truncation_policy: { mode: 'bytes', limit: 10000 },
  upgrade: null,
  availability_nux: null,
  base_instructions:
    'You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user\'s goals.',
});

const Docs = () => {
  const { t } = useTranslation();
  const [statusState] = useContext(StatusContext);
  const serverAddress =
    statusState?.status?.server_address || `${window.location.origin}`;
  const normalizedServerAddress = serverAddress.replace(/\/$/, '');

  const configToml = `model_provider = "custom"
model = "gpt-5.5"
model_catalog_json = "cc-switch-model-catalog.json"
model_reasoning_effort = "high"

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "${normalizedServerAddress}/v1"
experimental_bearer_token = "sk-\u4f60\u7684\u5bc6\u94a5"`;

  const officialConfigToml = `model_provider = "openai"
model = "gpt-5.5"
model_reasoning_effort = "medium"`;

  const modelCatalog = JSON.stringify(
    {
      models: [
        createModel({
          slug: 'gpt-5.5',
          description: '\u9ed8\u8ba4\u6a21\u578b\uff0c\u652f\u6301\u6587\u672c\u4e0e\u56fe\u7247\u8f93\u5165',
          contextWindow: 500000,
          inputModalities: ['text', 'image'],
          supportsImage: true,
          priority: 1000,
        }),
        createModel({
          slug: 'MiniMax-M3',
          description: '\u5df2\u9ed8\u8ba4\u914d\u7f6e\u7684\u591a\u6a21\u6001\u6a21\u578b\uff0c\u652f\u6301\u6587\u672c\u4e0e\u56fe\u7247\u8f93\u5165',
          contextWindow: 500000,
          inputModalities: ['text', 'image'],
          supportsImage: true,
          priority: 1001,
        }),
        createModel({
          slug: 'glm-5.2',
          description: '\u5df2\u9ed8\u8ba4\u914d\u7f6e\u7684\u6587\u672c\u6a21\u578b',
          contextWindow: 500000,
          inputModalities: ['text'],
          supportsImage: false,
          priority: 1002,
        }),
      ],
    },
    null,
    2,
  );

  return (
    <div className='min-h-screen bg-semi-color-bg-0 px-4 py-10 md:px-8 md:py-14'>
      <div className='mx-auto max-w-5xl'>
        <div className='mb-8 rounded-2xl border border-semi-color-border bg-semi-color-bg-1 p-6 md:p-8'>
          <div className='mb-4 inline-flex items-center gap-2 rounded-full bg-semi-color-fill-0 px-3 py-1 text-sm text-semi-color-text-1'>
            <IconFile />
            {s.badge}
          </div>
          <Title heading={2} className='!mb-3'>
            {s.title}
          </Title>
          <Paragraph className='!mb-5 !text-base !text-semi-color-text-1'>
            {s.intro}
          </Paragraph>
          <div className='grid gap-3 md:grid-cols-3'>
            <div className='rounded-xl bg-semi-color-fill-0 p-4'>
              <div className='text-sm font-semibold text-semi-color-text-0'>
                {s.step1Title}
              </div>
              <Text type='tertiary' size='small'>
                {s.step1Text}
              </Text>
            </div>
            <div className='rounded-xl bg-semi-color-fill-0 p-4'>
              <div className='text-sm font-semibold text-semi-color-text-0'>
                {s.step2Title}
              </div>
              <Text type='tertiary' size='small'>
                {s.step2Text}
              </Text>
            </div>
            <div className='rounded-xl bg-semi-color-fill-0 p-4'>
              <div className='text-sm font-semibold text-semi-color-text-0'>
                {s.step3Title}
              </div>
              <Text type='tertiary' size='small'>
                {s.step3Text}
              </Text>
            </div>
          </div>
          <div className='mt-6'>
            <Link to='/console'>
              <Button theme='solid' type='primary' icon={<IconKey />}>
                {t(s.getKey)}
              </Button>
            </Link>
          </div>
        </div>

        <div className='mb-6 rounded-xl border border-semi-color-border bg-semi-color-bg-1 p-5'>
          <div className='text-lg font-semibold text-semi-color-text-0'>
            {s.relationTitle}
          </div>
          <div className='mt-3 grid gap-3 md:grid-cols-2'>
            <div className='rounded-lg bg-semi-color-fill-0 p-4'>
              <div className='font-medium text-semi-color-text-0'>
                config.toml
              </div>
              <div className='mt-1 text-sm text-semi-color-text-2'>
                {s.configDesc}
              </div>
            </div>
            <div className='rounded-lg bg-semi-color-fill-0 p-4'>
              <div className='font-medium text-semi-color-text-0'>
                cc-switch-model-catalog.json
              </div>
              <div className='mt-1 text-sm text-semi-color-text-2'>
                {s.catalogDesc}
              </div>
            </div>
          </div>
          <div className='mt-4 rounded-lg bg-semi-color-primary-light-default p-4 text-sm text-semi-color-text-1'>
            {s.rule}
          </div>
        </div>

        <div className='grid gap-6'>
          <EditableCodeBlock
            title={s.file1}
            description={s.file1Desc}
            value={configToml}
            filename='config.toml'
          />
          <EditableCodeBlock
            title={s.file2}
            description={s.file2Desc}
            value={modelCatalog}
            filename='cc-switch-model-catalog.json'
          />
        </div>

        <div className='mt-6 rounded-xl border border-semi-color-border bg-semi-color-bg-1 p-5'>
          <div className='text-lg font-semibold text-semi-color-text-0'>
            {s.commonTitle}
          </div>
          <ul className='mt-3 list-disc space-y-2 pl-5 text-sm text-semi-color-text-1'>
            <li>{s.changeDefault}</li>
            <li>{s.switchModel}</li>
            <li>{s.changeBaseUrl}</li>
            <li>{s.changeToken}</li>
            <li>{s.restart}</li>
          </ul>
        </div>

        <div className='mt-6'>
          <EditableCodeBlock
            title={s.officialTitle}
            description={s.officialDesc}
            value={officialConfigToml}
            filename='config.toml'
          />
        </div>
      </div>
    </div>
  );
};

export default Docs;

