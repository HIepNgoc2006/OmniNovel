/**
 * Protected Inline Anchor Validator
 * Strict parity with Python ai-worker InlineAnchorCodec (_validate_strict_invariants).
 */

export interface ProtectedAnchorValidationResult {
  valid: boolean;
  error?: string;
}

export type ProtectedAnchorTagType = 'S' | 'E' | 'R' | 'IMG';

const ANCHOR_PATTERN = /⟦(\/?[A-Z]+):?(\d{4})?⟧/g;

/**
 * Validates that translated text preserves all inline protected anchors (⟦S:0001⟧, ⟦E:0002⟧, ⟦R:0003⟧, ⟦IMG:0004⟧)
 * from the source text with 100% strict topological correctness.
 *
 * Strict invariants enforced:
 * 1. Exact anchor ID set matching between source and translated text.
 * 2. Zero unexpected anchors if source has no anchors.
 * 3. No orphan brackets (⟦ without ⟧).
 * 4. Rejection of unknown IDs, duplicate openings, duplicate closures.
 * 5. Rejection of tag type mismatches (S, E, R, IMG).
 * 6. Strict non-interleaved LIFO nesting stack.
 * 7. Self-closing semantics for ⟦IMG:...⟧.
 */
export function validateProtectedAnchorTopology(
  sourceText: string,
  translatedText: string,
): ProtectedAnchorValidationResult {
  // Check for broken brackets
  const openBracketCount = (translatedText.match(/⟦/g) || []).length;
  const closeBracketCount = (translatedText.match(/⟧/g) || []).length;
  if (openBracketCount !== closeBracketCount) {
    return {
      valid: false,
      error: 'Phát hiện dấu ngoặc thẻ protected ⟦...⟧ không đồng bộ.',
    };
  }

  // 1. Extract expected anchors from source text
  const expectedAnchors = new Map<string, ProtectedAnchorTagType>();
  const sourceMatches = Array.from(sourceText.matchAll(ANCHOR_PATTERN));

  for (const match of sourceMatches) {
    const rawTag = match[1];
    const aid = match[2];
    if (!aid) continue;

    const isClose = rawTag.startsWith('/');
    const tagType = (isClose ? rawTag.slice(1) : rawTag) as ProtectedAnchorTagType;
    if (!expectedAnchors.has(aid)) {
      expectedAnchors.set(aid, tagType);
    }
  }

  const translatedMatches = Array.from(translatedText.matchAll(ANCHOR_PATTERN));

  // If number of matched tags doesn't match total brackets, there's a malformed tag
  if (translatedMatches.length !== openBracketCount) {
    return {
      valid: false,
      error: 'Phát hiện thẻ inline chứa cú pháp không hợp lệ.',
    };
  }

  // 2. If source has no anchors
  if (expectedAnchors.size === 0) {
    if (translatedMatches.length > 0) {
      const foundTags = translatedMatches.map((m) => m[0]);
      return {
        valid: false,
        error: `Phát hiện thẻ protected inline tag không mong đợi trong block: ${foundTags.join(', ')}`,
      };
    }
    return { valid: true };
  }

  // 3. Strict Pre-check: IDs, types, duplicate check
  const seenOpenIds = new Set<string>();
  const seenCloseIds = new Set<string>();

  for (const match of translatedMatches) {
    const tagContent = match[1];
    const aid = match[2];

    if (!aid) {
      return {
        valid: false,
        error: `Thẻ inline không có ID hợp lệ: '${match[0]}'`,
      };
    }

    if (!expectedAnchors.has(aid)) {
      return {
        valid: false,
        error: `Phát hiện anchor ID lạ '${aid}' không tồn tại trong metadata của block.`,
      };
    }

    const expectedType = expectedAnchors.get(aid)!;

    if (tagContent === 'IMG') {
      if (expectedType !== 'IMG') {
        return {
          valid: false,
          error: `Sai kiểu tag cho ID '${aid}': mong đợi ${expectedType}, nhận được IMG.`,
        };
      }
      if (seenOpenIds.has(aid)) {
        return {
          valid: false,
          error: `Anchor ID IMG '${aid}' bị xuất hiện trùng lặp nhiều lần.`,
        };
      }
      seenOpenIds.add(aid);
    } else if (!tagContent.startsWith('/')) {
      if (tagContent !== expectedType) {
        return {
          valid: false,
          error: `Sai kiểu tag mở cho ID '${aid}': mong đợi ${expectedType}, nhận được ${tagContent}.`,
        };
      }
      if (seenOpenIds.has(aid)) {
        return {
          valid: false,
          error: `Thẻ mở cho anchor ID '${aid}' bị xuất hiện trùng lặp nhiều lần.`,
        };
      }
      seenOpenIds.add(aid);
    } else {
      const closeType = tagContent.slice(1);
      if (closeType !== expectedType) {
        return {
          valid: false,
          error: `Sai kiểu tag đóng cho ID '${aid}': mong đợi /${expectedType}, nhận được /${closeType}.`,
        };
      }
      if (seenCloseIds.has(aid)) {
        return {
          valid: false,
          error: `Thẻ đóng cho anchor ID '${aid}' bị xuất hiện trùng lặp nhiều lần.`,
        };
      }
      seenCloseIds.add(aid);
    }
  }

  // Exact set equality
  const missingOpen: string[] = [];
  for (const aid of expectedAnchors.keys()) {
    if (!seenOpenIds.has(aid)) {
      missingOpen.push(aid);
    }
  }
  if (missingOpen.length > 0) {
    return {
      valid: false,
      error: `Văn bản dịch bị thiếu các anchor IDs bắt buộc: ${missingOpen.join(', ')}.`,
    };
  }

  const missingClose: string[] = [];
  for (const [aid, type] of expectedAnchors.entries()) {
    if (type !== 'IMG' && !seenCloseIds.has(aid)) {
      missingClose.push(aid);
    }
  }
  if (missingClose.length > 0) {
    return {
      valid: false,
      error: `Văn bản dịch bị thiếu thẻ đóng cho các anchor IDs: ${missingClose.join(', ')}.`,
    };
  }

  // 4. Strict Tree / LIFO Nesting Stack check
  const stack: Array<{ tagType: string; aid: string }> = [];

  for (const match of translatedMatches) {
    const tagContent = match[1];
    const aid = match[2]!;

    if (tagContent === 'IMG') {
      // Self-closing tag, does not push or pop stack
      continue;
    } else if (!tagContent.startsWith('/')) {
      stack.push({ tagType: tagContent, aid });
    } else {
      const closeType = tagContent.slice(1);
      if (stack.length === 0) {
        return {
          valid: false,
          error: `Thẻ đóng ⟦/${closeType}:${aid}⟧ không có thẻ mở tương ứng.`,
        };
      }
      const popped = stack.pop()!;
      if (popped.tagType !== closeType || popped.aid !== aid) {
        return {
          valid: false,
          error: `Sai thứ tự lồng thẻ: mong đợi đóng ⟦/${popped.tagType}:${popped.aid}⟧ nhưng nhận được ⟦/${closeType}:${aid}⟧.`,
        };
      }
    }
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1];
    return {
      valid: false,
      error: `Thẻ ⟦${unclosed.tagType}:${unclosed.aid}⟧ chưa được đóng.`,
    };
  }

  return { valid: true };
}
