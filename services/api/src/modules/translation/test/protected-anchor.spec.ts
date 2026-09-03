import { validateProtectedAnchorTopology } from '@omninovel/shared';

describe('validateProtectedAnchorTopology (Parity with Python InlineAnchorCodec)', () => {
  it('should accept plain text without any anchors in source and translated text', () => {
    const source = 'これは普通のテキストです。';
    const translated = 'Đây là văn bản bình thường.';
    const result = validateProtectedAnchorTopology(source, translated);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should accept properly preserved Strong (S) and Emphasis (E) tags', () => {
    const source = '彼は⟦S:0001⟧勇者⟦/S:0001⟧であり、⟦E:0002⟧伝説⟦/E:0002⟧の存在だ。';
    const translated = 'Anh ấy là ⟦S:0001⟧Dũng sĩ⟦/S:0001⟧ và là tồn tại ⟦E:0002⟧huyền thoại⟦/E:0002⟧.';
    const result = validateProtectedAnchorTopology(source, translated);
    expect(result.valid).toBe(true);
  });

  it('should accept Ruby (R) anchors preserving furigana structure', () => {
    const source = '見よ、あれが⟦R:0001⟧魔王⟦/R:0001⟧の城だ。';
    const translated = 'Hãy nhìn xem, đó là lâu đài của ⟦R:0001⟧Ma Vương⟦/R:0001⟧.';
    const result = validateProtectedAnchorTopology(source, translated);
    expect(result.valid).toBe(true);
  });

  it('should accept self-closing Inline Image (IMG) anchors', () => {
    const source = '星マーク ⟦IMG:0001⟧ が輝く。';
    const translated = 'Biểu tượng ngôi sao ⟦IMG:0001⟧ đang tỏa sáng.';
    const result = validateProtectedAnchorTopology(source, translated);
    expect(result.valid).toBe(true);
  });

  it('should reject unknown anchor ID injected by client/LLM', () => {
    const source = '彼は⟦S:0001⟧勇者⟦/S:0001⟧だ。';
    const translated = 'Anh ấy là ⟦S:0099⟧Dũng sĩ⟦/S:0099⟧.';
    const result = validateProtectedAnchorTopology(source, translated);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Phát hiện anchor ID lạ '0099'");
  });

  it('should reject duplicate opening tag for the same anchor ID', () => {
    const source = '⟦S:0001⟧勇者⟦/S:0001⟧';
    const translated = '⟦S:0001⟧Dũng sĩ⟦/S:0001⟧ và ⟦S:0001⟧Dũng sĩ 2⟦/S:0001⟧.';
    const result = validateProtectedAnchorTopology(source, translated);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('bị xuất hiện trùng lặp');
  });

  it('should reject tag type mismatch (registered as S but translated as E)', () => {
    const source = '彼は⟦S:0001⟧勇者⟦/S:0001⟧だ。';
    const translated = 'Anh ấy là ⟦E:0001⟧Dũng sĩ⟦/E:0001⟧.';
    const result = validateProtectedAnchorTopology(source, translated);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Sai kiểu tag mở cho ID '0001'");
  });

  it('should reject unclosed tags (missing closing tag)', () => {
    const source = '彼は⟦S:0001⟧勇者⟦/S:0001⟧だ。';
    const translated = 'Anh ấy là ⟦S:0001⟧Dũng sĩ không có tag đóng.';
    const result = validateProtectedAnchorTopology(source, translated);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('bị thiếu thẻ đóng');
  });

  it('should reject improper nesting / interleaving (cross-nested tags)', () => {
    const source = '⟦S:0001⟧勇者⟦/S:0001⟧ ⟦E:0002⟧伝説⟦/E:0002⟧';
    // S opens -> E opens -> S closes -> E closes (Cross-nested)
    const translated = '⟦S:0001⟧Dũng sĩ ⟦E:0002⟧Huyền thoại⟦/S:0001⟧⟦/E:0002⟧';
    const result = validateProtectedAnchorTopology(source, translated);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Sai thứ tự lồng thẻ');
  });

  it('should reject unexpected tags when source text has no anchors', () => {
    const source = 'Văn bản nguồn thuần túy không có tag.';
    const translated = 'Văn bản này tự dưng có ⟦S:0001⟧tag lạ⟦/S:0001⟧.';
    const result = validateProtectedAnchorTopology(source, translated);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Phát hiện thẻ protected inline tag không mong đợi');
  });

  it('should reject broken/unmatched bracket syntax', () => {
    const source = '⟦S:0001⟧勇者⟦/S:0001⟧';
    const translated = '⟦S:0001 Dũng sĩ ⟦/S:0001⟧'; // Missing closing bracket
    const result = validateProtectedAnchorTopology(source, translated);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Phát hiện dấu ngoặc thẻ protected');
  });
});
