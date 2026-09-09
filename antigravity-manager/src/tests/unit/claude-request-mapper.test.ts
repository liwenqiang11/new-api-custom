import { describe, expect, it } from 'vitest';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { normalizeObjectJsonSchema } from '@/modules/proxy-gateway/antigravity/JsonSchemaUtils';

describe('transformClaudeRequestIn', () => {
  it('adds an item schema to nested arrays without items', () => {
    const schema = normalizeObjectJsonSchema({
      type: 'object',
      properties: {
        query: {
          type: 'object',
          properties: {
            where: { type: 'array' },
          },
        },
      },
    });

    expect(schema.properties).toEqual({
      query: {
        type: 'object',
        properties: {
          where: { type: 'array', items: { type: 'string' } },
        },
      },
    });
  });

  it('does not include sessionId in Gemini internal payload for Claude requests', () => {
    const payload = transformClaudeRequestIn({
      model: 'claude-sonnet-4-6',
      stream: true,
      max_tokens: 256,
      metadata: {
        user_id: 'user-session-123',
      },
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(payload).not.toHaveProperty('sessionId');
  });

  it('does not inject default stop sequences for Anthropic requests targeting Gemini models', () => {
    const payload = transformClaudeRequestIn({
      model: 'gemini-3.1-pro-high',
      stream: true,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(payload.request.generationConfig?.stopSequences).toBeUndefined();
  });

  it('preserves explicit stop sequences when provided by the caller', () => {
    const payload = transformClaudeRequestIn({
      model: 'gemini-3.1-pro-high',
      stream: true,
      max_tokens: 256,
      stop_sequences: ['END'],
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(payload.request.generationConfig?.stopSequences).toEqual(['END']);
  });

  it('filters Claude Code protocol sentinel stop sequences that can truncate code explanations', () => {
    const payload = transformClaudeRequestIn({
      model: 'gemini-3.1-pro-low',
      stream: true,
      max_tokens: 256,
      stop_sequences: ['<|user|>', '<|endoftext|>', '<|end_of_turn|>', '[DONE]', 'END'],
      messages: [{ role: 'user', content: 'Explain config.stopSequences' }],
    });

    expect(payload.request.generationConfig?.stopSequences).toEqual(['END']);
  });

  it('disables thinking and drops unsigned thought blocks for tool turns', () => {
    const rawSignature = '\u53e3&$e24830a7-5cd6-42fe-998b-ee539e72b9c3';
    const payload = transformClaudeRequestIn({
      model: 'gemini-3.1-pro-low',
      stream: true,
      max_tokens: 256,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'prior reasoning', signature: rawSignature },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Read',
              input: { file_path: 'C:\\tmp\\a.ts' },
            },
          ],
        },
      ],
    });

    const toolPart = payload.request.contents[0].parts[0];

    expect(payload.request.generationConfig?.thinkingConfig).toBeUndefined();
    expect(toolPart.thoughtSignature).toBeUndefined();
  });

  it('preserves valid base64 thought signatures for Gemini bytes JSON', () => {
    const rawSignature = 'valid upstream signature';
    const base64Signature = Buffer.from(rawSignature, 'utf-8').toString('base64');
    const payload = transformClaudeRequestIn({
      model: 'gemini-3.1-pro-low',
      stream: true,
      max_tokens: 256,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'prior reasoning', signature: base64Signature }],
        },
      ],
    });

    const thinkingPart = payload.request.contents[0].parts[0];

    expect(thinkingPart.thoughtSignature).toBe(base64Signature);
  });

  it('does not synthesize a thought signature for Gemini function calls', () => {
    const payload = transformClaudeRequestIn({
      model: 'gemini-3-flash',
      stream: true,
      max_tokens: 256,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Read',
              input: { file_path: 'C:\\tmp\\a.ts' },
            },
          ],
        },
      ],
    });

    const toolPart = payload.request.contents[0].parts[0];

    expect(payload.request.generationConfig?.thinkingConfig).toBeUndefined();
    expect(toolPart.thoughtSignature).toBeUndefined();
  });

  it('omits sampling parameters when Gemini thinking is enabled on Anthropic path', () => {
    const payload = transformClaudeRequestIn({
      model: 'gemini-3.1-pro-low',
      stream: true,
      max_tokens: 256,
      temperature: 0,
      top_p: 0.8,
      top_k: 40,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(payload.request.generationConfig?.thinkingConfig).toBeDefined();
    expect(payload.request.generationConfig?.temperature).toBeUndefined();
    expect(payload.request.generationConfig?.topP).toBeUndefined();
    expect(payload.request.generationConfig?.topK).toBeUndefined();
  });

  it('omits default OpenAI sampling parameters when Gemini thinking is enabled', () => {
    const payload = transformClaudeRequestIn({
      model: 'gemini-3.1-pro-low',
      stream: true,
      max_tokens: 256,
      metadata: { source: 'openai' },
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(payload.request.generationConfig?.thinkingConfig).toBeDefined();
    expect(payload.request.generationConfig?.temperature).toBeUndefined();
    expect(payload.request.generationConfig?.topP).toBeUndefined();
    expect(payload.request.generationConfig?.topK).toBeUndefined();
  });
});
