// =============================================================================
// 最小命令解析器（G5）
// =============================================================================
// CLI-Layer-Design §6 G5（行 336）：当前 handleCommand 是 switch(input.trim())，
// 无法处理 /entities --status candidate。需自写最小解析器（拆 token + 解析 --flag [val]），
// 不引入 CLI 框架。
//
// 解析规则（对齐 §2.1 行 81 示例）：
//   - 按空格 split token
//   - /cmd 开头为命令名
//   - --flag value：flag 后跟非 -- 开头的 token → flags[flag] = value
//   - --flag：flag 在末尾或后跟 --xxx → flags[flag] = true（开关型）
//   - 其余非 -- token 入 positional（含子命令，如 /project set 的 "set"）
//
// 示例：
//   '/entities --status candidate --raw'
//     → { name: '/entities', positional: [], flags: { status: 'candidate', raw: true } }
//   '/entity 沈墨 --raw'
//     → { name: '/entity', positional: ['沈墨'], flags: { raw: true } }
//   '/project set title 新标题'
//     → { name: '/project', positional: ['set', 'title', '新标题'], flags: {} }
//   '/audit --limit 50 --result failure'
//     → { name: '/audit', positional: [], flags: { limit: '50', result: 'failure' } }
// =============================================================================

/** 解析后的命令结构 */
export interface ParsedCommand {
  /** 命令名，如 '/entities'（第一个 token，去掉前导空格） */
  name: string;
  /** 位置参数（含子命令），如 ['set', 'title', '新标题'] */
  positional: string[];
  /** flag 映射：开关型为 true，带值型为字符串值 */
  flags: Record<string, string | boolean>;
}

/**
 * 解析一行用户输入为 ParsedCommand。
 *
 * 输入应为已 trim 的命令行（以 / 开头）。非命令输入（不以 / 开头）不应进入此函数。
 * 空输入返回 { name: '', positional: [], flags: {} }。
 *
 * 引号支持：双引号包裹的 token 作为一个整体（含空格），如 /entity "张 三" → ['张 三']。
 * 转义：引号内可用 \" 转义字面引号。
 */
export function parseCommand(input: string): ParsedCommand {
  const tokens = tokenize(input.trim());
  if (tokens.length === 0 || !tokens[0]!.text.startsWith('/')) {
    return { name: '', positional: [], flags: {} };
  }

  const name = tokens[0]!.text;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  // 从 index 1 开始遍历，识别 --flag 与位置参数
  // 关键：被引号包裹的 token（quoted=true）即使以 -- 开头也当位置参数，
  // 否则 "-- 反讽标题" 去引号后会误判为 flag。
  let i = 1;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    const isFlag = !tok.quoted && tok.text.startsWith('--');
    if (isFlag) {
      const flagName = tok.text.slice(2); // 去掉 --
      const next = tokens[i + 1];
      // 下一个 token 存在、未被引号包裹且不以 -- 开头 → 视为 flag 的值
      const nextIsValue = next !== undefined && !next.quoted && !next.text.startsWith('--');
      if (nextIsValue) {
        flags[flagName] = next!.text;
        i += 2; // 消费 flag + value
      } else {
        // 开关型 flag（无值，或值本身是另一个 --flag）
        flags[flagName] = true;
        i += 1;
      }
    } else {
      // 位置参数（含子命令，含被引号包裹的 --xxx 值）
      positional.push(tok.text);
      i += 1;
    }
  }

  return { name, positional, flags };
}

interface Token {
  text: string;
  /** 该 token 是否曾被双引号包裹（影响 flag 识别） */
  quoted: boolean;
}

/**
 * 词法分析：按空格拆分，但双引号内的内容（含空格）作为一个 token。
 * 支持转义 \" 。未闭合的引号按剩余全部内容作为一个 token（容错，不抛错）。
 * 返回的 Token 带 quoted 标记，用于区分 "--xxx"（值）与 --xxx（flag）。
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let current = '';
  let inQuotes = false;
  let tokenWasQuoted = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === '\\' && inQuotes && input[i + 1] === '"') {
      current += '"';
      i += 2;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      tokenWasQuoted = true;
      i += 1;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current.length > 0 || tokenWasQuoted) {
        tokens.push({ text: current, quoted: tokenWasQuoted });
        current = '';
        tokenWasQuoted = false;
      }
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.length > 0 || tokenWasQuoted) {
    tokens.push({ text: current, quoted: tokenWasQuoted });
  }
  return tokens;
}

/**
 * 从 flags 取字符串值（开关型返回 undefined）。
 * 工具函数：handler 内部读取 --status 等带值 flag。
 */
export function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * 从 flags 取数值（解析失败或缺失返回 undefined）。
 * 工具函数：handler 内部读取 --limit / --skip。
 */
export function flagNumber(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = flags[key];
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 从 flags 取布尔值（--flag 存在即 true）。
 * 工具函数：handler 内部读取 --raw / --debug。
 */
export function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
  return key in flags;
}
