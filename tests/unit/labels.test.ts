// =============================================================================
// labels.ts 单元测试——枚举→中文标签映射
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  projectStatusLabel, workspaceModeLabel, draftStatusLabel, decisionKindLabel,
} from '../../src/writing/view-models/labels.js';

describe('labels.ts 标签映射', () => {
  describe('projectStatusLabel', () => {
    it('已知枚举返回中文标签', () => {
      expect(projectStatusLabel('planning')).toBe('构思中');
      expect(projectStatusLabel('drafting')).toBe('写作中');
      expect(projectStatusLabel('reviewing')).toBe('审核中');
      expect(projectStatusLabel('paused')).toBe('已暂停');
      expect(projectStatusLabel('archived')).toBe('已归档');
    });
    it('未知枚举降级为原始字符串', () => {
      expect(projectStatusLabel('unknown_status')).toBe('unknown_status');
    });
  });

  describe('workspaceModeLabel', () => {
    it('已知枚举返回中文标签', () => {
      expect(workspaceModeLabel('planning')).toBe('规划');
      expect(workspaceModeLabel('writing')).toBe('写作');
      expect(workspaceModeLabel('reviewing')).toBe('审核');
      expect(workspaceModeLabel('analysis')).toBe('分析');
      expect(workspaceModeLabel('importing')).toBe('导入');
    });
    it('未知枚举降级为原始字符串', () => {
      expect(workspaceModeLabel('debug')).toBe('debug');
    });
  });

  describe('draftStatusLabel', () => {
    it('已知枚举返回中文标签', () => {
      expect(draftStatusLabel('drafting')).toBe('起草中');
      expect(draftStatusLabel('ready_to_simulate')).toBe('可推演');
      expect(draftStatusLabel('simulated')).toBe('已推演');
      expect(draftStatusLabel('committed')).toBe('已提交');
      expect(draftStatusLabel('archived')).toBe('已归档');
      expect(draftStatusLabel('error')).toBe('出错');
    });
    it('未知枚举降级为原始字符串', () => {
      expect(draftStatusLabel('unknown')).toBe('unknown');
    });
  });

  describe('decisionKindLabel', () => {
    it('已知枚举返回中文标签', () => {
      expect(decisionKindLabel('confirm_entity')).toBe('实体注册');
      expect(decisionKindLabel('confirm_draft')).toBe('草案确认');
      expect(decisionKindLabel('confirm_proposal')).toBe('提案审核');
      expect(decisionKindLabel('confirm_retcon')).toBe('修订审核');
      expect(decisionKindLabel('confirm_blueprint')).toBe('蓝图确认');
      expect(decisionKindLabel('confirm_rule')).toBe('规则确认');
      expect(decisionKindLabel('general')).toBe('通用事项');
    });
    it('未知枚举降级为原始字符串', () => {
      expect(decisionKindLabel('custom_kind')).toBe('custom_kind');
    });
  });
});
