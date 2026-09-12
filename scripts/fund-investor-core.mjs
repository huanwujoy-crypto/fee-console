// Pure gross asset allocation view. The caller must pass the validated receipt
// projection for this exact data snapshot. This is neither a fee nor trade engine.
export function createFundInvestorCore() {
  const SCHEMA = "fee-console.fund-profile.v1", DAY = 86400000;
  const PROFILE_KEYS = ["schema", "manager", "fundName", "inceptionDate", "inceptionNoticeDate", "currency", "initialShares", "investors"];
  const object = value => !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
  const date = value => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(value + "T00:00:00Z");
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  const integer = value => Number.isSafeInteger(value);
  const number = value => {
    if (typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) value = Number(value);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("daily amount");
    return value;
  };
  function validateProfile(profile) {
    const invalid = reason => ({ ok: false, profile: null, reason });
    if (!exact(profile, PROFILE_KEYS) || profile.schema !== SCHEMA || profile.currency !== "USD") return invalid("基金资料格式待核对");
    if (!text(profile.manager, 120) || !text(profile.fundName, 120)) return invalid("管理人与基金名称待核对");
    if (!date(profile.inceptionDate) || !date(profile.inceptionNoticeDate) || profile.inceptionNoticeDate < profile.inceptionDate) return invalid("成立日与通知日期待核对");
    if (!integer(profile.initialShares) || profile.initialShares <= 0 || !Array.isArray(profile.investors) || profile.investors.length !== 2) return invalid("初始股份资料待核对");
    const ids = new Set(); let total = 0n;
    for (const investor of profile.investors) {
      if (!exact(investor, ["id", "name", "shares"]) || !text(investor.name, 80) || typeof investor.id !== "string"
        || !/^[A-Za-z][A-Za-z0-9_-]{0,15}$/.test(investor.id) || ids.has(investor.id) || !integer(investor.shares) || investor.shares <= 0) return invalid("投资人股份资料待核对");
      ids.add(investor.id); total += BigInt(investor.shares);
    }
    if (total !== BigInt(profile.initialShares)) return invalid("投资人股份合计与发行股份不符");
    return { ok: true, profile: { ...profile, investors: profile.investors.map(investor => ({ ...investor })) }, reason: null };
  }
  function calculate(input = {}) {
    const { profile, data, feeView } = object(input) ? input : {};
    const checked = validateProfile(profile);
    const result = { status: "pending", reason: null, profile: checked.profile, asOf: null,
      inceptionDate: checked.profile?.inceptionDate || null, initial: null, current: null, lastProved: null,
      points: [], flowGateDate: null, provisional: false };
    const pending = reason => ({ ...result, reason });
    if (!checked.ok) return pending(checked.reason);
    if (!object(feeView) || feeView.state !== "verified") return pending("计算回执待验证，暂不提供股份估值");
    if (!date(feeView.start) || !date(feeView.asOf) || feeView.start > feeView.asOf) return pending("计算回执日期待核对");
    result.asOf = feeView.asOf;
    const inception = checked.profile.inceptionDate;
    if (inception < feeView.start || inception > feeView.asOf) return pending("基金成立日未被计算回执覆盖");
    if (!object(feeView.benchmarkInputs) || !Array.isArray(feeView.benchmarkInputs.flows)) return pending("外部资金流证据待核对，暂不提供股份估值");
    let flowGateDate = null;
    for (const flow of feeView.benchmarkInputs.flows) {
      if (!exact(flow, ["date", "amountCents"]) || !date(flow.date) || !integer(flow.amountCents)
        || flow.date < feeView.start || flow.date > feeView.asOf) return pending("外部资金流证据待核对，暂不提供股份估值");
      if (flow.date > inception && (!flowGateDate || flow.date < flowGateDate)) flowGateDate = flow.date;
    }
    // The receipt includes effective flows only. An unconfirmed or unresolved
    // source event can still change ownership; it blocks allocation without
    // being promoted into an economic flow or being netted against another item.
    for (const field of ["flowsAuto", "flowsUnresolved"]) {
      const candidates = data?.[field];
      if (candidates !== undefined && !Array.isArray(candidates)) return pending("外部资金流候选证据待核对，暂不提供股份估值");
      for (const event of candidates || []) {
        if (!object(event) || !date(event.date)) return pending("外部资金流候选证据待核对，暂不提供股份估值");
        if (event.date > inception && event.date <= feeView.asOf && (!flowGateDate || event.date < flowGateDate)) flowGateDate = event.date;
      }
    }
    let daily;
    try {
      if (!object(data) || !Array.isArray(data.daily) || !data.daily.length) throw new Error("daily missing");
      let previous = "";
      daily = data.daily.map(raw => {
        if (!object(raw) || !date(raw.d) || raw.d <= previous) throw new Error("daily order");
        previous = raw.d;
        // Earlier rows may contain benchmark prices only; they do not value this fund.
        if (raw.d < inception) return { date: raw.d };
        if (!Object.hasOwn(raw, "schwab") || !Object.hasOwn(raw, "webull")) throw new Error("daily account");
        // Account values already include cash. Match the receipt's total-before-rounding convention.
        const totalCents = Math.round((number(raw.schwab) + number(raw.webull)) * 100);
        if (!integer(totalCents) || totalCents < 0) throw new Error("daily total");
        return { date: raw.d, totalCents, provisional: !!raw.prov };
      });
      if (daily.at(-1).date !== feeView.asOf) throw new Error("receipt stale");
      daily = daily.filter(point => point.date >= inception);
      if (!daily.length || daily[0].date !== inception || daily[0].totalCents <= 0) throw new Error("inception missing");
      for (let i = 1; i < daily.length; i++) if (Date.parse(daily[i].date) - Date.parse(daily[i - 1].date) !== DAY) throw new Error("daily gap");
    } catch (_) { return pending("成立日至回执日期的每日总资产不完整或无效，暂不提供股份估值"); }
    const shares = checked.profile.initialShares, denominator = BigInt(shares), initialCents = daily[0].totalCents;
    const allocate = totalCents => {
      // Round the first allocation half up; assign the remainder to the final
      // investor, so allocations always reconcile to the portfolio's exact cents.
      const numerator = BigInt(totalCents) * BigInt(checked.profile.investors[0].shares);
      const first = Number((2n * numerator + denominator) / (2n * denominator));
      return [first, totalCents - first];
    };
    const initialValues = allocate(initialCents);
    result.points = daily.filter(point => !flowGateDate || point.date < flowGateDate).map(point => {
      const values = allocate(point.totalCents), returnRate = point.totalCents / initialCents - 1;
      return { ...point, unitValue: point.totalCents / 100 / shares, grossPnlCents: point.totalCents - initialCents, returnRate,
        investors: checked.profile.investors.map((investor, i) => ({ id: investor.id, shares: investor.shares,
          valueCents: values[i], pnlCents: values[i] - initialValues[i], returnRate })) };
    });
    result.initial = result.points[0]; result.lastProved = result.points.at(-1);
    result.flowGateDate = flowGateDate;
    result.provisional = feeView.status?.provisional === true || result.points.some(point => point.provisional);
    if (flowGateDate) return { ...result, status: "partial", reason: `${flowGateDate} 起存在外部资金流或待核对事件；待确认认购或赎回的股份分配，当前股份市值暂不可用` };
    return { ...result, status: "ready", current: result.lastProved };
  }
  return { validateProfile, calculate };
}
