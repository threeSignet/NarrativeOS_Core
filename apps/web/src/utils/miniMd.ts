// =============================================================================
// 极简 Markdown 渲染——Agent 聊天消息用
// =============================================================================
// 不引入依赖。处理 Agent 回复最常见的格式：换行、加粗、斜体、行内代码、
// 分隔线、无序列表、标题。先 HTML escape 防 XSS，再做 Markdown 替换。
// 不处理图片/链接/表格/嵌套（Agent 回复不需要）。

/** 将 Markdown 文本渲染为安全 HTML（已 escape） */
export function renderMd(md: string): string {
  if (!md) return '';
  // 1. HTML escape 防 XSS
  let s = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. 按行处理块级元素
  const lines = s.split('\n');
  const out: string[] = [];
  let inList = false;
  let inCode = false;
  let codeBuf: string[] = [];

  for (const line of lines) {
    // 代码块围栏
    if (line.trim().startsWith('```')) {
      if (inCode) {
        out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    // 分隔线 ---
    if (/^---+\s*$/.test(line)) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('<hr/>');
      continue;
    }
    // 标题 ### / ## / #
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      if (inList) { out.push('</ul>'); inList = false; }
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    // 无序列表 - 或 *
    const li = line.match(/^[\s]*[-*]\s+(.*)$/);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    // 普通行
    if (inList) { out.push('</ul>'); inList = false; }
    out.push(inline(line) || '&nbsp;');
  }
  if (inList) out.push('</ul>');
  if (inCode) out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`);

  // 用 <br/> 连接普通行（块级元素自带换行，不重复加）
  // 简单处理：块级标签之间不加 br，普通文本行之间加 br
  return out.join('\n').replace(/\n(?!<)/g, '<br/>');
}

/** 行内格式：加粗、斜体、行内代码 */
function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}
