/** Conversation-scoped scroll rules; kept independent from React for tests. */
export const BOTTOM_THRESHOLD = 72;

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
