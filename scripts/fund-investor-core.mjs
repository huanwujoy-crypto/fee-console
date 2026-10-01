// Pure gross asset allocation view. The caller must pass the validated receipt
// projection for this exact data snapshot. This is neither a fee nor trade engine.
export function createFundInvestorCore() {
  const SCHEMA = "fee-console.fund-profile.v1", DAY = 86400000;
  const PROFILE_KEYS = ["schema", "manager", "fundName", "inceptionDate", "inceptionNoticeDate", "currency", "initialShares", "investors"];
  const EVENT_KEYS = ["id", "date", "investorId", "grossCents", "feeCents", "netCents", "priceDate", "priceTotalCents", "issuedShares", "sourceRef"];
  const CORRECTION_KEYS = ["id", "subscriptionId", "fromInvestorId", "toInvestorId", "reason", "correctedAt"];
  const TRANSFER_KEYS = ["id", "date", "fromInvestorId", "toInvestorId", "paymentId", "feeAmountCents",
    "compensationCents", "priceDate", "priceTotalCents", "outstandingShares", "transferredShares", "reason"];
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
    const optional = ["subscriptions", "subscriptionCorrections", "shareTransfers"].filter(key => Object.hasOwn(profile || {}, key));
    if (!exact(profile, [...PROFILE_KEYS, ...optional]) || profile.schema !== SCHEMA || profile.currency !== "USD") return invalid("基金资料格式待核对");
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
    const subscriptions = profile.subscriptions || [];
    if (!Array.isArray(subscriptions) || subscriptions.length > 12) return invalid("增资事件资料待核对");
    const eventIds = new Set(), sourceRefs = new Set(), eventsById = new Map(); let previousDate = "";
    for (const event of subscriptions) {
      if (!exact(event, EVENT_KEYS) || !/^[A-Za-z0-9_-]{8,80}$/.test(event.id) || eventIds.has(event.id)
        || !date(event.date) || event.date <= profile.inceptionDate || event.date <= previousDate
        || !ids.has(event.investorId) || !integer(event.grossCents) || event.grossCents <= 0
        || !integer(event.feeCents) || event.feeCents < 0 || event.feeCents >= event.grossCents
        || !integer(event.netCents) || event.netCents !== event.grossCents - event.feeCents
        || !date(event.priceDate) || event.priceDate >= event.date
        || !integer(event.priceTotalCents) || event.priceTotalCents <= 0
        || !integer(event.issuedShares) || event.issuedShares <= 0
        || typeof event.sourceRef !== "string" || !/^[A-Za-z0-9:._-]{8,120}$/.test(event.sourceRef)
        || sourceRefs.has(event.sourceRef)) return invalid("增资事件资料待核对");
      eventIds.add(event.id); sourceRefs.add(event.sourceRef); eventsById.set(event.id, event); previousDate = event.date;
      total += BigInt(event.issuedShares);
      if (total > BigInt(Number.MAX_SAFE_INTEGER)) return invalid("增资后发行份额超出安全范围");
    }
    const corrections = profile.subscriptionCorrections || [];
    if (!Array.isArray(corrections) || corrections.length > subscriptions.length) return invalid("认购归属更正资料待核对");
    const correctionIds = new Set(), correctedEvents = new Set();
    for (const correction of corrections) {
      if (!exact(correction, CORRECTION_KEYS)) return invalid("认购归属更正资料待核对");
      const original = eventsById.get(correction.subscriptionId);
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(correction.id) || correctionIds.has(correction.id)
        || !original || correctedEvents.has(correction.subscriptionId)
        || correction.fromInvestorId !== original.investorId || !ids.has(correction.toInvestorId)
        || correction.toInvestorId === correction.fromInvestorId || !text(correction.reason, 300) || correction.reason.length < 2
        || typeof correction.correctedAt !== "string" || !Number.isFinite(Date.parse(correction.correctedAt))
        || new Date(correction.correctedAt).toISOString() !== correction.correctedAt
        || correction.correctedAt.slice(0, 10) < original.date) return invalid("认购归属更正资料待核对");
      correctionIds.add(correction.id); correctedEvents.add(correction.subscriptionId);
    }
    const ownerOf = event => corrections.find(correction => correction.subscriptionId === event.id)?.toInvestorId || event.investorId;
    const transfers = profile.shareTransfers || [];
    if (!Array.isArray(transfers) || transfers.length > 48) return invalid("份额转让资料待核对");
    const transferIds = new Set(), paymentIds = new Set(), validatedTransfers = []; let previousTransferDate = "";
    const sharesAt = priceDate => {
      const shares = new Map(profile.investors.map(investor => [investor.id, BigInt(investor.shares)]));
      let outstanding = BigInt(profile.initialShares);
      for (const event of subscriptions) if (event.date <= priceDate) {
        const owner = ownerOf(event); shares.set(owner, shares.get(owner) + BigInt(event.issuedShares));
        outstanding += BigInt(event.issuedShares);
      }
      for (const transfer of validatedTransfers) if (transfer.date <= priceDate) {
        const amount = BigInt(transfer.transferredShares);
        shares.set(transfer.fromInvestorId, shares.get(transfer.fromInvestorId) - amount);
        shares.set(transfer.toInvestorId, shares.get(transfer.toInvestorId) + amount);
      }
      return { shares, outstanding };
    };
    for (const transfer of transfers) {
      if (!exact(transfer, TRANSFER_KEYS) || !/^[A-Za-z0-9_-]{8,80}$/.test(transfer.id) || transferIds.has(transfer.id)
        || !date(transfer.date) || transfer.date <= profile.inceptionDate || transfer.date <= previousTransferDate
        || !ids.has(transfer.fromInvestorId) || !ids.has(transfer.toInvestorId) || transfer.fromInvestorId === transfer.toInvestorId
        || typeof transfer.paymentId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(transfer.paymentId) || paymentIds.has(transfer.paymentId)
        || !integer(transfer.feeAmountCents) || transfer.feeAmountCents <= 0
        || !integer(transfer.compensationCents) || transfer.compensationCents <= 0 || transfer.compensationCents >= transfer.feeAmountCents
        || !date(transfer.priceDate) || transfer.priceDate >= transfer.date || previousTransferDate > transfer.priceDate
        || subscriptions.some(event => event.date > transfer.priceDate && event.date <= transfer.date)
        || !integer(transfer.priceTotalCents) || transfer.priceTotalCents <= 0
        || !integer(transfer.outstandingShares) || transfer.outstandingShares <= 0
        || !integer(transfer.transferredShares) || transfer.transferredShares <= 0
        || !text(transfer.reason, 300) || transfer.reason.length < 2) return invalid("份额转让资料待核对");
      const at = sharesAt(transfer.priceDate), senderShares = at.shares.get(transfer.fromInvestorId);
      const expectedCompensation = Number((BigInt(transfer.feeAmountCents) * senderShares * 2n + at.outstanding) /
        (2n * at.outstanding));
      const expectedTransfer = Number((BigInt(transfer.compensationCents) * at.outstanding * 2n + BigInt(transfer.priceTotalCents)) /
        (2n * BigInt(transfer.priceTotalCents)));
      if (at.outstanding !== BigInt(transfer.outstandingShares) || senderShares < BigInt(transfer.transferredShares)
        || transfer.compensationCents !== expectedCompensation || transfer.transferredShares !== expectedTransfer) {
        return invalid("份额转让计算待核对");
      }
      transferIds.add(transfer.id); paymentIds.add(transfer.paymentId); validatedTransfers.push(transfer);
      previousTransferDate = transfer.date;
    }
    return { ok: true, profile: { ...profile, investors: profile.investors.map(investor => ({ ...investor })),
      ...(Object.hasOwn(profile, "subscriptions") ? { subscriptions: subscriptions.map(event => ({ ...event })) } : {}),
      ...(Object.hasOwn(profile, "subscriptionCorrections") ? { subscriptionCorrections: corrections.map(correction => ({ ...correction })) } : {}),
      ...(Object.hasOwn(profile, "shareTransfers") ? { shareTransfers: transfers.map(transfer => ({ ...transfer })) } : {}) }, reason: null };
  }
  const subscriptionOwner = (profile, event) => (profile.subscriptionCorrections || []).find(correction => correction.subscriptionId === event.id)?.toInvestorId || event.investorId;
  function registeredShares(profile) {
    const checked = validateProfile(profile); if (!checked.ok) return null;
    const shares = new Map(checked.profile.investors.map(investor => [investor.id, investor.shares]));
    for (const event of checked.profile.subscriptions || []) shares.set(subscriptionOwner(checked.profile, event),
      shares.get(subscriptionOwner(checked.profile, event)) + event.issuedShares);
    for (const transfer of checked.profile.shareTransfers || []) {
      shares.set(transfer.fromInvestorId, shares.get(transfer.fromInvestorId) - transfer.transferredShares);
      shares.set(transfer.toInvestorId, shares.get(transfer.toInvestorId) + transfer.transferredShares);
    }
    return checked.profile.investors.map(investor => shares.get(investor.id));
  }
  function calculate(input = {}) {
    const { profile, data, feeView, payments } = object(input) ? input : {};
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
    const receiptFlows = [];
    for (const flow of feeView.benchmarkInputs.flows) {
      if (!exact(flow, ["date", "amountCents"]) || !date(flow.date) || !integer(flow.amountCents)
        || flow.date < feeView.start || flow.date > feeView.asOf) return pending("外部资金流证据待核对，暂不提供股份估值");
      if (flow.date > inception) receiptFlows.push(flow);
    }
    // The receipt includes effective flows only. An unconfirmed or unresolved
    // source event can still change ownership; it blocks allocation without
    // being promoted into an economic flow or being netted against another item.
    const candidatesByDate = new Map();
    for (const field of ["flowsAuto", "flowsUnresolved"]) {
      const candidates = data?.[field];
      if (candidates !== undefined && !Array.isArray(candidates)) return pending("外部资金流候选证据待核对，暂不提供股份估值");
      for (const event of candidates || []) {
        if (!object(event) || !date(event.date)) return pending("外部资金流候选证据待核对，暂不提供股份估值");
        if (event.date > inception && event.date <= feeView.asOf) {
          const rows = candidatesByDate.get(event.date) || [];
          rows.push({ field, event }); candidatesByDate.set(event.date, rows);
        }
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
    const initialShares = checked.profile.investors.map(investor => investor.shares);
    const initialCents = daily[0].totalCents;
    const subscriptions = (checked.profile.subscriptions || []).filter(event => event.date <= feeView.asOf);
    const activeTransfers = (checked.profile.shareTransfers || []).filter(event => event.date <= feeView.asOf);
    const accepted = new Map(), acceptedTransfers = new Map(); let outstanding = BigInt(checked.profile.initialShares), flowGateDate = null;
    const gate = eventDate => { if (!flowGateDate || eventDate < flowGateDate) flowGateDate = eventDate; };
    for (const event of subscriptions) {
      const pricePoint = daily.find(point => point.date === event.priceDate);
      const flows = receiptFlows.filter(flow => flow.date === event.date);
      const candidates = candidatesByDate.get(event.date) || [];
      const matchingCandidate = candidates.length === 0 || candidates.length === 1 &&
        candidates[0].field === "flowsAuto" && candidates[0].event.acct === "webull" &&
        Number.isFinite(Number(candidates[0].event.amount)) &&
        Math.round(Number(candidates[0].event.amount) * 100) === event.netCents;
      const expectedShares = pricePoint && pricePoint.totalCents === event.priceTotalCents
        ? Number((BigInt(event.netCents) * outstanding * 2n + BigInt(event.priceTotalCents)) /
          (2n * BigInt(event.priceTotalCents))) : null;
      if (!pricePoint || pricePoint.date >= event.date || pricePoint.totalCents !== event.priceTotalCents
        || flows.length !== 1 || flows[0].amountCents !== event.netCents
        || !matchingCandidate || expectedShares !== event.issuedShares) gate(event.date);
      else accepted.set(event.date, event);
      outstanding += BigInt(event.issuedShares);
    }
    for (const transfer of activeTransfers) {
      const pricePoint = daily.find(point => point.date === transfer.priceDate);
      const matches = Array.isArray(payments) ? payments.filter(payment => object(payment)
        && payment.id === transfer.paymentId && payment.date === transfer.date && String(payment.ccy || "").toUpperCase() === "USD"
        && Math.round(Number(payment.amount) * 100) === transfer.feeAmountCents) : [];
      if (!pricePoint || pricePoint.totalCents !== transfer.priceTotalCents || matches.length !== 1) gate(transfer.date);
      else acceptedTransfers.set(transfer.date, transfer);
    }
    for (const flow of receiptFlows) if (!accepted.has(flow.date)) gate(flow.date);
    for (const [candidateDate] of candidatesByDate) if (!accepted.has(candidateDate)) gate(candidateDate);
    const allocate = (totalCents, shares) => {
      // Round the first allocation half up; assign the remainder to the final
      // investor, so allocations always reconcile to the portfolio's exact cents.
      const denominator = BigInt(shares[0]) + BigInt(shares[1]);
      const numerator = BigInt(totalCents) * BigInt(shares[0]);
      const first = Number((2n * numerator + denominator) / (2n * denominator));
      return [first, totalCents - first];
    };
    const initialValues = allocate(initialCents, initialShares), shares = [...initialShares], contributions = [0, 0];
    result.points = daily.filter(point => !flowGateDate || point.date < flowGateDate).map(point => {
      const event = accepted.get(point.date);
      if (event) {
        const investorIndex = checked.profile.investors.findIndex(investor => investor.id === subscriptionOwner(checked.profile, event));
        shares[investorIndex] += event.issuedShares; contributions[investorIndex] += event.netCents;
      }
      const transfer = acceptedTransfers.get(point.date); let transferBasisCents = 0;
      if (transfer) {
        const fromIndex = checked.profile.investors.findIndex(investor => investor.id === transfer.fromInvestorId);
        const toIndex = checked.profile.investors.findIndex(investor => investor.id === transfer.toInvestorId);
        transferBasisCents = Number((BigInt(transfer.priceTotalCents) * BigInt(transfer.transferredShares) * 2n
          + BigInt(transfer.outstandingShares)) / (2n * BigInt(transfer.outstandingShares)));
        shares[fromIndex] -= transfer.transferredShares; shares[toIndex] += transfer.transferredShares;
        contributions[fromIndex] -= transferBasisCents; contributions[toIndex] += transferBasisCents;
      }
      const values = allocate(point.totalCents, shares), totalShares = shares[0] + shares[1];
      const returnRate = contributions.some(Boolean) ? null : point.totalCents / initialCents - 1;
      return { ...point, unitValue: point.totalCents / 100 / totalShares,
        grossPnlCents: point.totalCents - initialCents - contributions[0] - contributions[1], returnRate,
        subscription: event ? { id: event.id, investorId: subscriptionOwner(checked.profile, event), netCents: event.netCents, issuedShares: event.issuedShares } : null,
        shareTransfer: transfer ? { id: transfer.id, fromInvestorId: transfer.fromInvestorId,
          toInvestorId: transfer.toInvestorId, transferredShares: transfer.transferredShares, basisCents: transferBasisCents } : null,
        investors: checked.profile.investors.map((investor, i) => ({ id: investor.id, shares: shares[i],
          valueCents: values[i], pnlCents: values[i] - initialValues[i] - contributions[i], returnRate })) };
    });
    result.initial = result.points[0]; result.lastProved = result.points.at(-1);
    result.flowGateDate = flowGateDate;
    result.provisional = feeView.status?.provisional === true || result.points.some(point => point.provisional);
    if (flowGateDate) return { ...result, status: "partial", reason: `${flowGateDate} 起有尚未匹配的外部资金流、增资或费用补偿证据；当前份额市值暂不可用` };
    return { ...result, status: "ready", current: result.lastProved };
  }
  return { validateProfile, calculate, subscriptionOwner, registeredShares };
}
