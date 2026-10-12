/** Conversation-scoped scroll rules; kept independent from React for tests. */
export const BOTTOM_THRESHOLD = 72;

/** Ignore gestures that did not actually move the scroll viewport upward. */
export function didUserScrollUp(previousTop, currentTop, hasUpwardIntent) {
  return Boolean(hasUpwardIntent) && previousTop - currentTop > 2;
}

/** A little tolerance avoids turning auto-follow off on fractional/mobile layouts. */
export function isNearBottom(element, threshold = BOTTOM_THRESHOLD) {
  if (!element) return true;
  return element.scrollHeight - element.clientHeight - element.scrollTop <= threshold;
}

/** Delivery-status updates must not be mistaken for newly received messages. */
export function countNewEntries(previousIds, nextIds) {
  const previous = new Set(previousIds);
  return nextIds.reduce((total, id) => total + (previous.has(id) ? 0 : 1), 0);
}

/** Scroll to the actual end of the scroll container, including message
 * footers, translation blocks and bottom spacing after the last bubble. */
export function scrollThreadToBottom(element) {
  if (!element) return;
  element.scrollTop = Math.max(0,element.scrollHeight - element.clientHeight);
}

/** The scrollable element is .ant-thread, NOT a bubble or its footer.
 * Never report initial alignment while mobile CSS has display:none.
 * Returns false when the element has no measured viewport yet, so the caller
 * can keep the new thread visually hidden until ResizeObserver sees it.
 */
export function alignFullThreadBottom(element) {
  if (!element || element.clientWidth<=0 || element.clientHeight<=0) return false;
  scrollThreadToBottom(element);
  const end=Math.max(0,element.scrollHeight-element.clientHeight);
  return Math.abs(element.scrollTop-end)<=2;
}
