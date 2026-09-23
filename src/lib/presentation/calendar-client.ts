import { isCalendarAddMethod, onOutboundClick, trackCalendarAddClicked } from '../analytics/product.ts';
import { planShareMenuPlacement } from './share.ts';

const LISTENER_FLAG = 'calendarListenersReady';

/**
 * Menu behaviour for the event ficha. The provider links are real URLs; this
 * script only places the popover, closes it, and records the chosen method.
 * It never calls preventDefault on those links.
 */
export function initCalendarActions(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-calendar]')) {
    bindCalendarAction(node);
  }
  if (typeof document === 'undefined') return;
  if (document.documentElement.dataset[LISTENER_FLAG] === 'true') return;
  document.documentElement.dataset[LISTENER_FLAG] = 'true';
  document.addEventListener('keydown', onEscape);
  document.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('resize', () => {
    for (const open of document.querySelectorAll<HTMLElement>('details[data-calendar][open]')) {
      alignCalendarMenu(open);
    }
  });
}

function bindCalendarAction(root: HTMLElement): void {
  if (root.dataset.calendarReady === 'true') return;
  root.dataset.calendarReady = 'true';

  root.addEventListener('toggle', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLDetailsElement) || !(root instanceof HTMLDetailsElement)) return;
    if (target === root) {
      if (!root.open) {
        closeDates(root);
        return;
      }
      alignCalendarMenu(root);
      return;
    }
    if (!root.open || !target.matches('[data-calendar-date]')) return;
    if (target.open) closeOtherDates(root, target);
    alignCalendarMenu(root);
  });

  for (const link of root.querySelectorAll<HTMLAnchorElement>('[data-calendar-method]')) {
    link.addEventListener('click', () => {
      onOutboundClick(() => {
        const method = link.dataset.calendarMethod;
        const occurrenceId = link.dataset.occurrenceId;
        const confirmed = link.dataset.confirmedTime;
        if (!isCalendarAddMethod(method) || !occurrenceId) return;
        if (confirmed !== 'true' && confirmed !== 'false') return;
        trackCalendarAddClicked({
          event_id: root.dataset.calendarEventId ?? '',
          event_title: root.dataset.calendarEventTitle,
          occurrence_id: occurrenceId,
          method,
          has_confirmed_time: confirmed === 'true',
        });
      });
    });
  }
}

function closeDates(root: HTMLElement): void {
  for (const inner of root.querySelectorAll<HTMLDetailsElement>('details[data-calendar-date][open]')) {
    inner.open = false;
  }
}

function closeOtherDates(root: HTMLElement, current: HTMLDetailsElement): void {
  for (const other of root.querySelectorAll<HTMLDetailsElement>('details[data-calendar-date][open]')) {
    if (other !== current) other.open = false;
  }
}

function closeCalendar(root: HTMLDetailsElement, restoreFocus: boolean): void {
  closeDates(root);
  root.open = false;
  if (restoreFocus) root.querySelector('summary')?.focus();
}

function alignCalendarMenu(root: HTMLElement): void {
  const menu = root.querySelector<HTMLElement>('[data-calendar-menu]');
  const trigger = root.querySelector('summary');
  if (!menu || !trigger) return;

  menu.classList.remove('is-align-end', 'is-align-above');
  menu.style.left = '';
  menu.style.right = '';
  menu.style.top = '';
  menu.style.bottom = '';
  menu.style.maxWidth = '';
  menu.style.maxHeight = '';

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

  menu.classList.toggle('is-align-end', plan.alignEnd);
  menu.classList.toggle('is-align-above', plan.alignAbove);
  if (plan.offsetLeft !== null) menu.style.left = `${plan.offsetLeft}px`;
  if (plan.maxWidth !== null) menu.style.maxWidth = `${plan.maxWidth}px`;

  const available = plan.alignAbove
    ? triggerRect.top - 8
    : window.innerHeight - triggerRect.bottom - 8;
  menu.style.maxHeight = `${Math.max(44, available)}px`;
}

function onEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  const open = document.querySelector<HTMLDetailsElement>('details[data-calendar][open]');
  if (!open) return;
  event.preventDefault();
  closeCalendar(open, true);
}

function onPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  for (const open of document.querySelectorAll<HTMLDetailsElement>('details[data-calendar][open]')) {
    if (!open.contains(target)) open.open = false;
  }
}
