"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";

/**
 * A checkout whose card number, expiry, and security code each live in their
 * own iframe, the way hosted payment fields do. The frames are sandboxed
 * without `allow-same-origin`, so each runs in an opaque origin: the page
 * cannot read them, and they talk to it only through `postMessage`. Each
 * field rewrites its value as you type (digit groups, a "MM / YY" slash), and
 * a completed field moves focus into the next frame. The page enables Pay
 * only when all three frames report a valid value.
 *
 * The frames stay on the app's site (srcdoc), so the agent's observation reads
 * them; a frame from another site is left out of observations by design.
 *
 * Ours, not copied from the e2e-inc monorepo (like Control Inventory).
 */

type Field = "number" | "expiry" | "cvc";
const ORDER: Field[] = ["number", "expiry", "cvc"];

/**
 * The script every field frame runs. `FIELD` selects the mask and the check;
 * the frame reports `{ field, valid, last4, value }` to the page after every
 * input (the expiry and code as typed, the number only as its last four),
 * asks the page to move focus when its value turns valid, and focuses its own
 * input when the page says so.
 */
const FRAME_SCRIPT = `
  var input = document.getElementById("field");
  var hint = document.getElementById("hint");
  var wasValid = false;
  function digits(value) { return value.replace(/\\D/g, ""); }
  function luhn(number) {
    var sum = 0;
    for (var i = 0; i < number.length; i++) {
      var d = Number(number[number.length - 1 - i]);
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    return sum % 10 === 0;
  }
  function format(raw) {
    var d = digits(raw);
    if (FIELD === "number") return d.slice(0, 16).replace(/(\\d{4})(?=\\d)/g, "$1 ");
    if (FIELD === "expiry") {
      d = d.slice(0, 4);
      return d.length > 2 ? d.slice(0, 2) + " / " + d.slice(2) : d;
    }
    return d.slice(0, 3);
  }
  function check(value) {
    var d = digits(value);
    if (FIELD === "number") {
      if (d.length < 16) return { valid: false, complete: false, message: "" };
      return luhn(d)
        ? { valid: true, complete: true, message: "" }
        : { valid: false, complete: true, message: "Your card number is invalid." };
    }
    if (FIELD === "expiry") {
      if (d.length < 4) return { valid: false, complete: false, message: "" };
      var month = Number(d.slice(0, 2));
      var year = Number(d.slice(2));
      if (month < 1 || month > 12) return { valid: false, complete: true, message: "Your card's expiration month is invalid." };
      if (year * 100 + month < 2612) return { valid: false, complete: true, message: "Your card's expiration date is in the past." };
      return { valid: true, complete: true, message: "" };
    }
    return d.length === 3
      ? { valid: true, complete: true, message: "" }
      : { valid: false, complete: false, message: "" };
  }
  input.addEventListener("input", function () {
    input.value = format(input.value);
    var result = check(input.value);
    hint.textContent = result.message;
    input.setAttribute("aria-invalid", result.message ? "true" : "false");
    var last4 = FIELD === "number" && result.valid ? digits(input.value).slice(-4) : null;
    var value = FIELD === "number" ? null : input.value;
    parent.postMessage({ type: "card-field", field: FIELD, valid: result.valid, last4: last4, value: value }, "*");
    if (result.valid && !wasValid) parent.postMessage({ type: "card-field-complete", field: FIELD }, "*");
    wasValid = result.valid;
  });
  window.addEventListener("message", function (event) {
    if (event.source === parent && event.data && event.data.type === "focus") input.focus();
  });
`;

/** The document of one field frame. */
function frameDocument(field: Field, label: string, placeholder: string): string {
  return `<!DOCTYPE html>
<html>
  <body style="margin:0;font-family:sans-serif;">
    <label for="field" style="display:block;font-size:12px;color:#555;margin-bottom:4px;">${label}</label>
    <input id="field" inputmode="numeric" autocomplete="off" placeholder="${placeholder}"
      style="box-sizing:border-box;width:100%;border:1px solid #ccc;border-radius:8px;padding:10px 12px;font-size:16px;font-family:monospace;" />
    <p id="hint" role="alert" style="margin:4px 0 0;font-size:12px;color:#b00020;min-height:14px;"></p>
    <script>var FIELD = ${JSON.stringify(field)};${FRAME_SCRIPT}</script>
  </body>
</html>`;
}

