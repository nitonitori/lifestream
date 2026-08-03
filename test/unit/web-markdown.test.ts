import { describe, it, expect } from 'vitest';
import { mdToHtml } from '../../web/src/components/markdown';

// 这个文件钉住的是 md 实例的配置与安全行为 —— 也就是本次唯一无法靠浏览器
// 一眼看出的部分（转义漏了在页面上是「看起来正常」的）。
describe('mdToHtml', () => {
  // html:false 的核心保证：源里的原生 HTML 变字面量，而不是活标签。
  // 注意不能断言 not.toContain('onerror')：转义后的文本里照样有这几个字，
  // 真正要挡的是 '<img' 这个活标签。
  it('原生 HTML 被转义成字面量', () => {
    const html = mdToHtml('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });

  it('javascript: 链接不生成 <a>', () => {
    expect(mdToHtml('[坏](javascript:alert(1))')).not.toContain('<a');
  });

  // 缺了 target/rel，点链接会把控制台整页导航走（SSE 断、状态全丢）。
  it('链接带 target=_blank 与 rel=noopener noreferrer', () => {
    const html = mdToHtml('[x](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  // linkify 出来的裸 URL 走的是同一条 link_open 规则，一并钉住。
  it('裸 URL 自动成链接且同样带 target/rel', () => {
    const html = mdToHtml('打开 http://127.0.0.1:8787 看看');
    expect(html).toContain('<a href="http://127.0.0.1:8787" target="_blank" rel="noopener noreferrer">');
  });

  it('GFM 表格渲染成 table 且保留列对齐', () => {
    const html = mdToHtml('| 表 | 格 |\n| --- | ---: |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th style="text-align:right">格</th>');
  });

  it('围栏代码块带 language class，内容原样保留', () => {
    const html = mdToHtml('```ts\nconst x: number = 1;\n```');
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain('const x: number = 1;');
  });

  // breaks:true —— 聊天语境下按一次回车就该换行，CommonMark 的软换行会把它吃掉。
  it('单换行渲染成 <br>', () => {
    expect(mdToHtml('a\nb')).toContain('<br>');
  });

  it('嵌套列表保留层级', () => {
    const html = mdToHtml('- a\n  - b');
    expect(html.match(/<ul>/g)?.length).toBe(2);
  });
});
