import { NAV_COLLAPSE_QUERY } from './nav.ts';

/**
 * Progressive enhancement for header disclosures (`<details>`).
 * Open/close already works without JS; this adds Escape, click-outside,
 * exclusive open, and explicit `aria-expanded`.
 */
export function initSiteNav(root: ParentNode = document): void {
  const nav = root.querySelector<HTMLElement>('[data-site-nav]');
  if (!nav || nav.dataset.navReady === 'true') return;
  nav.dataset.navReady = 'true';

  const disclosures = [...nav.querySelectorAll<HTMLDetailsElement>('[data-nav-disclosure]')];
  if (disclosures.length === 0) return;

  const syncExpanded = (details: HTMLDetailsElement) => {
    const trigger = details.querySelector<HTMLElement>('[data-nav-trigger]');
    trigger?.setAttribute('aria-expanded', details.open ? 'true' : 'false');
  };

  const close = (details: HTMLDetailsElement) => {
    if (!details.open) return;
    details.open = false;
    syncExpanded(details);
  };

  const closeAll = (except?: HTMLDetailsElement) => {
    for (const details of disclosures) {
      if (details !== except) close(details);
    }
  };

  for (const details of disclosures) {
    syncExpanded(details);
    details.addEventListener('toggle', () => {
      if (details.open) closeAll(details);
      syncExpanded(details);
    });

    details.addEventListener('focusout', (event) => {
      const next = event.relatedTarget;
      if (next instanceof Node && details.contains(next)) return;
      if (!(next instanceof Node)) return;
      close(details);
    });
  }

  nav.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = disclosures.find((details) => details.open);
    if (!open) return;
    event.preventDefault();
    close(open);
    open.querySelector<HTMLElement>('[data-nav-trigger]')?.focus();
  });

  document.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    for (const details of disclosures) {
      if (details.open && !details.contains(target)) close(details);
    }
  });

  nav.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest('a');
    if (!link) return;
    const details = link.closest('details');
    if (details instanceof HTMLDetailsElement && disclosures.includes(details)) {
      close(details);
    }
  });

  const media = window.matchMedia(NAV_COLLAPSE_QUERY);
  const onViewportChange = () => closeAll();
  media.addEventListener('change', onViewportChange);
}
