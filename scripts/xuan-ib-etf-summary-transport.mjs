// Transport only the already approved public allowlist, never producer inputs.
import {validateOpenEtfTrend} from './xuan-ib-etf-trend.mjs';
export const ETF_SUMMARY_ID = 'xuan-etf-open-summary-v3';
export const ETF_SUMMARY_OPEN = `<template id="${ETF_SUMMARY_ID}" type="application/json">`;
export const MAX_ETF_SUMMARY_BYTES = 512000;

export function parseEtfSummary(text, options = {}) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length >= MAX_ETF_SUMMARY_BYTES
      || /[<>&]/.test(text)) throw new Error('Invalid ETF summary transport');
  const data = JSON.parse(text);
  if (JSON.stringify(data) !== text) throw new Error('Noncanonical or duplicate ETF summary');
  return validateOpenEtfTrend(data, options);
}

export function renderEtfSummaryTemplate(data, options = {}) {
  const text = JSON.stringify(validateOpenEtfTrend(data, options));
  parseEtfSummary(text, options);
  return `${ETF_SUMMARY_OPEN}${text}</template>`;
}
