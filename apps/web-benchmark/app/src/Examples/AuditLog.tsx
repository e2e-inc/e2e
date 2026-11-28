"use client";

import { type CSSProperties, useState } from "react";

/**
 * A paginated audit log of 47 numbered events, newest first, ten per page.
 * The event numbers are consecutive and the footer names each page's range,
 * so a page's rows can be checked against its own footer, and the end of one
 * page against the start of the next.
 *
 * Ours, not copied from the e2e-inc monorepo (like Control Inventory).
 */

const PAGE_SIZE = 10;
const ACTORS = ["ana@acme.test", "bo@acme.test", "chen@acme.test", "dev@acme.test"];
const ACTIONS = [
  "Signed in",
  "Changed a member's role",
  "Rotated an API key",
  "Exported billing data",
  "Updated the SSO settings",
  "Invited a member",
  "Removed a member",
];

type Event = { number: number; actor: string; action: string; at: string };

/** The 47 events, newest first; every field is a pure function of the event number. */
const EVENTS: Event[] = Array.from({ length: 47 }, (_, index) => {
  const number = 47 - index;
  const minutes = number * 37;
  const day = 1 + Math.floor(minutes / (24 * 60));
  const hour = Math.floor((minutes % (24 * 60)) / 60);
  const minute = minutes % 60;
  return {
    number,
    actor: ACTORS[number % ACTORS.length]!,
    action: ACTIONS[number % ACTIONS.length]!,
    at: `2026-11-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
});

const PAGES = Math.ceil(EVENTS.length / PAGE_SIZE);

/**
 * The slice of events one page shows.
 * PLANTED BUG (do not fix): page 2 starts one event too late and still ends
 * where it should, so it lists nine events and event 37, the 11th newest, is
 * on no page. Its footer still reads "Showing 11-20 of 47". Every other page
 * is right.
 */
function pageSlice(page: number): Event[] {
  const end = page * PAGE_SIZE;
  const start = page === 2 ? PAGE_SIZE + 1 : end - PAGE_SIZE;
  return EVENTS.slice(start, end);
}

export default function AuditLog() {
  const [page, setPage] = useState(1);
  const rows = pageSlice(page);
  const first = (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(page * PAGE_SIZE, EVENTS.length);

  return (
    <div style={styles.container}>
      <table style={styles.table} aria-label="Audit log">
        <thead>
          <tr>
            <th style={styles.th} scope="col">
              Event
            </th>
            <th style={styles.th} scope="col">
              Time (UTC)
            </th>
            <th style={styles.th} scope="col">
              Actor
            </th>
            <th style={styles.th} scope="col">
              Action
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((event) => (
            <tr key={event.number} data-testid={`event-${event.number}`}>
              <td style={styles.td}>#{event.number}</td>
              <td style={styles.td}>{event.at}</td>
              <td style={styles.td}>{event.actor}</td>
              <td style={styles.td}>{event.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <nav aria-label="Pagination" style={styles.pager}>
        <button
          type="button"
          style={styles.pageButton}
          disabled={page === 1}
          onClick={() => setPage((current) => current - 1)}
        >
          Previous
        </button>
        <span data-testid="page-range" style={styles.range}>
          Showing {first}-{last} of {EVENTS.length} · page {page} of {PAGES}
        </span>
        <button
          type="button"
          style={styles.pageButton}
          disabled={page === PAGES}
          onClick={() => setPage((current) => current + 1)}
        >
          Next
        </button>
      </nav>
    </div>
  );
}

const styles = {
  container: { display: "flex", flexDirection: "column", gap: 12, padding: "24px 0" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    textAlign: "left",
    padding: "8px 6px",
    borderBottom: "2px solid #ddd",
    fontWeight: 600,
    color: "#444",
  },
  td: { padding: "7px 6px", borderBottom: "1px solid #eee" },
  pager: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  range: { fontSize: 13, color: "#555" },
  pageButton: {
    border: "1px solid #ccc",
    backgroundColor: "#fff",
    borderRadius: 6,
    padding: "6px 12px",
    fontSize: 13,
    cursor: "pointer",
  },
} satisfies Record<string, CSSProperties>;
