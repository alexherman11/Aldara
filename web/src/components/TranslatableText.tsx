/**
 * Per-word translatable rendering for Sofía's transcript bubbles.
 *
 *   - Hover a word for ~700ms (desktop) or long-press ~500ms (touch) →
 *     translation tooltip below the word.
 *   - Click the word (or the open tooltip) → expands into a small dictionary
 *     panel with definitions, conjugations (Wiktionary), and example sentences
 *     (Tatoeba).
 *
 * Tokenization is done **per Fragment** rather than on the joined bubble text,
 * so a late-arriving streamed fragment doesn't re-key sibling spans and kill
 * an already-open tooltip mid-interaction.
 *
 * The popover is rendered into document.body via a portal and positioned with
 * the trigger's getBoundingClientRect(), so it never gets clipped by the
 * transcript scroll container.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  lookup,
  normalizeWord,
  translate,
  type DictLookupResp,
  type TranslateResp,
} from '@/lib/translate';
import type { Fragment } from '@/lib/voice';

const HOVER_DELAY_MS = 700;
const LONG_PRESS_MS = 500;
const TOOLTIP_OFFSET_PX = 6;
const EXPANDED_OFFSET_PX = 10;

interface Anchor {
  /** DOM key — `${segId}:${tokenIdx}` */
  key: string;
  /** Bounding rect of the word span at the time the popover opened. */
  rect: DOMRect;
  /** The raw, punctuation-stripped word for API lookup. */
  word: string;
  /** Full bubble text — gets sent to translate() as `context`. */
  context: string;
  /** 'tooltip' = quick translation; 'expanded' = full dictionary panel. */
  state: 'tooltip' | 'expanded';
}

export function TranslatableText({
  fragments,
  final,
  className,
  testId,
}: {
  fragments: Fragment[];
  final: boolean;
  className?: string;
  testId?: string;
}) {
  const bubbleText = useMemo(
    () =>
      fragments
        .map((f) => f.text.trim())
        .filter((t) => t.length > 0)
        .join(' '),
    [fragments],
  );

  const [anchor, setAnchor] = useState<Anchor | null>(null);

  const closeAnchor = useCallback(() => setAnchor(null), []);

  // Close on Escape and on outside click. Capture-phase outside-click so the
  // tooltip's own click handler still runs first (so click-on-tooltip can
  // upgrade to 'expanded').
  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAnchor();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest('[data-translatable-popover]')) return;
      if (target?.closest('[data-translatable-word]')) return;
      closeAnchor();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [anchor, closeAnchor]);

  return (
    <p className={className} data-testid={testId}>
      {fragments.map((frag) => (
        <FragmentSpans
          key={frag.segId}
          fragment={frag}
          final={final}
          context={bubbleText}
          activeKey={anchor?.key ?? null}
          onActivate={(key, rect, word) => {
            setAnchor((prev) => {
              if (prev?.key === key && prev.state === 'tooltip') {
                return { ...prev, state: 'expanded', rect };
              }
              return {
                key,
                rect,
                word,
                context: bubbleText,
                state: 'tooltip',
              };
            });
          }}
        />
      ))}
      {anchor &&
        createPortal(
          <Popover
            anchor={anchor}
            onExpand={() =>
              setAnchor((prev) => (prev ? { ...prev, state: 'expanded' } : prev))
            }
            onClose={closeAnchor}
          />,
          document.body,
        )}
    </p>
  );
}

function FragmentSpans({
  fragment,
  final,
  context: _context,
  activeKey,
  onActivate,
}: {
  fragment: Fragment;
  final: boolean;
  context: string;
  activeKey: string | null;
  onActivate: (key: string, rect: DOMRect, word: string) => void;
}) {
  // Translation gated on the full bubble being final — translating
  // mid-stream wastes API calls and the word might still mutate.
  const interactive = final;
  const tokens = fragment.text.split(/(\s+)/);
  return (
    <>
      {tokens.map((tok, i) => {
        if (!tok || /^\s+$/.test(tok)) return <span key={i}>{tok}</span>;
        const normalized = normalizeWord(tok);
        if (!normalized) return <span key={i}>{tok}</span>;
        const key = `${fragment.segId}:${i}`;
        return (
          <Word
            key={key}
            wordKey={key}
            display={tok}
            lookup={normalized}
            interactive={interactive}
            active={activeKey === key}
            onActivate={(rect) => onActivate(key, rect, normalized)}
          />
        );
      })}
    </>
  );
}

