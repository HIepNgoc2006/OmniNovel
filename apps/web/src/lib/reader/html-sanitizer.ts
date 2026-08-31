/**
 * Strict HTML Sanitizer for Light Novel Reader
 * Enforces tag, attribute and URL allowlists without external heavy dependencies
 */

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'blockquote',
  'ruby',
  'rb',
  'rt',
  'rp',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'img',
  'span',
  'div',
  'hr',
  'a',
  'ul',
  'ol',
  'li',
  'sub',
  'sup',
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'target', 'rel']),
  img: new Set(['src', 'alt', 'title', 'width', 'height', 'loading']),
  span: new Set(['class', 'data-footnote']),
  div: new Set(['class']),
  p: new Set(['class']),
  ruby: new Set(['class']),
  rt: new Set(['class']),
  rb: new Set(['class']),
  rp: new Set(['class']),
};

function isSafeUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  if (
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('data:text/html') ||
    trimmed.startsWith('vbscript:')
  ) {
    return false;
  }
  return (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('#')
  );
}

export function sanitizeNovelHtml(rawHtml: string): string {
  if (!rawHtml) return '';

  if (typeof window === 'undefined') {
    // Basic server-side regex cleanup fallback
    return rawHtml
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
      .replace(/on\w+="[^"]*"/gi, '')
      .replace(/on\w+='[^']*'/gi, '');
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(rawHtml, 'text/html');

  function cleanNode(node: Node) {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const elem = child as HTMLElement;
        const tagName = elem.tagName.toLowerCase();

        if (!ALLOWED_TAGS.has(tagName)) {
          // Replace disallowed element with its text content or unwrap
          const textNode = doc.createTextNode(elem.textContent || '');
          node.replaceChild(textNode, elem);
          continue;
        }

        // Clean attributes
        const allowedForTag = ALLOWED_ATTRS[tagName] || new Set();
        const attrs = Array.from(elem.attributes);
        for (const attr of attrs) {
          const attrName = attr.name.toLowerCase();

          // Reject any on* handlers
          if (attrName.startsWith('on')) {
            elem.removeAttribute(attr.name);
            continue;
          }

          if (!allowedForTag.has(attrName)) {
            elem.removeAttribute(attr.name);
            continue;
          }

          // URL attribute validation
          if (attrName === 'href' || attrName === 'src') {
            if (!isSafeUrl(attr.value)) {
              elem.removeAttribute(attr.name);
            }
          }
        }

        // For links, enforce noopener noreferrer
        if (tagName === 'a' && elem.getAttribute('target') === '_blank') {
          elem.setAttribute('rel', 'noopener noreferrer');
        }

        cleanNode(elem);
      }
    }
  }

  cleanNode(doc.body);
  return doc.body.innerHTML;
}
