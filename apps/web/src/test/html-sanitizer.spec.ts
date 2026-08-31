import { describe, it, expect } from 'vitest';
import { sanitizeNovelHtml } from '../lib/reader/html-sanitizer';

describe('Light Novel HTML Sanitizer', () => {
  it('should preserve allowed safe tags including semantic Ruby tags', () => {
    const raw = `
      <p>Đây là câu văn bình thường với <ruby><rb>漢字</rb><rt>かんじ</rt></ruby> chuẩn Nhật.</p>
      <blockquote>Lời trích dẫn quan trọng.</blockquote>
      <h3>Tiêu đề chương nhỏ</h3>
    `;

    const sanitized = sanitizeNovelHtml(raw);
    expect(sanitized).toContain('<ruby>');
    expect(sanitized).toContain('<rb>漢字</rb>');
    expect(sanitized).toContain('<rt>かんじ</rt>');
    expect(sanitized).toContain('<blockquote>Lời trích dẫn quan trọng.</blockquote>');
    expect(sanitized).toContain('<h3>Tiêu đề chương nhỏ</h3>');
  });

  it('should strip malicious <script>, <iframe> and event handlers', () => {
    const dangerous = `
      <p>Văn bản an toàn</p>
      <script>alert("XSS Attack!");</script>
      <img src="https://example.com/art.jpg" onerror="alert('Hacked')" />
      <a href="javascript:stealToken()">Nhấn vào đây</a>
      <iframe src="https://malicious.com"></iframe>
    `;

    const sanitized = sanitizeNovelHtml(dangerous);
    expect(sanitized).not.toContain('<script');
    expect(sanitized).not.toContain('<iframe');
    expect(sanitized).not.toContain('onerror');
    expect(sanitized).not.toContain('javascript:');
    expect(sanitized).toContain('Văn bản an toàn');
    expect(sanitized).toContain('src="https://example.com/art.jpg"');
  });

  it('should support footnote data attributes safely', () => {
    const raw = `<p>Nhân vật chính cầm <span data-footnote="Thanh kiếm cổ truyền thuyết">Bảo Kiếm</span> xông tới.</p>`;
    const sanitized = sanitizeNovelHtml(raw);

    expect(sanitized).toContain('data-footnote="Thanh kiếm cổ truyền thuyết"');
    expect(sanitized).toContain('Bảo Kiếm');
  });
});
