// =============================================================================
// Agent 工具权限门控单元测试（W1）
// =============================================================================
// 纯函数测试，不依赖数据库 / LLM / API key，确保门控判定逻辑确定且可回归。
// 运行时（LLM 真发起 commit_event 被拦）的验证见 commit-gate.test.ts。

import { describe, it, expect } from 'vitest';
import {
  AGENT_FORBIDDEN_TOOLS,
  isToolForbiddenForAgent,
  makeForbiddenToolError,
  forbiddenToolResult,
} from '../../src/writing/agent/tool-permissions.js';
import { ToolErrorCode } from '../../src/types/tool.js';

describe('Agent 工具权限门控（W1）', () => {
  // ---------------------------------------------------------------------------
  // 禁止集合判定
  // ---------------------------------------------------------------------------

  it('commit_event 应在禁止集合中', () => {
    expect(isToolForbiddenForAgent('commit_event')).toBe(true);
    expect(AGENT_FORBIDDEN_TOOLS.has('commit_event')).toBe(true);
  });

  it('只读 / 沙盒工具不应被禁止（Agent 可自由调用）', () => {
    expect(isToolForbiddenForAgent('get_context_slice')).toBe(false);
    expect(isToolForbiddenForAgent('propose_event')).toBe(false);
    expect(isToolForbiddenForAgent('get_open_threads')).toBe(false);
  });

  it('未知工具名不应被禁止——门控只拦截明确列入禁止集合的项', () => {
    expect(isToolForbiddenForAgent('some_random_tool')).toBe(false);
    expect(isToolForbiddenForAgent('')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 错误对象构造
  // ---------------------------------------------------------------------------

  it('makeForbiddenToolError 产出不可重试的 AGENT_COMMIT_FORBIDDEN 错误', () => {
    const err = makeForbiddenToolError('commit_event');
    expect(err.code).toBe(ToolErrorCode.AGENT_COMMIT_FORBIDDEN);
    // retryable=false 是关键：防止 LLM 把权限拒绝当成可修复错误反复重试
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('commit_event');
    expect(err.correctionHint).toBeTruthy();
  });

  it('forbiddenToolResult 返回 success:false 失败结果，携带同一错误', () => {
    const result = forbiddenToolResult('commit_event');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(ToolErrorCode.AGENT_COMMIT_FORBIDDEN);
      expect(result.error.retryable).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------
  // register_entity 拦截（§25 #7，2026-06-18 并入禁止集合）
  // ---------------------------------------------------------------------------

  it('register_entity 应在禁止集合中（§25 #7：Agent 不得直接注册实体）', () => {
    expect(isToolForbiddenForAgent('register_entity')).toBe(true);
    expect(AGENT_FORBIDDEN_TOOLS.has('register_entity')).toBe(true);
  });

  it('register_entity 的错误码是 AGENT_REGISTER_FORBIDDEN（区别于提交类）', () => {
    const err = makeForbiddenToolError('register_entity');
    expect(err.code).toBe(ToolErrorCode.AGENT_REGISTER_FORBIDDEN);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('register_entity');
    expect(err.message).toContain('审核通道');
    expect(err.correctionHint).toContain('detect_entity_hints');
  });

  it('commit_event 与 register_entity 的错误码不同（语义区分）', () => {
    expect(makeForbiddenToolError('commit_event').code).toBe(ToolErrorCode.AGENT_COMMIT_FORBIDDEN);
    expect(makeForbiddenToolError('register_entity').code).toBe(ToolErrorCode.AGENT_REGISTER_FORBIDDEN);
  });
});
