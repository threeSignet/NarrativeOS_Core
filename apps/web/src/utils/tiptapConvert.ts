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

/**
 * 把一段行内文本解析成带 marks 的 text 节点数组。
 * 识别：`**bold**`、`*italic*`/`_italic_`、`` `code` ``、`~~strike~~`。
 * 不匹配标记的纯文本作为无 mark 的 text 节点。
 * 这是「够用」的行内解析，不处理嵌套标记（如 **粗体里有`代码`**）。
 */
function parseInline(text: string): TiptapNode[] {
  if (!text) return [];
  const nodes: TiptapNode[] = [];
  // 顺序：先 code（避免内部 ** 被误解析），再 bold，再 strike，再 italic
  // 用全局正则逐段切割
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*]+\*)|(_[^_]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push({ type: 'text', text: text.slice(last, m.index) });
    }
    const token = m[0]!;
    if (token.startsWith('`')) {
      nodes.push({ type: 'text', text: token.slice(1, -1), marks: [{ type: 'code' }] });
    } else if (token.startsWith('**')) {
      nodes.push({ type: 'text', text: token.slice(2, -2), marks: [{ type: 'bold' }] });
    } else if (token.startsWith('~~')) {
      nodes.push({ type: 'text', text: token.slice(2, -2), marks: [{ type: 'strike' }] });
    } else if (token.startsWith('*')) {
      nodes.push({ type: 'text', text: token.slice(1, -1), marks: [{ type: 'italic' }] });
    } else if (token.startsWith('_')) {
      nodes.push({ type: 'text', text: token.slice(1, -1), marks: [{ type: 'italic' }] });
    }
    last = m.index + token.length;
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) });
  return nodes.length > 0 ? nodes : [{ type: 'text', text }];
}

/** 把任意行内文本包成 text 节点数组（带 marks 解析） */
function inlineNodes(text: string): TiptapNode[] {
  const parsed = parseInline(text);
  return parsed;
}

/**
 * 判断剪贴板文本是否「看起来像 Markdown」。
 * 用于粘贴时决定是否走结构化解析（而非原样塞成纯文本段落）。
 * 判据：含 # 标题 / - * + 列表 / > 引用 / | 表格 / ** 粗体 / ` 代码 等任一标记。
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text) return false;
  // 任一行的 markdown 标记命中即判定
  return /^#{1,6}\s+/m.test(text)
    || /^[-*+]\s+/m.test(text)
    || /^\d+\.\s+/m.test(text)
    || /^>\s?/m.test(text)
    || /^\|.*\|/m.test(text)
    || /\*\*[^*]+\*\*/.test(text)
    || /`[^`]+`/.test(text)
    || /^---+\s*$/m.test(text);
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
    content.push({ type: 'paragraph', content: inlineNodes(buf.join('\n')) });
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
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushParagraph(paraBuf);
      // TipTap heading 仅支持 level 1-3（StarterKit 默认），超过则截到 3
      const level = Math.min(headingMatch[1]!.length, 3);
      content.push({
        type: 'heading', attrs: { level },
        content: inlineNodes(headingMatch[2]!.trim()),
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
        content: [{ type: 'paragraph', content: inlineNodes(quoteLines.join('\n')) }],
      });
      continue;
    }

    // 无序列表
    if (/^[-*+]\s+/.test(line)) {
      flushParagraph(paraBuf);
      const items: TiptapNode[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i]!.trimEnd())) {
        const itemText = lines[i]!.replace(/^[-*+]\s+/, '');
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: inlineNodes(itemText) }] });
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
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: inlineNodes(itemText) }] });
        i++;
      }
      content.push({ type: 'orderedList', content: items });
      continue;
    }

    // 表格（连续 | ... | 行）：解析成 table/tableRow/tableHeader|tableCell 真表格节点。
    // 第一行为表头（th），分隔行 |---|---| 跳过，其余为数据行（td）。
    if (/^\|.*\|\s*$/.test(line)) {
      flushParagraph(paraBuf);
      const rows: Array<{ cells: string[]; isHeader: boolean }> = [];
      let isFirstData = true;
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i]!.trimEnd())) {
        const raw = lines[i]!.trim().replace(/^\|/, '').replace(/\|\s*$/, '');
        // 跳过分隔行 |---|---|（:--- 左对齐 / ---: 右对齐 / :--: 居中）
        if (/^[\s-:|]+$/.test(raw)) { i++; continue; }
        const cells = raw.split('|').map(c => c.trim());
        rows.push({ cells, isHeader: isFirstData });
        isFirstData = false;
        i++;
      }
      if (rows.length > 0) {
        const colCount = rows[0]!.cells.length;
        const tableRows: TiptapNode[] = rows.map(r => {
          const cellNodes = r.cells.map(cellText => {
            const cell: TiptapNode = {
              type: r.isHeader ? 'tableHeader' : 'tableCell',
              attrs: { colspan: 1, rowspan: 1, colwidth: null },
              content: [{ type: 'paragraph', content: inlineNodes(cellText) }],
            };
            return cell;
          });
          // 补齐列数不足的行（避免 schema 校验失败）
          while (cellNodes.length < colCount) {
            cellNodes.push({
              type: r.isHeader ? 'tableHeader' : 'tableCell',
              attrs: { colspan: 1, rowspan: 1, colwidth: null },
              content: [{ type: 'paragraph' }],
            });
          }
          return { type: 'tableRow', content: cellNodes };
        });
        content.push({ type: 'table', content: tableRows });
      }
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
      case 'table':
        // 表格 → 纯文本：每行单元格用制表符分隔
        return (child.content ?? []).map(row =>
          (row.content ?? []).map(cell => docToText(cell).trim()).join('\t'),
        ).join('\n');
      case 'tableRow':
      case 'tableCell':
      case 'tableHeader':
        return inner;
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
      case 'table': {
        // 表格 → markdown 表格：首行表头 + 分隔行 + 数据行
        const rows = child.content ?? [];
        if (rows.length === 0) return '';
        const renderRow = (row: TiptapNode): string => {
          const cells = (row.content ?? []).map(cell => docToMarkdown(cell).trim().replace(/\n/g, ' '));
          return '| ' + cells.join(' | ') + ' |';
        };
        // 表头行（含 tableHeader 的首行）
        const headerRow = renderRow(rows[0]!);
        const colCount = (rows[0]!.content ?? []).length;
        const sep = '| ' + Array(colCount).fill('---').join(' | ') + ' |';
        const dataRows = rows.slice(1).map(renderRow);
        return [headerRow, sep, ...dataRows].join('\n');
      }
      case 'tableRow':
      case 'tableCell':
      case 'tableHeader':
        // 这些在 table 分支里递归处理，单独命中时退化为内联文本
        return inner;
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
