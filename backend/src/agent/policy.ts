import { MAX_COUNT } from '../task-contract.ts';
import type { Params } from '../task-contract.ts';

export const POLICY_VERSION = 'explicit-command-v1';
export type Permission =
  | { action: 'submit'; params: Params }
  | { action: 'get' | 'stop'; targetId: string }
  | { action: 'none'; reason: string };

// 有限语法，不能从一句未理解的指令中抽取数字后忽略其余条件。
function chineseCount(text: string): number | undefined {
  const digits = '零一二三四五六七八九';
  if (text === '两') return 2;
  if (/^[一二三四五六七八九]$/.test(text)) return digits.indexOf(text);
  // 规范的一至九十九；其他中文数字请重新用阿拉伯数字给出完整指令。
  const match = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(text);
  if (!match) return undefined;
  return (match[1] ? digits.indexOf(match[1]) : 1) * 10 + (match[2] ? digits.indexOf(match[2]) : 0);
}

export function authorize(original: string, targetId?: string): Permission {
  const text = original.trim();
  const match = /^(?:请|帮我|请帮我)?\s*刷\s*1-7\s*([0-9]+|[零一二两三四五六七八九十]+)\s*次(?:\s*[，,]?\s*不吃药\s*[，,]?\s*不碎石)?\s*[。！!]?$/u.exec(text);
  if (match) {
    const count = /^[0-9]+$/.test(match[1]) ? Number(match[1]) : chineseCount(match[1]);
    if (count !== undefined && Number.isInteger(count) && count > 0 && count <= MAX_COUNT) {
      return { action: 'submit', params: { stage: '1-7', count, medicine: 0, premium: 0 } };
    }
  }
  if (targetId && /^(?:请)?(?:停止|停止当前任务|停止任务)\s*[。！!]?$/u.test(text)) {
    return { action: 'stop', targetId };
  }
  if (targetId && /^(?:请)?(?:查询|查询当前任务|查询任务|查看任务状态)\s*[。？?]?$/u.test(text)) {
    return { action: 'get', targetId };
  }
  return { action: 'none', reason: '本轮未获得可核对的操作授权。执行请重新给出完整指令，例如：帮我刷 1-7 10 次，不吃药不碎石；查询或停止须先选定任务。' };
}
