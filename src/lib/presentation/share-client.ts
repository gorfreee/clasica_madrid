import { captureContentShared } from '../analytics/capture.ts';
import { shareCopiedLabel, shareCopyFailedLabel } from './labels.ts';
import {
  attributedShareUrl,
  canUseWebShare,
  canonicalSharePath,
  isShareCancellation,
  planShareMenuPlacement,
  whatsappShareHref,
  type ShareContentType,
  type ShareMethod,
  type SharePayload,
} from './share.ts';

const LISTENER_FLAG = 'shareListenersReady';

/**
 * One behaviour for every ficha. Web Share is invoked synchronously from the
 * summary click so the browser keeps the user activation. `<details>` stays
 * the no-JS menu.
 */
export function initShareActions(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-share]')) {
    bindShareAction(node);
  }
  if (typeof document === 'undefined') return;
  if (document.documentElement.dataset[LISTENER_FLAG] === 'true') return;
  document.documentElement.dataset[LISTENER_FLAG] = 'true';
  document.addEventListener('keydown', onEscape);
  document.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('resize', () => {
    for (const open of document.querySelectorAll<HTMLElement>('details[data-share][open]')) {
      alignShareMenu(open);
    }
  });
}

function bindShareAction(root: HTMLElement): void {
  if (root.dataset.shareReady === 'true') return;
  root.dataset.shareReady = 'true';

  const summary = root.querySelector('summary');
  const whatsapp = root.querySelector<HTMLAnchorElement>('[data-share-whatsapp]');
  const copyButton = root.querySelector<HTMLButtonElement>('[data-share-copy]');
  if (!summary) return;

  const shareUrl = (method: ShareMethod): string =>
    attributedShareUrl(window.location.origin, root.dataset.sharePath ?? '', method);

  const payload = (): SharePayload => ({
    title: root.dataset.shareTitle ?? '',
    text: root.dataset.shareText ?? '',
    url: shareUrl('native_share'),
  });

  const refreshWhatsapp = () => {
    if (!whatsapp) return;
    const data = payload();
    whatsapp.href = whatsappShareHref(data.text, shareUrl('whatsapp'));
  };
  refreshWhatsapp();

  let suppressOpen = false;

  summary.addEventListener('click', (event) => {
    const data = payload();
    const share = navigator.share?.bind(navigator);
    const canShare = navigator.canShare?.bind(navigator);
    if (!share || !canUseWebShare({ share, canShare }, data)) return;
    if (root instanceof HTMLDetailsElement && root.open) return;
    event.preventDefault();
    suppressOpen = true;
    if (root instanceof HTMLDetailsElement) root.open = false;
    share(data).then(
      () => {
        suppressOpen = false;
        resetShareFeedback(root);
        trackShare(root, 'native_share');
      },
      (error: unknown) => {
        suppressOpen = false;
        if (isShareCancellation(error)) return;
        if (root instanceof HTMLDetailsElement) root.open = true;
      },
    );
  });

  root.addEventListener('toggle', () => {
    if (suppressOpen && root instanceof HTMLDetailsElement && root.open) {
      root.open = false;
      return;
    }
    if (!(root instanceof HTMLDetailsElement) || !root.open) {
      resetShareFeedback(root);
      return;
    }
    alignShareMenu(root);
  });

  root.addEventListener('focusout', (event) => {
    if (!(root instanceof HTMLDetailsElement) || !root.open) return;
    const next = event.relatedTarget;
    if (next instanceof Node && root.contains(next)) return;
    if (!(next instanceof Node)) return;
    root.open = false;
  });

  whatsapp?.addEventListener('click', () => {
    trackShare(root, 'whatsapp');
  });

  copyButton?.addEventListener('click', () => {
    const url = shareUrl('copy_link');
    const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (typeof writeText !== 'function') {
      finishCopy(root, url, copyWithExecCommand(root, url));
      return;
    }
    writeText(url).then(
      () => finishCopy(root, url, true),
      () => finishCopy(root, url, copyWithExecCommand(root, url)),
    );
  });
}

function trackShare(root: HTMLElement, method: ShareMethod): void {
  const contentType = root.dataset.shareContentType;
  if (!isShareContentType(contentType)) return;
  captureContentShared({
    method,
    content_type: contentType,
    path: canonicalSharePath(root.dataset.sharePath ?? ''),
  });
}

function isShareContentType(value: string | undefined): value is ShareContentType {
  return value === 'event' || value === 'venue';
}

function finishCopy(root: HTMLElement, url: string, copied: boolean): void {
  if (copied) {
    hideManualCopy(root);
    setFeedback(root, shareCopiedLabel);
    trackShare(root, 'copy_link');
    return;
  }
  setFeedback(root, shareCopyFailedLabel);
  revealManualCopy(root, url);
}

