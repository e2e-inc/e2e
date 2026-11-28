/** Date and clock-time patterns. */

/** A month by name or abbreviation, with or without a trailing period. */
const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;

/** A day of the month (1-31), with an optional English ordinal suffix (st, nd, rd, th). */
const DAY = String.raw`\d{1,2}(?:st|nd|rd|th)?`;

/** An ISO 8601 calendar date (`YYYY-MM-DD`). */
export const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;

/** A clock time (`HH:MM` or `HH:MM:SS`), also with am or pm written against it (`5:42pm`); the match is the digits alone. */
export const CLOCK_TIME = /\b\d{1,2}:\d{2}(?::\d{2})?(?=\b|[ap]\.?m\b)/i;

/** A month followed by day with optional year (e.g. `October 26th`, `Sep 8, 2026`). */
export const MONTH_DAY_DATE = new RegExp(String.raw`\b${MONTH}\s+${DAY}(?:,?\s+\d{4})?\b`, 'i');

/** A day followed by month with optional year (e.g. `3rd October`, `26th Oct 2026`). */
export const DAY_MONTH_DATE = new RegExp(String.raw`\b${DAY}\s+${MONTH}(?:,?\s+\d{4})?\b`, 'i');

/**
 * A numeric date with a four-digit year, year first (`2026/11/15`, Korean
 * `2026. 11. 15.`) or year last (`15.11.2026`, `11/15/2026`, Dutch `15-11-2026`).
 */
export const NUMERIC_DATE = /\b\d{4}(\/|\.\s?)\d{1,2}\1\d{1,2}(?!\d)|(?<![\w./-])\d{1,2}([/.-])\d{1,2}\2\d{4}\b/;

/**
 * A Chinese, Japanese or Korean month and day, with or without the year
 * before it (`11月15日`, `2026年11月15日`, `2026년 11월 15일`). The year is part
 * of the match, so a date in the next year reads the same. It anchors on the
 * digits, since `\b` does not fire next to these characters.
 */
export const CJK_DATE = /(?<!\d)(?:\d{4}\s*[年년]\s*)?\d{1,2}\s*[月월]\s*\d{1,2}\s*[日일]/;

/** A Chinese, Japanese or Korean clock time (`12時30分`, `12时30分`, `12시 30분`). */
export const CJK_TIME = /(?<!\d)\d{1,2}\s*[時时시]\s*\d{1,2}\s*[分분]/;
