/**
 * Smooth transitions, in one place.
 *
 * - Tab changes run through the View Transitions API: the old page dissolves quickly, the new
 *   one settles in from the direction of travel in the sidebar (down the list = from below).
 *   The sidebar and the player bar are not part of the swap, so they stay perfectly still.
 * - Opening a video from a thumbnail morphs that thumbnail into the player (shared element),
 *   the way YouTube's own app does.
 * - animateHeight(): FLIP for blocks whose height changes (the link preview), so what sits
 *   below glides instead of jumping. Interruptible: a new change starts from the current height.
 *
 * Timing follows emil-design-eng: enter ~300 ms with a strong ease-out, exit faster (~140 ms),
 * nothing starts from scale(0), and prefers-reduced-motion turns all of it into plain swaps.
 */

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
/** Plain swaps: the user asked for less motion, or battery saver is on */
const calm = () => reduceMotion.matches || document.body.classList.contains('power-saver');
export const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
export const EASE_DRAWER = 'cubic-bezier(0.32, 0.72, 0, 1)';

/** Sidebar order; "watch" sits deeper than everything else. */
const TAB_ORDER = ['downloads', 'explore', 'history', 'library', 'settings', 'watch'];

type Direction = 'forward' | 'back' | 'fade' | 'theme' | 'morph';

interface ViewTransitionLike {
  finished: Promise<void>;
}

const supportsVT = typeof (document as any).startViewTransition === 'function';
if (supportsVT) document.documentElement.classList.add('vt');

let running: ViewTransitionLike | null = null;

/**
 * Runs `update` inside a view transition (or directly when unsupported / reduced motion).
 * @param morphFrom an element in the current page that should morph into #watch-screen
 */
export function withViewTransition(update: () => void, dir: Direction = 'fade', morphFrom?: HTMLElement | null) {
  if (!supportsVT || calm() || document.hidden) {
    update();
    return;
  }
  const root = document.documentElement;
  const target = document.getElementById('watch-screen');
  root.dataset.vt = morphFrom && target ? 'morph' : dir;
  if (morphFrom && target) morphFrom.style.setProperty('view-transition-name', 'hero-media');

  const vt: ViewTransitionLike = (document as any).startViewTransition(() => {
    if (morphFrom && target) {
      morphFrom.style.removeProperty('view-transition-name');
      target.style.setProperty('view-transition-name', 'hero-media');
    }
    update();
  });
  running = vt;
  vt.finished.finally(() => {
    target?.style.removeProperty('view-transition-name');
    morphFrom?.style.removeProperty('view-transition-name');
    if (running === vt) {
      delete root.dataset.vt;
      running = null;
    }
  });
}

export function tabDirection(from: string, to: string): Direction {
  const a = TAB_ORDER.indexOf(from);
  const b = TAB_ORDER.indexOf(to);
  if (a < 0 || b < 0 || a === b) return 'fade';
  return b > a ? 'forward' : 'back';
}

/**
 * FLIP the height of `el` across a DOM change made by `mutate`. Content below moves smoothly.
 * Calling it again mid-animation continues from the current on-screen height.
 */
export function animateHeight(el: HTMLElement, mutate: () => void, duration = 340) {
  if (calm()) {
    mutate();
    return;
  }
  const from = el.getBoundingClientRect().height;
  el.getAnimations().forEach((a) => a.cancel());
  mutate();
  const to = el.getBoundingClientRect().height;
  if (Math.abs(from - to) < 1) return;
  el.style.overflow = 'hidden';
  const anim = el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration, easing: EASE_OUT });
  const done = () => el.style.removeProperty('overflow');
  anim.onfinish = done;
  anim.oncancel = done;
}

/** Collapse `el` to zero height (exit is faster than enter), then run `after` (e.g. hide it). */
export function collapse(el: HTMLElement, after: () => void, duration = 220) {
  if (calm() || el.hidden) {
    after();
    return;
  }
  const from = el.getBoundingClientRect().height;
  el.getAnimations().forEach((a) => a.cancel());
  el.style.overflow = 'hidden';
  const anim = el.animate(
    [
      { height: `${from}px`, opacity: 1 },
      { height: '0px', opacity: 0 },
    ],
    { duration, easing: EASE_OUT }
  );
  anim.onfinish = () => {
    el.style.removeProperty('overflow');
    after();
  };
  anim.oncancel = () => el.style.removeProperty('overflow');
}

/** Content swap inside a stable container: a short fade + rise, no layout animation. */
export function fadeIn(el: HTMLElement, distance = 6, duration = 260) {
  if (calm()) return;
  el.animate(
    [
      { opacity: 0, transform: `translateY(${distance}px)` },
      { opacity: 1, transform: 'none' },
    ],
    { duration, easing: EASE_OUT }
  );
}

/**
 * Group entrance for freshly loaded cards: non-uniform delays (fast at first, then tighter),
 * capped so the whole group is in within ~350 ms and never blocks interaction.
 */
export function staggerIn(items: HTMLElement[], max = 12) {
  if (calm()) return;
  items.slice(0, max).forEach((item, i) => {
    const delay = Math.round(28 * i - 0.9 * i * i); // 0, 27, 52, 76, 98 ... flattens out
    item.animate(
      [
        { opacity: 0, transform: 'translateY(10px) scale(0.985)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 360, delay: Math.max(0, delay), easing: EASE_OUT, fill: 'backwards' }
    );
  });
}

// ─────────────────────────────── Images fade in when they load ───────────────────────────────

/**
 * Thumbnails pop in when they arrive; mark each <img> loaded so CSS can fade it in. Images that
 * are already complete (cache) are marked at once, so nothing can stay invisible.
 */
function markLoaded(img: HTMLImageElement) {
  if (img.complete && img.naturalWidth > 0) img.classList.add('is-loaded');
}
document.addEventListener(
  'load',
  (e) => {
    if (e.target instanceof HTMLImageElement) e.target.classList.add('is-loaded');
  },
  true
);
new MutationObserver((records) => {
  for (const r of records) {
    r.addedNodes.forEach((n) => {
      if (n instanceof HTMLImageElement) markLoaded(n);
      else if (n instanceof HTMLElement) n.querySelectorAll('img').forEach(markLoaded);
    });
  }
}).observe(document.documentElement, { childList: true, subtree: true });
