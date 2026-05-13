"use client";

// The legacy SessionThreadView (./view) subscribes to the harness /event
// SSE expecting the pre-refactor BusEvent shape. After the unified
// SessionEvent migration the harness emits a different wire shape, so
// that view never recognises anything and the page sits forever on
// "Waiting for the first SDK message…". Render the new events-based
// view from /events/page.tsx as the primary session page until the full
// legacy-view rewrite lands.

import SessionEventsView from "./events/page";

export default function SessionThreadPage() {
  return <SessionEventsView />;
}
