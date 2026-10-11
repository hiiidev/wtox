/** Aggregate genuinely unread incoming text messages by Tox peer. */
export function unreadCountsByPeer(messages, seen = {}) {
  const counts = new Map();
  for (const event of messages || []) {
    if (event?.type !== "message" || event.direction !== "incoming" ||
        !event.public_key || !Number.isFinite(event.at)) continue;
    if (event.at <= (Number(seen[event.public_key]) || 0)) continue;
    counts.set(event.public_key, (counts.get(event.public_key) || 0) + 1);
  }
  return counts;
}

/** Don't count stale messages from an identity no longer in the friends list. */
export function totalUnreadForFriends(counts, friends) {
  return (friends || []).reduce((sum, friend) =>
    sum + (counts.get(friend.public_key) || 0), 0);
}