const FRAMES: Record<Field, { title: string; doc: string; height: number }> = {
  number: {
    title: "Secure card number input",
    doc: frameDocument("number", "Card number", "1234 1234 1234 1234"),
    height: 84,
  },
  expiry: {
    title: "Secure expiration date input",
    doc: frameDocument("expiry", "Expiration (MM / YY)", "MM / YY"),
    height: 84,
  },
  cvc: {
    title: "Secure CVC input",
    doc: frameDocument("cvc", "Security code", "CVC"),
    height: 84,
  },
};

export default function CardFields() {
  const frames = useRef<Record<Field, HTMLIFrameElement | null>>({ number: null, expiry: null, cvc: null });
  const [valid, setValid] = useState<Record<Field, boolean>>({ number: false, expiry: false, cvc: false });
  const [last4, setLast4] = useState<string | null>(null);
  const [values, setValues] = useState<{ expiry: string; cvc: string }>({ expiry: "", cvc: "" });
  const [paid, setPaid] = useState(false);

  useEffect(() => {
    /**
     * Takes a field's report only from that field's own frame, so no other
     * window can mark a field valid, and moves focus to the next frame once a
     * field completes.
     */
    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      const message = data as { type?: unknown; field?: unknown; valid?: unknown; last4?: unknown; value?: unknown };
      const field = ORDER.find((entry) => entry === message.field);
      if (field === undefined || event.source !== frames.current[field]?.contentWindow) return;
      if (message.type === "card-field") {
        setValid((current) => ({ ...current, [field]: message.valid === true }));
        if (field === "number") setLast4(typeof message.last4 === "string" ? message.last4 : null);
        else setValues((current) => ({ ...current, [field]: typeof message.value === "string" ? message.value : "" }));
        return;
      }
      if (message.type === "card-field-complete") {
        const next = ORDER[ORDER.indexOf(field) + 1];
        if (next === undefined) return;
        const frame = frames.current[next];
        frame?.focus();
        frame?.contentWindow?.postMessage({ type: "focus" }, "*");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const ready = ORDER.every((field) => valid[field]);

  if (paid) {
    // What was charged, kept off screen for the tests: a wrong expiry or code
    // still authorizes here, as it would against a test card, so the task's
    // values are checked from this attribute.
    return (
      <div data-testid="card-checkout" data-charged={`${last4} ${values.expiry} ${values.cvc}`} style={styles.container}>
        <p data-testid="success-message" style={styles.success}>
          Payment authorized for card ending {last4}
        </p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.summary}>
        <span>Annual plan</span>
        <strong>$96.00</strong>
      </div>
      <div style={styles.fields}>
        {ORDER.map((field) => (
          <iframe
            key={field}
            ref={(node) => {
              frames.current[field] = node;
            }}
            title={FRAMES[field].title}
            sandbox="allow-scripts"
            srcDoc={FRAMES[field].doc}
            style={{ ...styles.frame, height: FRAMES[field].height }}
          />
        ))}
      </div>
      <button
        type="button"
        style={ready ? styles.pay : styles.payDisabled}
        disabled={!ready}
        onClick={() => setPaid(true)}
      >
        Pay $96.00
      </button>
    </div>
  );
}

const styles = {
  container: { display: "flex", flexDirection: "column", gap: 16, padding: "24px 0" },
  summary: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 15,
    padding: "12px 14px",
    border: "1px solid #e5e5e5",
    borderRadius: 10,
  },
  fields: { display: "flex", flexDirection: "column", gap: 4 },
  frame: { width: "100%", border: "none" },
  pay: {
    backgroundColor: "#111",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
  },
  payDisabled: {
    backgroundColor: "#999",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 16,
    fontWeight: 600,
    cursor: "not-allowed",
  },
  success: { margin: 0, color: "#0a7a2f", fontSize: 18, fontWeight: 600, textAlign: "center" },
} satisfies Record<string, CSSProperties>;
