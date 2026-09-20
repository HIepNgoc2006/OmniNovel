import React from 'react';

export interface ProtectedAnchorTextProps {
  text: string;
  className?: string;
  anchorClassName?: string;
}

// Regex matching inline protected tags like ⟦S:0001⟧, ⟦/S:0001⟧, ⟦E:0002⟧, ⟦R:0003⟧, ⟦IMG:0004⟧
const INLINE_ANCHOR_REGEX = /(⟦\/?(?:S|E|R|IMG)(?::\d{4})?⟧)/g;

export function ProtectedAnchorText({
  text,
  className = '',
  anchorClassName = '',
}: ProtectedAnchorTextProps) {
  if (!text) return null;

  const parts = text.split(INLINE_ANCHOR_REGEX);

  return (
    <span className={className}>
      {parts.map((part, index) => {
        if (!part) return null;

        if (part.startsWith('⟦') && part.endsWith('⟧')) {
          const isCloseTag = part.startsWith('⟦/');
          return (
            <code
              key={index}
              className={`inline-flex items-center px-1 py-0.5 mx-0.5 rounded text-[11px] font-mono font-medium select-all ${
                isCloseTag
                  ? 'bg-slate-800/80 text-slate-400 border border-slate-700'
                  : 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
              } ${anchorClassName}`}
            >
              {part}
            </code>
          );
        }

        return <span key={index}>{part}</span>;
      })}
    </span>
  );
}
