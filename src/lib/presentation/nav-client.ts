import { NAV_COLLAPSE_QUERY } from './nav.ts';

/**
 * Header disclosures: Más (desktop) and the mobile section menu.
 * Markup is a `<button>` plus a `hidden` panel so the trigger is a real
 * button with `aria-expanded` / `aria-controls`.
 */
export function initSiteNav(root: ParentNode = document): void {
  const nav = root.querySelector<HTMLElement>('[data-site-nav]');
  if (!nav || nav.dataset.navReady === 'true') return;
  nav.dataset.navReady = 'true';

  const disclosures = [...nav.querySelectorAll<HTMLElement>('[data-nav-disclosure]')];
  if (disclosures.length === 0) return;

  const triggerOf = (disclosure: HTMLElement) =>
    disclosure.querySelector<HTMLElement>('[data-nav-trigger]');
  const panelOf = (disclosure: HTMLElement) =>
    disclosure.querySelector<HTMLElement>('[data-nav-panel]');
  const isOpen = (disclosure: HTMLElement) => disclosure.dataset.navOpen === 'true';

  const setOpen = (disclosure: HTMLElement, open: boolean) => {
    disclosure.dataset.navOpen = open ? 'true' : 'false';
    triggerOf(disclosure)?.setAttribute('aria-expanded', open ? 'true' : 'false');
    const panel = panelOf(disclosure);
    if (panel) panel.hidden = !open;
  };

  const close = (disclosure: HTMLElement) => setOpen(disclosure, false);
  const closeAll = (except?: HTMLElement) => {
    for (const disclosure of disclosures) {
      if (disclosure !== except) close(disclosure);
    }
  };

  for (const disclosure of disclosures) {
    setOpen(disclosure, false);
    triggerOf(disclosure)?.addEventListener('click', () => {
      if (isOpen(disclosure)) {
        close(disclosure);
        return;
      }
      closeAll(disclosure);
      setOpen(disclosure, true);
    });

    disclosure.addEventListener('focusout', (event) => {
      const next = event.relatedTarget;
      if (next instanceof Node && disclosure.contains(next)) return;
      if (!(next instanceof Node)) return;
      close(disclosure);
    });
  }

  nav.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = disclosures.find(isOpen);
    if (!open) return;
    event.preventDefault();
    close(open);
    triggerOf(open)?.focus();
  });

  document.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    for (const disclosure of disclosures) {
      if (isOpen(disclosure) && !disclosure.contains(target)) close(disclosure);
    }
  });

  nav.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest('a');
    if (!link) return;
    const disclosure = link.closest<HTMLElement>('[data-nav-disclosure]');
    if (disclosure && disclosures.includes(disclosure)) close(disclosure);
  });

  window.matchMedia(NAV_COLLAPSE_QUERY).addEventListener('change', () => closeAll());
}