function alignShareMenu(root: HTMLElement): void {
  const menu = root.querySelector<HTMLElement>('[data-share-menu]');
  const trigger = root.querySelector('summary');
  if (!menu || !trigger) return;

  menu.classList.remove('is-align-end', 'is-align-above');
  menu.style.position = '';
  menu.style.top = '';
  menu.style.right = '';
  menu.style.bottom = '';
  menu.style.left = '';
  menu.style.maxWidth = '';

  const triggerRect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const plan = planShareMenuPlacement({
    triggerLeft: triggerRect.left,
    triggerWidth: triggerRect.width,
    menuWidth: menuRect.width,
    menuHeight: menuRect.height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    triggerTop: triggerRect.top,
    triggerBottom: triggerRect.bottom,
  });

  applyShareMenuPlan(menu, plan);
  // The venue ficha sits in a hero with overflow:clip. An absolute menu that
  // crosses that edge is painted and hit-tested as if it were not there.
  if (isClippedByAncestor(menu)) pinShareMenu(menu, trigger, plan);
}

function applyShareMenuPlan(menu: HTMLElement, plan: ReturnType<typeof planShareMenuPlacement>): void {
  menu.classList.toggle('is-align-end', plan.alignEnd);
  menu.classList.toggle('is-align-above', plan.alignAbove);
  if (plan.offsetLeft !== null) menu.style.left = `${plan.offsetLeft}px`;
  if (plan.maxWidth !== null) menu.style.maxWidth = `${plan.maxWidth}px`;
}

function isClippedByAncestor(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  let parent = element.parentElement;
  while (parent) {
    const { overflowX, overflowY } = getComputedStyle(parent);
    if (clips(overflowX) || clips(overflowY)) {
      const bounds = parent.getBoundingClientRect();
      if (
        rect.top < bounds.top - 1 ||
        rect.bottom > bounds.bottom + 1 ||
        rect.left < bounds.left - 1 ||
        rect.right > bounds.right + 1
      ) {
        return true;
      }
    }
    parent = parent.parentElement;
  }
  return false;
}

function clips(overflow: string): boolean {
  return overflow === 'hidden' || overflow === 'clip' || overflow === 'scroll' || overflow === 'auto';
}

function pinShareMenu(
  menu: HTMLElement,
  trigger: HTMLElement,
  plan: ReturnType<typeof planShareMenuPlacement>,
): void {
  const triggerRect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const margin = 8;
  const width = menuRect.width;
  const height = menuRect.height;
  let left = plan.alignEnd ? triggerRect.right - width : triggerRect.left;
  if (plan.offsetLeft !== null) left = triggerRect.left + plan.offsetLeft;
  let top = plan.alignAbove ? triggerRect.top - height - 3 : triggerRect.bottom + 3;
  left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin));
  top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - margin));
  menu.classList.remove('is-align-end', 'is-align-above');
  menu.style.position = 'fixed';
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.style.right = 'auto';
  menu.style.bottom = 'auto';
  menu.style.maxWidth = `${plan.maxWidth ?? Math.max(0, window.innerWidth - margin * 2)}px`;
}

function setFeedback(root: HTMLElement, message: string): void {
  const feedback = root.querySelector<HTMLElement>('[data-share-feedback]');
  if (feedback) feedback.textContent = message;
}

function resetShareFeedback(root: HTMLElement): void {
  setFeedback(root, '');
  hideManualCopy(root);
}

function hideManualCopy(root: HTMLElement): void {
  const input = root.querySelector<HTMLInputElement>('[data-share-manual]');
  if (!input) return;
  input.hidden = true;
  input.value = '';
}

function revealManualCopy(root: HTMLElement, url: string): void {
  const input = root.querySelector<HTMLInputElement>('[data-share-manual]');
  if (!input) return;
  input.hidden = false;
  input.value = url;
  input.focus();
  input.select();
}

function copyWithExecCommand(root: HTMLElement, text: string): boolean {
  const active = document.activeElement;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.tabIndex = -1;
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.width = '1px';
  area.style.height = '1px';
  area.style.opacity = '0';
  root.append(area);
  area.focus();
  area.select();
  let ok = false;
  try {
    // Last local fallback when Clipboard API is missing or rejects. Kept inside
    // the same click so the browser still treats it as a user copy.
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  if (active instanceof HTMLElement) active.focus();
  return ok;
}

function onEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  const open = document.querySelector<HTMLDetailsElement>('details[data-share][open]');
  if (!open) return;
  event.preventDefault();
  open.open = false;
  open.querySelector('summary')?.focus();
}

function onPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  for (const open of document.querySelectorAll<HTMLDetailsElement>('details[data-share][open]')) {
    if (!open.contains(target)) open.open = false;
  }
}
