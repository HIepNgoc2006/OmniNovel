import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { ProtectedAnchorText } from '../components/studio/protected-anchor-text';

describe('ProtectedAnchorText Component (#150 Task 3)', () => {
  it('1. renders plain text without anchors as plain text span', () => {
    const { container } = render(<ProtectedAnchorText text="Đây là văn bản bình thường." />);

    expect(screen.getByText('Đây là văn bản bình thường.')).toBeDefined();
    expect(container.querySelectorAll('code')).toHaveLength(0);
  });

  it('2. tokenizes inline anchors into code elements and surrounding text into spans', () => {
    const content = 'Xin chào ⟦S:0001⟧thế giới⟦/S:0001⟧ tuyệt vời!';
    const { container } = render(<ProtectedAnchorText text={content} />);

    expect(screen.getByText('Xin chào')).toBeDefined();
    expect(screen.getByText('thế giới')).toBeDefined();
    expect(screen.getByText('tuyệt vời!')).toBeDefined();

    const codeTags = container.querySelectorAll('code');
    expect(codeTags).toHaveLength(2);
    expect(codeTags[0].textContent).toBe('⟦S:0001⟧');
    expect(codeTags[1].textContent).toBe('⟦/S:0001⟧');
  });

  it('3. preserves verbatim representation for all anchor types (S, E, R, IMG)', () => {
    const content = 'Đoạn ⟦S:0001⟧1⟦/S:0001⟧ chú thích ⟦E:0002⟧ruby ⟦R:0003⟧ru⟦/R:0003⟧⟦/E:0002⟧ ảnh ⟦IMG:0004⟧.';
    const { container } = render(<ProtectedAnchorText text={content} />);

    const codeTags = Array.from(container.querySelectorAll('code')).map(
      (el) => el.textContent,
    );

    expect(codeTags).toEqual([
      '⟦S:0001⟧',
      '⟦/S:0001⟧',
      '⟦E:0002⟧',
      '⟦R:0003⟧',
      '⟦/R:0003⟧',
      '⟦/E:0002⟧',
      '⟦IMG:0004⟧',
    ]);
  });

  it('4. security invariant: HTML-like content is never parsed or executed as DOM elements', () => {
    const maliciousInput =
      'Hello <script>window.__xss_fired__ = true;</script><img src="invalid" onerror="window.__xss_fired__ = true;" /> ⟦S:0005⟧safe text⟦/S:0005⟧';

    const { container } = render(<ProtectedAnchorText text={maliciousInput} />);

    // Invariant: Zero <script> or <img> DOM elements created
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();

    // Verbatim text is rendered harmlessly as text content
    expect(container.textContent).toContain(
      '<script>window.__xss_fired__ = true;</script>',
    );
    expect(container.textContent).toContain(
      '<img src="invalid" onerror="window.__xss_fired__ = true;" />',
    );

    // Anchor is still properly highlighted
    expect(screen.getByText('⟦S:0005⟧')).toBeDefined();
    expect(screen.getByText('⟦/S:0005⟧')).toBeDefined();
  });

  it('5. handles empty or whitespace text gracefully', () => {
    const { container } = render(<ProtectedAnchorText text="" />);
    expect(container.textContent).toBe('');
  });
});
