/**
 * Spring-driven selection indicators for the Clay theme, built on Motion
 * (the framework-agnostic successor of Framer Motion).
 *
 * Why springs here (apple-design, emil-design-eng): a selection indicator is the one place in
 * this app where motion explains something — where the selection went. Springs start from the
 * element's *current* on-screen value and keep velocity when retargeted, so clicking quickly
 * from tab to tab never jumps or restarts. Critically damped (bounce 0): a menu that just
 * changed selection should settle, not wobble.
 */
import { animate } from 'motion';

const SPRING = { type: 'spring', bounce: 0, duration: 0.32 } as const;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const isClaude = () => document.body.getAttribute('data-color-theme') === 'claude';

interface Indicator {
  place: (animated: boolean) => void;
  isPlaced: () => boolean;
}

const indicators: Indicator[] = [];

function attach(container: HTMLElement, activeSelector: string, className: string): Indicator {
  const el = document.createElement('span');
  el.className = className;
  el.setAttribute('aria-hidden', 'true');
  container.prepend(el);

  let placed = false;
  let controls: { stop: () => void } | null = null;

  const place = (animated: boolean) => {
    if (!isClaude()) {
      placed = false;
      return;
    }
    const active = container.querySelector<HTMLElement>(activeSelector);
    // Hidden containers (a closed tab) have no layout yet: place them once they are shown
    if (!active || active.offsetWidth === 0) {
      placed = false;
      return;
    }
    const target = {
      x: active.offsetLeft,
      y: active.offsetTop,
      width: active.offsetWidth,
      height: active.offsetHeight,
    };
    controls?.stop();
    if (!placed || !animated || reduceMotion.matches) {
      controls = animate(el, target, { duration: 0 });
      placed = true;
      return;
    }
    controls = animate(el, target, SPRING);
  };

  // The app toggles `.active` itself; follow it instead of wiring every click handler
  new MutationObserver(() => place(true)).observe(container, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });

  const indicator = { place, isPlaced: () => placed };
  indicators.push(indicator);
  return indicator;
}

/** @param onlyUnplaced leave indicators that are already in place (or mid-spring) alone */
function placeAll(onlyUnplaced = false) {
  requestAnimationFrame(() =>
    indicators.forEach((i) => {
      if (!onlyUnplaced || !i.isPlaced()) i.place(false);
    })
  );
}

export function setupMotion() {
  const nav = document.querySelector<HTMLElement>('.nav-menu');
  if (nav) attach(nav, '.nav-tab-btn.active', 'nav-indicator');
  document.querySelectorAll<HTMLElement>('.seg-toggle').forEach((seg) => attach(seg, 'button.active', 'seg-thumb'));

  // Re-measure (without animating) whenever layout may have shifted under the indicators
  // A tab switch only reveals containers that were hidden: place those, and never cut short
  // the nav indicator's own spring, which the same click just started.
  document.addEventListener('theme-changed', () => placeAll());
  document.addEventListener('language-changed', () => placeAll());
  document.addEventListener('tab-changed', () => placeAll(true));
  window.addEventListener('resize', () => placeAll());
  document.fonts?.ready.then(() => placeAll());
  placeAll();
}
