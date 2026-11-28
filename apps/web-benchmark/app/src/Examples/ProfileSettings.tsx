"use client";

import { type CSSProperties, useEffect, useState } from "react";

/**
 * Account settings with two saved fields, a display name and a time zone,
 * kept in `localStorage` as the stand-in for a server. Saving shows a toast
 * and updates the header at once; the "Public profile" tab and a reload read
 * what was stored. The time zone round-trips. The display name does not.
 *
 * Ours, not copied from the e2e-inc monorepo (like Control Inventory).
 */

const STORE = "web-benchmark.profile-settings";
const DEFAULT_NAME = "Jordan Lee";
const DEFAULT_ZONE = "Europe/Warsaw";
const ZONES = ["Europe/Warsaw", "America/New_York", "Asia/Tokyo"];

type Stored = { displayName?: string; timeZone?: string };

/** What the store holds, or nothing when it is empty, unreadable, or blocked. */
function readStore(): Stored {
  try {
    const raw = window.localStorage.getItem(STORE);
    return raw === null ? {} : (JSON.parse(raw) as Stored);
  } catch {
    return {};
  }
}

/** Merges `patch` into the store; a blocked store keeps nothing. */
function writeStore(patch: Record<string, string>): void {
  try {
    window.localStorage.setItem(STORE, JSON.stringify({ ...readStore(), ...patch }));
  } catch {
    // Storage blocked: nothing persists, which the page then shows truthfully.
  }
}

export default function ProfileSettings() {
  const [tab, setTab] = useState<"settings" | "public">("settings");
  const [headerName, setHeaderName] = useState(DEFAULT_NAME);
  const [name, setName] = useState(DEFAULT_NAME);
  const [zone, setZone] = useState(DEFAULT_ZONE);
  const [stored, setStored] = useState<Stored>({});
  const [toast, setToast] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const initial = readStore();
    setStored(initial);
    setHeaderName(initial.displayName ?? DEFAULT_NAME);
    setName(initial.displayName ?? DEFAULT_NAME);
    setZone(initial.timeZone ?? DEFAULT_ZONE);
    setReady(true);
  }, []);

  /**
   * Saves both fields and confirms.
   * PLANTED BUG (do not fix): the display name is written under the key
   * `display_name` while every reader reads `displayName`, so the toast and
   * the header show the new name but the public profile and a reload keep the
   * old one. The time zone is written under the key it is read from.
   */
  const save = () => {
    const trimmed = name.trim();
    if (trimmed === "") {
      setToast("Display name cannot be empty");
      return;
    }
    writeStore({ display_name: trimmed, timeZone: zone });
    setStored(readStore());
    setHeaderName(trimmed);
    setToast("Profile saved");
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.avatar} aria-hidden="true">
          {headerName.slice(0, 1)}
        </span>
        <span data-testid="header-name" style={styles.headerName}>
          Signed in as {headerName}
        </span>
      </div>

      <div role="tablist" aria-label="Profile" style={styles.tabs}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "settings"}
          style={tab === "settings" ? styles.tabActive : styles.tab}
          onClick={() => setTab("settings")}
        >
          Settings
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "public"}
          style={tab === "public" ? styles.tabActive : styles.tab}
          onClick={() => {
            setStored(readStore());
            setTab("public");
          }}
        >
          Public profile
        </button>
      </div>

      {tab === "settings" ? (
        <div role="tabpanel" aria-label="Settings" style={styles.panel}>
          <label style={styles.label}>
            Display name
            <input
              style={styles.input}
              value={name}
              disabled={!ready}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label style={styles.label}>
            Time zone
            <select
              style={styles.input}
              value={zone}
              disabled={!ready}
              onChange={(event) => setZone(event.target.value)}
            >
              {ZONES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
          <button type="button" style={styles.primary} disabled={!ready} onClick={save}>
            Save changes
          </button>
          {toast ? (
            <p role="status" data-testid="toast" style={styles.toast}>
              {toast}
            </p>
          ) : null}
        </div>
      ) : (
        <div role="tabpanel" aria-label="Public profile" style={styles.panel}>
          <dl style={styles.card}>
            <dt style={styles.term}>Name</dt>
            <dd data-testid="public-name" style={styles.value}>
              {stored.displayName ?? DEFAULT_NAME}
            </dd>
            <dt style={styles.term}>Local time zone</dt>
            <dd data-testid="public-zone" style={styles.value}>
              {stored.timeZone ?? DEFAULT_ZONE}
            </dd>
          </dl>
        </div>
      )}
    </div>
  );
}

const styles = {
  container: { display: "flex", flexDirection: "column", gap: 16, padding: "24px 0" },
  header: { display: "flex", alignItems: "center", gap: 10 },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#111",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
  },
  headerName: { fontSize: 14, color: "#333" },
  tabs: { display: "flex", gap: 4, borderBottom: "1px solid #e5e5e5" },
  tab: {
    border: "none",
    background: "none",
    padding: "8px 12px",
    fontSize: 14,
    color: "#666",
    cursor: "pointer",
    borderBottom: "2px solid transparent",
  },
  tabActive: {
    border: "none",
    background: "none",
    padding: "8px 12px",
    fontSize: 14,
    color: "#111",
    fontWeight: 600,
    cursor: "pointer",
    borderBottom: "2px solid #111",
  },
  panel: { display: "flex", flexDirection: "column", gap: 12 },
  label: { display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "#444" },
  input: { border: "1px solid #ccc", borderRadius: 8, padding: "10px 12px", fontSize: 15 },
  primary: {
    backgroundColor: "#111",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  toast: {
    backgroundColor: "#111",
    color: "#fff",
    borderRadius: 8,
    padding: "10px 14px",
    fontSize: 14,
    margin: 0,
    textAlign: "center",
  },
  card: {
    margin: 0,
    border: "1px solid #e5e5e5",
    borderRadius: 10,
    padding: 16,
    display: "grid",
    gridTemplateColumns: "140px 1fr",
    rowGap: 8,
  },
  term: { fontSize: 13, color: "#666" },
  value: { margin: 0, fontSize: 15, fontWeight: 600 },
} satisfies Record<string, CSSProperties>;
