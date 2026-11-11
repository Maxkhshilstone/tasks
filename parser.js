/*
 * Rule-based task parser. No AI, no network: pure deterministic string rules.
 *
 *   parse("Reminder, follow up with cleaners next Monday")
 *     -> { text: "Follow up with cleaners", date: "2026-11-16", time: null, ... }
 *
 * Rules (documented so you can predict what it does):
 *  - Leading "reminder" / "remind me (to)" is stripped.
 *  - No date phrase            -> today (caller may override with a default).
 *  - today / tonight / eod     -> today (day-only, no time)
 *  - tomorrow, day after tomorrow, in N days/weeks/months
 *  - monday            -> next upcoming Monday (never today)
 *  - this monday       -> upcoming Monday, today counts
 *  - next monday       -> that weekday in NEXT Mon-Sun week
 *  - next week         -> Monday of next week
 *  - next month        -> 1st of next month
 *  - weekend           -> upcoming Saturday
 *  - nov 20 / november 20th 2026 / 20th of november / 11/20 / the 15th
 *  - Times only when stated: "at 1:30", "1:30pm", "at 9am", "noon".
 *    A bare "at 3" with no am/pm: 1-6 -> PM, 7-11 -> AM, 12 -> noon.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TodoParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const WD_ABBR = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
  const MONTHS = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7,
    september: 8, october: 9, november: 10, december: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sept: 8, sep: 8, oct: 9, nov: 10, dec: 11
  };
  const MONTH_NAMES = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';
  const NUMWORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const PRE = '(?:(?:on|by|for|due|before|until)\\s+)?';

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const fromYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
  const rx = (src) => new RegExp('\\b' + src + '\\b', 'i');

  function validDate(y, m, d) {
    const x = new Date(y, m, d);
    return x.getFullYear() === y && x.getMonth() === m && x.getDate() === d ? x : null;
  }

  function toTime(h, min, mer) {
    h = +h;
    min = (min === undefined || min === '') ? 0 : +min;
    if (min > 59) return null;
    if (mer) {
      const c = mer[0].toLowerCase();
      if (h < 1 || h > 12) return null;
      if (c === 'p' && h < 12) h += 12;
      if (c === 'a' && h === 12) h = 0;
    } else {
      if (h > 23) return null;
      if (h >= 1 && h <= 6) h += 12;
    }
    return pad(h) + ':' + pad(min);
  }

  function parse(input, now) {
    now = now || new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const original = String(input || '').replace(/\s+/g, ' ').trim();
    let s = ' ' + original + ' ';

    // Strip the spoken trigger word.
    s = s.replace(/^\s*(?:reminder(?:\s+to)?|remind me(?:\s+to)?)\s*[,:\-–]*\s*/i, ' ');

    function extract(re, handler) {
      const m = re.exec(s);
      if (!m) return null;
      const val = handler(m);
      if (val === null || val === undefined) return null;
      s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
      return val;
    }

    function weekdayDate(mod, wd) {
      mod = mod && mod.toLowerCase();
      if (mod === 'next') return addDays(addDays(mondayOf(today), 7), (wd + 6) % 7);
      const diff = (wd - today.getDay() + 7) % 7;
      if (mod === 'this') return addDays(today, diff);
      return addDays(today, diff || 7);
    }

    const nextOccurrenceOfDay = (day) => {
      for (let i = 0; i < 14; i++) {
        const d = validDate(today.getFullYear(), today.getMonth() + i, day);
        if (d && d >= today) return d;
      }
      return null;
    };

    const dateRules = [
      [rx(PRE + '(?:end of (?:the )?day|eod|tonight|this evening|this afternoon|this morning|later today|today)'), () => today],
      [rx(PRE + 'day after tomorrow'), () => addDays(today, 2)],
      [rx(PRE + '(?:tomorrow|tmrw|tmr)'), () => addDays(today, 1)],
      [rx('in\\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\\d+)\\s+(day|week|month)s?'), (m) => {
        const n = NUMWORDS[m[1].toLowerCase()] || parseInt(m[1], 10);
        const u = m[2].toLowerCase();
        if (u === 'day') return addDays(today, n);
        if (u === 'week') return addDays(today, 7 * n);
        const first = new Date(today.getFullYear(), today.getMonth() + n, 1);
        const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
        return new Date(first.getFullYear(), first.getMonth(), Math.min(today.getDate(), last));
      }],
      [rx(PRE + 'next\\s+week'), () => addDays(mondayOf(today), 7)],
      [rx(PRE + 'next\\s+month'), () => new Date(today.getFullYear(), today.getMonth() + 1, 1)],
      [rx(PRE + '(?:this\\s+)?weekend'), () => addDays(today, (6 - today.getDay() + 7) % 7)],
      [rx(PRE + '(?:(next|this)\\s+)?(' + WEEKDAYS.join('|') + ')'),
        (m) => weekdayDate(m[1], WEEKDAYS.indexOf(m[2].toLowerCase()))],
      [rx('(?:on\\s+|(next|this)\\s+)(tues|tue|wed|thurs|thur|thu|fri|sat|sun|mon)'),
        (m) => weekdayDate(m[1], WD_ABBR[m[2].toLowerCase()])],
      [rx(PRE + '(?:the\\s+)?(' + MONTH_NAMES + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?'), (m) => {
        const mon = MONTHS[m[1].toLowerCase()], day = +m[2];
        const y = m[3] ? +m[3] : today.getFullYear();
        let d = validDate(y, mon, day);
        if (d && !m[3] && d < today) d = validDate(y + 1, mon, day);
        return d;
      }],
      [rx(PRE + '(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(' + MONTH_NAMES + ')(?:,?\\s+(\\d{4}))?'), (m) => {
        const mon = MONTHS[m[2].toLowerCase()], day = +m[1];
        const y = m[3] ? +m[3] : today.getFullYear();
        let d = validDate(y, mon, day);
        if (d && !m[3] && d < today) d = validDate(y + 1, mon, day);
        return d;
      }],
      [/(?:^|\s)(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=[\s.,!?]|$)/, (m) => {
        const mon = +m[1] - 1, day = +m[2];
        let y = m[3] ? +m[3] : today.getFullYear();
        if (m[3] && m[3].length === 2) y += 2000;
        let d = validDate(y, mon, day);
        if (d && !m[3] && d < today) d = validDate(y + 1, mon, day);
        return d;
      }],
      [rx(PRE + 'the\\s+(\\d{1,2})(?:st|nd|rd|th)'), (m) => nextOccurrenceOfDay(+m[1])]
    ];

    let date = null;
    for (const [re, h] of dateRules) {
      date = extract(re, h);
      if (date) break;
    }

    const timeRules = [
      [/\b(?:at\s+)?(?:noon|midday)\b/i, () => '12:00'],
      [/\bat\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d:a-z])/i, (m) => toTime(m[1], m[2], m[3])],
      [/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?(?![\d:a-z])/i, (m) => toTime(m[1], m[2], m[3])],
      [/\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i, (m) => toTime(m[1], '', m[2])]
    ];

    let time = null;
    for (const [re, h] of timeRules) {
      time = extract(re, h);
      if (time) break;
    }

    let text = s.replace(/\s+/g, ' ').trim();
    if (date || time) {
      for (let i = 0; i < 4; i++) {
        const t = text.replace(/\s+(?:on|by|for|at|due|before|until|this|next|the|a|an)$/i, '');
        if (t === text) break;
        text = t;
      }
    }
    text = text.replace(/^[\s,;:\-–]+/, '').replace(/[\s,;:\-–.!]+$/, '');
    if (!text) text = original.replace(/^[\s,;:\-–]+/, '');
    text = text.charAt(0).toUpperCase() + text.slice(1);

    return {
      text,
      date: ymd(date || today),
      time,
      dateFound: !!date,
      timeFound: !!time
    };
  }

  return { parse, ymd, fromYmd, addDays, mondayOf };
});