function Word({
  wordKey: _wordKey,
  display,
  lookup,
  interactive,
  active,
  onActivate,
}: {
  wordKey: string;
  display: string;
  lookup: string;
  interactive: boolean;
  active: boolean;
  onActivate: (rect: DOMRect) => void;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);

  const trigger = useCallback(() => {
    if (!ref.current) return;
    onActivate(ref.current.getBoundingClientRect());
  }, [onActivate]);

  const cancelHover = () => {
    if (hoverTimer.current) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  useEffect(
    () => () => {
      cancelHover();
      cancelLongPress();
    },
    [],
  );

  if (!interactive) {
    return <span>{display}</span>;
  }

  return (
    <span
      ref={ref}
      data-translatable-word={lookup}
      onMouseEnter={() => {
        cancelHover();
        hoverTimer.current = window.setTimeout(trigger, HOVER_DELAY_MS);
      }}
      onMouseLeave={cancelHover}
      onClick={(e) => {
        // Suppress synthetic click that follows a long-press tap.
        if (longPressFired.current) {
          longPressFired.current = false;
          e.preventDefault();
          return;
        }
        trigger();
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== 'touch') return;
        longPressFired.current = false;
        cancelLongPress();
        longPressTimer.current = window.setTimeout(() => {
          longPressFired.current = true;
          trigger();
        }, LONG_PRESS_MS);
      }}
      onPointerUp={(e) => {
        if (e.pointerType !== 'touch') return;
        cancelLongPress();
      }}
      onPointerCancel={cancelLongPress}
      style={{
        cursor: 'help',
        borderBottom: active
          ? '1px dashed hsl(15 85% 52%)'
          : '1px dashed transparent',
        transition: 'border-color 150ms ease',
        // Prevent native long-press text-selection menu on touch.
        WebkitUserSelect: 'none',
        userSelect: 'none',
        WebkitTouchCallout: 'none',
      }}
    >
      {display}
    </span>
  );
}

function Popover({
  anchor,
  onExpand,
  onClose,
}: {
  anchor: Anchor;
  onExpand: () => void;
  onClose: () => void;
}) {
  const isExpanded = anchor.state === 'expanded';
  const offset = isExpanded ? EXPANDED_OFFSET_PX : TOOLTIP_OFFSET_PX;
  const width = isExpanded ? 360 : 240;
  const left = Math.min(
    Math.max(8, anchor.rect.left + anchor.rect.width / 2 - width / 2),
    window.innerWidth - width - 8,
  );
  // Place below; if that overflows, flip above. Height isn't known until
  // render, so we approximate — popovers self-correct on next interaction.
  const approxHeight = isExpanded ? 240 : 48;
  let top = anchor.rect.bottom + offset;
  if (top + approxHeight > window.innerHeight - 8) {
    top = anchor.rect.top - approxHeight - offset;
  }
  return (
    <div
      data-translatable-popover
      style={{
        position: 'fixed',
        top,
        left,
        width,
        zIndex: 1000,
        pointerEvents: 'auto',
      }}
    >
      {isExpanded ? (
        <ExpandedCard anchor={anchor} onClose={onClose} />
      ) : (
        <TooltipBubble anchor={anchor} onClickExpand={onExpand} />
      )}
    </div>
  );
}

