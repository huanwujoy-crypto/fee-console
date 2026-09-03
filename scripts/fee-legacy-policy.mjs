// Pure shared policy. Keep the entire factory self-contained: the mobile page
// embeds this exact function, and tests compare the embedded source bytewise.
// No network, storage, key access, fee calculation, or source mutation.
export function createLegacyPolicy() {
  const LEGACY_POLICY_ID = "fee-console.legacy-empty-expense.v1";
  const STRICT_POLICY_ID = "strict-safe-subset-copy-only";
  const MAX_BYTES = 5 * 1024 * 1024;
  const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const ACCOUNTS = ["schwab", "webull"];
  const LEGACY_FX = ["USD", "HKD", "CNY", "EUR", "SGD", "GBP", "JPY"];
  const own = (o, key) => Object.hasOwn(o, key);
  const object = o => o !== null && typeof o === "object" && !Array.isArray(o);
  const reject = code => { const error = new Error(code); error.name = "LegacyPolicyError"; error.code = code; throw error; };
  const requireThat = (condition, code) => { if (!condition) reject(code); };
  const keys = (o, required, optional, code) => {
    requireThat(object(o), code);
    requireThat(required.every(key => own(o, key))
      && Object.keys(o).every(key => required.includes(key) || optional.includes(key)), code);
  };
  const numeric = (value, code) => {
    requireThat(typeof value === "number" || (typeof value === "string"
      && value.trim() !== "" && NUMBER.test(value.trim())), code);
    const n = Number(value);
    requireThat(Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER / 100, code);
    return n;
  };
  const isCalendarDate = value => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return false;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  };
  const id = (value, code) => requireThat(typeof value === "string" && value.length > 0
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value), code);
  const date = (value, code) => requireThat(typeof value === "string" && isCalendarDate(value), code);
  const unique = (values, code) => requireThat(new Set(values).size === values.length, code);
  const clone = value => structuredClone(value);

  // JSON.parse silently accepts duplicate keys. Check the already-valid JSON
  // grammar for duplicate decoded keys, including escaped key spellings.
  const parseExactJson = bytes => {
    requireThat(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= MAX_BYTES, "INPUT_BYTES_INVALID");
    let text, parsed;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); parsed = JSON.parse(text); }
    catch { reject("INPUT_JSON_INVALID"); }
    let pos = 0;
    const ws = () => { while (/\s/.test(text[pos] || "") && pos < text.length) pos++; };
    const string = () => {
      const start = pos++;
      while (pos < text.length) {
        if (text[pos] === "\\") { pos += 2; continue; }
        if (text[pos++] === '"') return JSON.parse(text.slice(start, pos));
      }
      reject("INPUT_JSON_INVALID");
    };
    const value = depth => {
      requireThat(depth < 64, "INPUT_JSON_DEPTH"); ws();
      if (text[pos] === '"') { string(); return; }
      if (text[pos] === "{") {
        pos++; ws(); const seen = new Set();
        if (text[pos] === "}") { pos++; return; }
        for (;;) {
          ws(); const key = string();
          requireThat(!seen.has(key), "INPUT_DUPLICATE_JSON_KEY"); seen.add(key);
          ws(); pos++; value(depth + 1); ws();
          if (text[pos++] === "}") return;
        }
      }
      if (text[pos] === "[") {
        pos++; ws(); if (text[pos] === "]") { pos++; return; }
        for (;;) { value(depth + 1); ws(); if (text[pos++] === "]") return; }
      }
      while (pos < text.length && !/[\s,\]}]/.test(text[pos])) pos++;
    };
    value(0);
    return parsed;
  };

  const projectV3 = (raw, policyId = STRICT_POLICY_ID) => {
    requireThat(policyId === STRICT_POLICY_ID || policyId === LEGACY_POLICY_ID, "LEGACY_POLICY_UNSUPPORTED");
    keys(raw, ["v", "updatedAt", "settings", "accounts", "months", "fees"], [], "LEDGER_FIELDS_UNSUPPORTED");
    requireThat(raw.v === 3, "LEDGER_VERSION_UNSUPPORTED");
    requireThat(typeof raw.updatedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw.updatedAt)
      && isCalendarDate(raw.updatedAt.slice(0, 10)) && Number.isFinite(Date.parse(raw.updatedAt)), "LEDGER_UPDATED_AT_INVALID");
    const s = raw.settings;
    keys(s, ["start", "mgmt", "carry", "who", "openingAt", "fx"], [], "SETTINGS_FIELDS_UNSUPPORTED");
    date(s.start, "START_INVALID"); date(s.openingAt, "OPENING_DATE_INVALID");
    requireThat(Date.parse(s.start + "T00:00:00Z") - Date.parse(s.openingAt + "T00:00:00Z") === 86400000,
      "OPENING_DATE_REQUIRES_REVIEW");
    requireThat(typeof s.who === "string", "OWNER_LABEL_INVALID");
    for (const [field, code] of [["mgmt", "MANAGEMENT_RATE_INVALID"], ["carry", "CARRY_RATE_INVALID"]]) {
      const value = numeric(s[field], code), ppm = Math.round(value * 10000);
      requireThat(value >= 0 && ppm <= 1000000 && Math.abs(value * 10000 - ppm) <= 1e-8, "CURRENT_ECONOMIC_SCHEMA_REJECTED");
    }
    requireThat(object(s.fx) && LEGACY_FX.every(ccy => own(s.fx, ccy)), "FX_MAP_INCOMPLETE");
    for (const [ccy, fx] of Object.entries(s.fx)) {
      requireThat(/^[A-Z]{3}$/.test(ccy) && numeric(fx, "FX_RATE_INVALID") > 0, "FX_RATE_INVALID");
    }
    requireThat(Number(s.fx.USD) === 1, "USD_FX_REQUIRES_REVIEW");
    requireThat(Array.isArray(raw.accounts) && raw.accounts.length === 2, "ACCOUNT_SET_INVALID");
    for (const a of raw.accounts) {
      keys(a, ["id", "name", "opening"], [], "ACCOUNT_FIELDS_UNSUPPORTED");
      requireThat(ACCOUNTS.includes(a.id), "ACCOUNT_SET_INVALID");
      requireThat(typeof a.name === "string" && a.name.trim() !== "", "ACCOUNT_NAME_INVALID");
      requireThat(numeric(a.opening, "OPENING_AMOUNT_INVALID") >= 0, "OPENING_AMOUNT_INVALID");
    }
    unique(raw.accounts.map(a => a.id), "ACCOUNT_SET_INVALID");
    requireThat(raw.accounts.reduce((sum, a) => sum + Number(a.opening), 0) > 0, "BLANK_LEDGER_REJECTED");

    requireThat(Array.isArray(raw.months), "MONTHS_MISSING");
    const flows = [];
    for (const m of raw.months) {
      keys(m, ["ym", "locked", "lockedAt", "snap", "flows", "manualClose"], [], "MONTH_FIELDS_UNSUPPORTED");
      requireThat(typeof m.ym === "string" && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(m.ym)
        && m.ym >= s.start.slice(0, 7), "MONTH_INVALID");
      requireThat(m.locked === false && m.lockedAt === null && m.snap === null, "LEGACY_LOCK_REQUIRES_REVIEW");
      requireThat(object(m.manualClose) && Object.keys(m.manualClose).length === 0, "LEGACY_MANUAL_CLOSE_REQUIRES_REVIEW");
      requireThat(Array.isArray(m.flows), "FLOWS_MISSING");
      for (const f of m.flows) {
        keys(f, ["id", "date", "acct", "amount", "note"], ["src"], "FLOW_FIELDS_UNSUPPORTED");
        id(f.id, "FLOW_ID_INVALID"); date(f.date, "FLOW_DATE_INVALID");
        requireThat(f.date.slice(0, 7) === m.ym && f.date >= s.start, "FLOW_DATE_REQUIRES_REVIEW");
        requireThat(ACCOUNTS.includes(f.acct), "FLOW_ACCOUNT_INVALID");
        requireThat(numeric(f.amount, "FLOW_AMOUNT_INVALID") !== 0, "FLOW_AMOUNT_INVALID");
        requireThat(typeof f.note === "string", "FLOW_NOTE_INVALID");
        if (own(f, "src")) {
          requireThat(typeof f.src === "string", "FLOW_SOURCE_INVALID");
          if (f.src !== "") id(f.src, "FLOW_SOURCE_INVALID");
        }
        flows.push(f);
      }
    }
    unique(raw.months.map(m => m.ym), "DUPLICATE_MONTH");
    requireThat(raw.months.every((m, index) => index === 0 || raw.months[index - 1].ym < m.ym), "MONTH_ORDER_REQUIRES_REVIEW");
    unique(flows.map(f => f.id), "DUPLICATE_FLOW_ID");
    unique(flows.filter(f => f.src).map(f => f.src), "DUPLICATE_FLOW_SOURCE");

    requireThat(Array.isArray(raw.fees), "FEES_MISSING");
    const payments = [], legacyRecords = [];
    for (const f of raw.fees) {
      if (policyId === LEGACY_POLICY_ID && f?.type === "exp") {
        // Exactly the independently reviewed historical empty-row shape. Blank
        // is not coerced to zero, paid, or a completed expense. No cat allowed.
        keys(f, ["id", "type", "date", "amount", "ccy", "fx", "note", "deduct"], [], "LEGACY_EXPENSE_FIELDS_UNSUPPORTED");
        id(f.id, "LEGACY_EXPENSE_ID_INVALID"); date(f.date, "LEGACY_EXPENSE_DATE_INVALID");
        requireThat(f.date >= s.start && f.date <= raw.updatedAt.slice(0, 10), "LEGACY_EXPENSE_DATE_REQUIRES_REVIEW");
        requireThat(f.amount === "" && f.fx === "" && f.note === "" && typeof f.deduct === "boolean", "LEGACY_EXPENSE_SHAPE_REQUIRES_REVIEW");
        requireThat(typeof f.ccy === "string" && /^[A-Z]{3}$/.test(f.ccy) && own(s.fx, f.ccy), "LEGACY_EXPENSE_CURRENCY_INVALID");
        legacyRecords.push(clone(f));
      } else {
        keys(f, ["id", "type", "date", "amount", "ccy", "fx", "note"], ["cat"], "FEE_FIELDS_UNSUPPORTED");
        requireThat(f.type === "pay", "LEGACY_EXPENSE_OR_TYPE_REQUIRES_REVIEW");
        id(f.id, "PAYMENT_ID_INVALID"); date(f.date, "PAYMENT_DATE_INVALID");
        requireThat(f.date >= s.start, "PAYMENT_DATE_REQUIRES_REVIEW");
        requireThat(numeric(f.amount, "PAYMENT_AMOUNT_INVALID") > 0, "PAYMENT_AMOUNT_INVALID");
        requireThat(typeof f.ccy === "string" && /^[A-Z]{3}$/.test(f.ccy) && own(s.fx, f.ccy), "PAYMENT_CURRENCY_INVALID");
        requireThat(f.fx === "" || numeric(f.fx, "PAYMENT_FX_INVALID") > 0, "PAYMENT_FX_INVALID");
        requireThat(typeof f.note === "string" && (!own(f, "cat") || typeof f.cat === "string"), "PAYMENT_TEXT_INVALID");
        const { type, cat, ...payment } = f;
        payments.push(clone(payment));
      }
    }
    unique(raw.fees.map(f => f.id), "DUPLICATE_PAYMENT_ID");
    const paymentIds = payments.map(f => f.id);
    requireThat(paymentIds.length + legacyRecords.length === raw.fees.length
      && new Set([...paymentIds, ...legacyRecords.map(f => f.id)]).size === raw.fees.length, "FEE_PARTITION_INVALID");
    return { economic: {
      v: 4, updatedAt: raw.updatedAt, settings: clone(raw.settings), accounts: clone(raw.accounts),
      months: raw.months.map(m => ({ ym: m.ym, flows: clone(m.flows) })), fees: payments
    }, paymentIds, legacyRecords };
  };
  return { LEGACY_POLICY_ID, STRICT_POLICY_ID, parseExactJson, projectV3 };
}
