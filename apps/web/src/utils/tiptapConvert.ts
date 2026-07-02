// =============================================================================
// TipTap JSON ↔ 纯文本 / Markdown 转换工具（纯前端，无依赖）
// =============================================================================
// 用途：
//   - plainTextToTiptapDoc：导入 txt/md 时把文本切成 TipTap 段落结构
//   - tiptapDocToMarkdown：文档导出为 .md
//   - tiptapDocToPlainText：复制 / 字数统计 / 粗略预览
//   - tiptapJsonStringToPlainText：包装层，处理 content 可能是 JSON 串或 HTML 串
//
// 设计取舍：这是"够用"的转换，不追求 100% Round-trip 保真。
// 复杂嵌套（列表里的引用等）按扁平化处理，保证作者拿到的 Markdown 可读即可。

/** TipTap 节点的最小类型（避免引入 @tiptap/pm 的重量类型） */
interface TiptapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
}

// ---------------------------------------------------------------------------
// 纯文本 → TipTap JSON
// ---------------------------------------------------------------------------

/**
 * 把纯文本切分为 TipTap doc。
 * 规则（兼容 markdown 简写）：
 *   - `# ` 开头 → h1，`## ` → h2，`### ` → h3
 *   - `> ` 开头 → blockquote（连续 > 行合并）
 *   - `***` / `---` / `* * *` → horizontalRule
 *   - `- ` / `* ` 开头 → bulletList 子项
 *   - `1. ` 数字序号 → orderedList 子项
 *   - 空行分段；其余连续非空行合并为一段
 */
export function plainTextToTiptapDoc(text: string): TiptapNode {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const content: TiptapNode[] = [];
  let i = 0;

  const flushParagraph = (buf: string[]) => {
    if (buf.length === 0) return;
    content.push({ type: 'paragraph', content: [{ type: 'text', text: buf.join('\n') }] });
    buf.length = 0;
  };

  let paraBuf: string[] = [];

  while (i < lines.length) {
    const raw = lines[i]!;
    const line = raw.trimEnd();

    // 分隔线
    if (/^(\*\*\*|---|\*\s\*\s\*)$/.test(line.trim())) {
      flushParagraph(paraBuf);
      content.push({ type: 'horizontalRule' });
      i++;
      continue;
    }

    // 标题
    const headingMatch = /^(#{1,3})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushParagraph(paraBuf);
      const level = headingMatch[1]!.length;
      content.push({
        type: 'heading', attrs: { level },
        content: [{ type: 'text', text: headingMatch[2]!.trim() }],
      });
      i++;
      continue;
    }

    // 引用（连续 > 行合并为一段引用）
    if (/^>\s?/.test(line)) {
      flushParagraph(paraBuf);
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!.trimEnd())) {
        quoteLines.push(lines[i]!.replace(/^>\s?/, ''));
        i++;
      }
      content.push({
        type: 'blockquote',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: quoteLines.join('\n') }] }],
      });
      continue;
    }

    // 无序列表
    if (/^[-*+]\s+/.test(line)) {
      flushParagraph(paraBuf);
      const items: TiptapNode[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i]!.trimEnd())) {
        const itemText = lines[i]!.replace(/^[-*+]\s+/, '');
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: itemText }] }] });
        i++;
      }
      content.push({ type: 'bulletList', content: items });
      continue;
    }

    // 有序列表
    if (/^\d+\.\s+/.test(line)) {
      flushParagraph(paraBuf);
      const items: TiptapNode[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!.trimEnd())) {
        const itemText = lines[i]!.replace(/^\d+\.\s+/, '');
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: itemText }] }] });
        i++;
      }
      content.push({ type: 'orderedList', content: items });
      continue;
    }

    // 空行 → 段落分隔
    if (line.trim() === '') {
      flushParagraph(paraBuf);
      i++;
      continue;
    }

    // 普通文本：累积成段
    paraBuf.push(line);
    i++;
  }
  flushParagraph(paraBuf);

  // 空内容兜底：给一个空段落，保证编辑器有可聚焦节点
  if (content.length === 0) content.push({ type: 'paragraph' });
  return { type: 'doc', content };
}

// ---------------------------------------------------------------------------
// TipTap JSON → 纯文本
// ---------------------------------------------------------------------------