function TooltipBubble({
  anchor,
  onClickExpand,
}: {
  anchor: Anchor;
  onClickExpand: () => void;
}) {
  const [data, setData] = useState<TranslateResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setErr(null);
    translate(anchor.word, anchor.context)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [anchor.word, anchor.context]);

  return (
    <button
      type="button"
      onClick={onClickExpand}
      className="rounded-lg shadow-lg border bg-popover text-popover-foreground text-left w-full"
      style={{
        padding: '8px 12px',
        fontSize: 14,
        lineHeight: 1.35,
        cursor: 'pointer',
        animation: 'fadeIn 120ms ease-out',
      }}
      data-testid="translate-tooltip"
    >
      <div
        className="text-[10px] uppercase tracking-wider opacity-60"
        style={{ marginBottom: 2 }}
      >
        {anchor.word}
      </div>
      {data ? (
        <div>
          {data.translation}
          <span
            className="text-[10px] opacity-50"
            style={{ marginLeft: 8 }}
          >
            tap for more
          </span>
        </div>
      ) : err ? (
        <div className="opacity-70 italic">no translation</div>
      ) : (
        <div className="opacity-50">…</div>
      )}
    </button>
  );
}

function ExpandedCard({
  anchor,
  onClose,
}: {
  anchor: Anchor;
  onClose: () => void;
}) {
  const [tr, setTr] = useState<TranslateResp | null>(null);
  const [dict, setDict] = useState<DictLookupResp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      translate(anchor.word, anchor.context).catch(() => null),
      lookup(anchor.word).catch(() => null),
    ]).then(([t, d]) => {
      if (cancelled) return;
      setTr(t);
      setDict(d);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [anchor.word, anchor.context]);

  const verbSense = dict?.senses.find((s) =>
    /verb/i.test(s.partOfSpeech),
  );
  const isConjugatedForm =
    verbSense &&
    verbSense.definitions.some((d) =>
      /\b(first|second|third)-person\b|\bplural\b|\bsingular\b|\bsubjunctive\b|\bindicative\b|\bimperative\b|\binfinitive of\b|\bof the verb\b/i.test(
        d,
      ),
    );
  const lemmaMatch = isConjugatedForm
    ? dict?.senses
        .flatMap((s) => s.definitions)
        .map((d) => d.match(/\bof (?:the verb )?([a-zñáéíóú]+)\b/i)?.[1])
        .find(Boolean)
    : null;

  return (
    <div
      className="rounded-xl shadow-xl border bg-popover text-popover-foreground"
      style={{
        padding: 14,
        fontSize: 13,
        lineHeight: 1.4,
        maxHeight: 360,
        overflowY: 'auto',
        animation: 'fadeIn 140ms ease-out',
      }}
      data-testid="translate-expanded"
    >
      <div className="flex items-baseline justify-between" style={{ marginBottom: 8 }}>
        <div>
          <span className="font-serif text-base font-semibold">{anchor.word}</span>
          {lemmaMatch && (
            <span className="text-[11px] opacity-60" style={{ marginLeft: 6 }}>
              ← form of <em>{lemmaMatch}</em>
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="opacity-50 hover:opacity-100 text-xs"
          style={{ padding: '0 4px', cursor: 'pointer' }}
        >
          ✕
        </button>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div className="text-[10px] uppercase tracking-wider opacity-50">
          Translation
        </div>
        <div className="text-[15px]">
          {tr?.translation ?? (loading ? '…' : <em className="opacity-60">unavailable</em>)}
        </div>
      </div>

      {dict && dict.senses.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div className="text-[10px] uppercase tracking-wider opacity-50">
            Dictionary
          </div>
          {dict.senses.slice(0, 4).map((s, i) => (
            <div key={i} style={{ marginTop: 4 }}>
              <span
                className="text-[10px] uppercase tracking-wider opacity-70"
                style={{ marginRight: 6 }}
              >
                {s.partOfSpeech}
              </span>
              <ol style={{ margin: 0, paddingLeft: 18 }}>
                {s.definitions.slice(0, 3).map((d, j) => (
                  <li key={j} style={{ marginBottom: 2 }}>
                    {d}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}

      {dict && dict.examples.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider opacity-50">
            Examples
          </div>
          <ul style={{ margin: 0, paddingLeft: 14, listStyle: 'none' }}>
            {dict.examples.map((ex, i) => (
              <li key={i} style={{ marginTop: 4 }}>
                <div className="font-serif italic">{ex.es}</div>
                <div className="opacity-65 text-[12px]">{ex.en}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!loading && !dict?.senses.length && !dict?.examples.length && (
        <div className="opacity-50 italic">No dictionary entry found.</div>
      )}
    </div>
  );
}
