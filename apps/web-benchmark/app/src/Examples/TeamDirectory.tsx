"use client";

import { type CSSProperties, useState } from "react";

/**
 * A member table where names repeat: two people are called Alex Kim, a third
 * is Alex Kimball, and every row's controls carry the same names ("Suspend",
 * "Remove"). Only the other columns tell the rows apart. The member to act on
 * is named by email only, in the open security alert above the table; a
 * resolved alert names the other Alex Kim. The task changes one
 * row; touching any other row is recorded (the root's `data-changed-others`,
 * kept off screen like a real app would) and blocks the success state, so
 * picking the first match by name fails.
 *
 * Ours, not copied from the e2e-inc monorepo (like Control Inventory).
 */

type Member = { id: string; name: string; email: string; team: string; office: string };

const MEMBERS: Member[] = [
  { id: "m1", name: "Alex Kimball", email: "akimball@acme.test", team: "Design", office: "Toronto" },
  { id: "m2", name: "Alex Kim", email: "alex.kim@acme.test", team: "Engineering", office: "Berlin" },
  { id: "m3", name: "Maya Fischer", email: "maya@acme.test", team: "Sales", office: "Toronto" },
  { id: "m4", name: "Alex Kim", email: "akim@acme.test", team: "Sales", office: "Toronto" },
  { id: "m5", name: "Jonas Weber", email: "jonas@acme.test", team: "Engineering", office: "Berlin" },
  { id: "m6", name: "Alexa Kim", email: "alexa@acme.test", team: "Support", office: "Toronto" },
];

const TARGET = "m4";

export default function TeamDirectory() {
  const [suspended, setSuspended] = useState<ReadonlySet<string>>(new Set());
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);

  /** Flips one member between active and suspended. */
  const toggle = (id: string) => {
    setSuspended((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const collateral = MEMBERS.filter(
    (member) => member.id !== TARGET && (suspended.has(member.id) || removed.has(member.id)),
  );
  const done = suspended.has(TARGET) && !removed.has(TARGET) && collateral.length === 0;

  return (
    <div
      data-testid="team-directory"
      data-changed-others={collateral.map((member) => member.email).join(" ")}
      style={styles.container}
    >
      <section aria-label="Security alerts" style={styles.alerts}>
        <h2 style={styles.alertsTitle}>Security alerts</h2>
        <article style={styles.alertOpen}>
          <strong>Open</strong> · Five failed sign-ins, then a sign-in from a new country, for
          akim@acme.test. Suspend the account until its owner confirms it was them.
        </article>
        <article style={styles.alertResolved}>
          <strong>Resolved</strong> · Password reset requested for alex.kim@acme.test; the owner
          confirmed it yesterday. No action needed.
        </article>
      </section>
      <p style={styles.lead}>
        Members of Acme. Suspending keeps the account but blocks sign-in; removing deletes it.
      </p>
      <table style={styles.table} aria-label="Members">
        <thead>
          <tr>
            <th style={styles.th} scope="col">
              Name
            </th>
            <th style={styles.th} scope="col">
              Email
            </th>
            <th style={styles.th} scope="col">
              Team
            </th>
            <th style={styles.th} scope="col">
              Office
            </th>
            <th style={styles.th} scope="col">
              Status
            </th>
            <th style={styles.th} scope="col">
              <span style={styles.visuallyHidden}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {MEMBERS.filter((member) => !removed.has(member.id)).map((member) => {
            const isSuspended = suspended.has(member.id);
            return (
              <tr key={member.id} data-testid={`member-${member.id}`}>
                <td style={styles.td}>{member.name}</td>
                <td style={styles.td}>{member.email}</td>
                <td style={styles.td}>{member.team}</td>
                <td style={styles.td}>{member.office}</td>
                <td style={styles.td}>{isSuspended ? "Suspended" : "Active"}</td>
                <td style={styles.actions}>
                  <button type="button" style={styles.button} onClick={() => toggle(member.id)}>
                    {isSuspended ? "Reactivate" : "Suspend"}
                  </button>
                  <button
                    type="button"
                    style={styles.danger}
                    onClick={() => setPendingRemoval(member.id)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {pendingRemoval !== null ? (
        <div role="dialog" aria-label="Remove member" style={styles.dialog}>
          <p style={styles.dialogText}>
            Remove {MEMBERS.find((member) => member.id === pendingRemoval)?.email}? This deletes
            the account.
          </p>
          <div style={styles.dialogActions}>
            <button
              type="button"
              style={styles.danger}
              onClick={() => {
                setRemoved((current) => new Set(current).add(pendingRemoval));
                setPendingRemoval(null);
              }}
            >
              Remove member
            </button>
            <button type="button" style={styles.button} onClick={() => setPendingRemoval(null)}>
              Keep member
            </button>
          </div>
        </div>
      ) : null}

      {done ? (
        <p data-testid="success-message" style={styles.success}>
          Suspended akim@acme.test only
        </p>
      ) : null}
    </div>
  );
}

const styles = {
  container: { display: "flex", flexDirection: "column", gap: 14, padding: "24px 0" },
  lead: { margin: 0, fontSize: 14, color: "#555" },
  alerts: { display: "flex", flexDirection: "column", gap: 6 },
  alertsTitle: { margin: 0, fontSize: 15 },
  alertOpen: {
    padding: "8px 12px",
    borderRadius: 8,
    backgroundColor: "#fff1f0",
    border: "1px solid #f5c2c0",
    fontSize: 13,
  },
  alertResolved: {
    padding: "8px 12px",
    borderRadius: 8,
    backgroundColor: "#f4f4f4",
    border: "1px solid #e2e2e2",
    fontSize: 13,
    color: "#666",
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    textAlign: "left",
    padding: "8px 6px",
    borderBottom: "2px solid #ddd",
    fontWeight: 600,
    color: "#444",
  },
  td: { padding: "8px 6px", borderBottom: "1px solid #eee" },
  actions: { padding: "6px", borderBottom: "1px solid #eee", display: "flex", gap: 6 },
  visuallyHidden: {
    position: "absolute",
    width: 1,
    height: 1,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
  },
  button: {
    border: "1px solid #ccc",
    backgroundColor: "#fff",
    borderRadius: 6,
    padding: "5px 10px",
    fontSize: 12,
    cursor: "pointer",
  },
  danger: {
    border: "1px solid #b00020",
    color: "#b00020",
    backgroundColor: "#fff",
    borderRadius: 6,
    padding: "5px 10px",
    fontSize: 12,
    cursor: "pointer",
  },
  dialog: {
    border: "1px solid #ccc",
    borderRadius: 10,
    padding: 14,
    backgroundColor: "#fafafa",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  dialogText: { margin: 0, fontSize: 14 },
  dialogActions: { display: "flex", gap: 8 },
  success: { margin: 0, color: "#0a7a2f", fontSize: 18, fontWeight: 600, textAlign: "center" },
} satisfies Record<string, CSSProperties>;
