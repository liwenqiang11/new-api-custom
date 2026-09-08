import { describe, expect, it } from 'vitest';
import { StreamingState } from '@/modules/proxy-gateway/antigravity/ClaudeStreamingMapper';

describe('StreamingState.emitMessageStart', () => {
  it('always includes a usage object even when usageMetadata is missing', () => {
    const state = new StreamingState();
    const chunk = state.emitMessageStart({
      responseId: 'msg_test',
      modelVersion: 'claude-sonnet-4-6',
    });

    const dataLine = chunk
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);

    expect(dataLine).toBeTruthy();
    const payload = JSON.parse(dataLine as string);
    expect(payload.message.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
    });
  });
});