/** 递归提取 TipTap 节点的纯文本（段落间换行，列表项前加标记） */
export function tiptapDocToPlainText(node: TiptapNode): string {
  return docToText(node).trim();
}

function docToText(node: TiptapNode): string {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  if (!node.content) return '';

  // 块级节点之间用什么分隔
  const blockSep = node.type === 'doc' ? '\n\n' : '\n';

  const parts = node.content.map((child: TiptapNode): string => {
    const inner = docToText(child);
    switch (child.type) {
      case 'heading':
        return '#'.repeat(Number(child.attrs?.level ?? 1)) + ' ' + inner;
      case 'blockquote':
        return inner.split('\n').map(l => '> ' + l).join('\n');
      case 'bulletList':
        return child.content?.map(li => '- ' + docToText(li)).join('\n') ?? '';
      case 'orderedList':
        return child.content?.map((li, idx) => `${idx + 1}. ${docToText(li)}`).join('\n') ?? '';
      case 'horizontalRule':
        return '---';
      case 'paragraph':
      case 'listItem':
      default:
        return inner;
    }
  });
  return parts.join(blockSep);
}

// ---------------------------------------------------------------------------
// TipTap JSON → Markdown（含行内标记）
// ---------------------------------------------------------------------------

/** TipTap JSON → Markdown 文本 */
export function tiptapDocToMarkdown(node: TiptapNode): string {
  return docToMarkdown(node).trim() + '\n';
}

function docToMarkdown(node: TiptapNode): string {
  if (!node) return '';
  if (node.type === 'text') return applyMarks(node.text ?? '', node.marks);
  if (!node.content) return '';

  const blockSep = node.type === 'doc' ? '\n\n' : '\n';
  const parts = node.content.map((child: TiptapNode): string => {
    const inner = docToMarkdown(child);
    switch (child.type) {
      case 'heading':
        return '#'.repeat(Number(child.attrs?.level ?? 1)) + ' ' + inner;
      case 'blockquote':
        return inner.split('\n').map(l => '> ' + l).join('\n');
      case 'bulletList':
        return child.content?.map(li => '- ' + docToMarkdown(li).trim()).join('\n') ?? '';
      case 'orderedList':
        return child.content?.map((li, idx) => `${idx + 1}. ${docToMarkdown(li).trim()}`).join('\n') ?? '';
      case 'horizontalRule':
        return '---';
      case 'paragraph':
      case 'listItem':
      default:
        return inner;
    }
  });
  return parts.join(blockSep);
}

/** 应用行内标记（粗体/斜体/删除线/代码） */
function applyMarks(text: string, marks?: Array<{ type: string }>): string {
  if (!marks || marks.length === 0) return text;
  let out = text;
  for (const m of marks) {
    switch (m.type) {
      case 'bold': out = `**${out}**`; break;
      case 'italic': out = `*${out}*`; break;
      case 'strike': out = `~~${out}~~`; break;
      case 'code': out = '`' + out + '`'; break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 容错解析：content 字段可能是 TipTap JSON 串 / HTML 串 / 纯文本
// ---------------------------------------------------------------------------

/**
 * 把文档 content 字段转成纯文本（用于复制、字数、状态栏）。
 * - TipTap JSON 串（以 { 开头）→ 解析后提取
 * - HTML 串 → 去标签
 * - 纯文本 → 原样
 */
export function contentStringToPlainText(content: string | undefined | null): string {
  if (!content) return '';
  const c = content.trim();
  if (c.startsWith('{')) {
    try {
      return tiptapDocToPlainText(JSON.parse(c) as TiptapNode);
    } catch {
      /* fall through */
    }
  }
  // HTML 去标签
  if (/<[^>]+>/.test(c)) return c.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return content;
}

/** 把文档 content 字段转成 Markdown（用于导出） */
export function contentStringToMarkdown(content: string | undefined | null): string {
  if (!content) return '';
  const c = content.trim();
  if (c.startsWith('{')) {
    try {
      return tiptapDocToMarkdown(JSON.parse(c) as TiptapNode);
    } catch {
      /* fall through */
    }
  }
  // HTML / 纯文本 → 当纯文本返回
  return c.replace(/<[^>]+>/g, '') + '\n';
}
