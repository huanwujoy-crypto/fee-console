#!/usr/bin/env node

import fs from "node:fs";

const SHA_RE = /^[0-9a-f]{40}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const requireSha = (label, value) => {
  if (typeof value !== "string" || !SHA_RE.test(value)) {
    throw new Error(`${label} must be a 40-character Git SHA`);
  }
};

const requireDate = (label, value) => {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a real calendar date`);
  }
};

export function validatePublishedMeta(meta, currentHtmlBlob, sourceTruth = null) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error("published metadata must be an object");
  }
  if (meta.schemaVersion !== 1) {
    throw new Error("published metadata schemaVersion must be 1");
  }
  requireSha("sourceSha", meta.sourceSha);
  requireSha("htmlBlob", meta.htmlBlob);
  requireSha("currentHtmlBlob", currentHtmlBlob);
  if (!Number.isInteger(meta.sourceCommitEpoch) || meta.sourceCommitEpoch <= 0) {
    throw new Error("sourceCommitEpoch must be a positive integer");
  }
  requireDate("dataDate", meta.dataDate);
  if (meta.htmlBlob.toLowerCase() !== currentHtmlBlob.toLowerCase()) {
    throw new Error("published metadata does not match latest.html");
  }
  if (sourceTruth !== null) {
    if (!sourceTruth || typeof sourceTruth !== "object" || Array.isArray(sourceTruth)) {
      throw new Error("source truth must be an object");
    }
    requireSha("source truth SHA", sourceTruth.sourceSha);
    requireSha("source truth HTML blob", sourceTruth.sourceHtmlBlob);
    requireDate("source truth data date", sourceTruth.sourceDataDate);
    if (!Number.isInteger(sourceTruth.sourceCommitEpoch) || sourceTruth.sourceCommitEpoch <= 0) {
      throw new Error("source truth commit epoch must be a positive integer");
    }
    if (meta.sourceSha.toLowerCase() !== sourceTruth.sourceSha.toLowerCase()) {
      throw new Error("published metadata source SHA does not match the trusted source commit");
    }
    if (meta.sourceCommitEpoch !== sourceTruth.sourceCommitEpoch) {
      throw new Error("published metadata timestamp does not match the trusted source commit");
    }
    if (meta.htmlBlob.toLowerCase() !== sourceTruth.sourceHtmlBlob.toLowerCase()) {
      throw new Error("published metadata HTML blob does not match the trusted source commit");
    }
    if (meta.dataDate !== sourceTruth.sourceDataDate) {
      throw new Error("published metadata data date does not match the trusted source commit");
    }
  }
  return meta;
}

const validateCandidate = candidate => {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("candidate must be an object");
  }
  if (typeof candidate.ref !== "string" || !candidate.ref.startsWith("origin/claude/")) {
    throw new Error("candidate ref must be an origin/claude branch");
  }
  requireSha("candidate sha", candidate.sha);
  requireSha("candidate htmlBlob", candidate.htmlBlob);
  requireDate("candidate dataDate", candidate.dataDate);
  if (!Number.isInteger(candidate.commitEpoch) || candidate.commitEpoch <= 0) {
    throw new Error("candidate commitEpoch must be a positive integer");
  }
  return candidate;
};

export function selectNewestCandidate(candidates, publishedMeta) {
  if (!Array.isArray(candidates)) throw new Error("candidates must be an array");
  const eligible = candidates.map(validateCandidate).filter(candidate => {
    if (candidate.htmlBlob.toLowerCase() === publishedMeta.htmlBlob.toLowerCase()) return false;
    if (candidate.dataDate < publishedMeta.dataDate) return false;
    if (candidate.dataDate === publishedMeta.dataDate &&
        candidate.commitEpoch <= publishedMeta.sourceCommitEpoch) return false;
    return true;
  }).sort((left, right) => {
    if (right.dataDate !== left.dataDate) return right.dataDate.localeCompare(left.dataDate);
    if (right.commitEpoch !== left.commitEpoch) return right.commitEpoch - left.commitEpoch;
    if (left.htmlBlob !== right.htmlBlob) return left.htmlBlob.localeCompare(right.htmlBlob);
    return left.ref.localeCompare(right.ref);
  });

  if (eligible.length === 0) return null;
  const newest = eligible[0];
  const sameMoment = eligible.filter(candidate =>
    candidate.dataDate === newest.dataDate && candidate.commitEpoch === newest.commitEpoch);
  if (new Set(sameMoment.map(candidate => candidate.htmlBlob.toLowerCase())).size > 1) {
    throw new Error("multiple different candidates share the newest source timestamp");
  }
  return sameMoment.sort((left, right) => left.ref.localeCompare(right.ref))[0];
}

export function createPublishedMeta(candidate) {
  validateCandidate(candidate);
  return {
    schemaVersion: 1,
    sourceSha: candidate.sha,
    sourceCommitEpoch: candidate.commitEpoch,
    dataDate: candidate.dataDate,
    htmlBlob: candidate.htmlBlob
  };
}

const readJson = path => JSON.parse(fs.readFileSync(path, "utf8"));

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "validate-meta" && (args.length === 2 || args.length === 6)) {
      const sourceTruth = args.length === 6 ? {
        sourceSha: args[2],
        sourceCommitEpoch: Number(args[3]),
        sourceHtmlBlob: args[4],
        sourceDataDate: args[5]
      } : null;
      validatePublishedMeta(readJson(args[0]), args[1], sourceTruth);
      console.log("published metadata is valid");
    } else if (command === "select" && args.length === 3) {
      const published = validatePublishedMeta(readJson(args[1]), args[2]);
      console.log(JSON.stringify(selectNewestCandidate(readJson(args[0]), published)));
    } else if (command === "create-meta" && args.length === 1) {
      console.log(`${JSON.stringify(createPublishedMeta(readJson(args[0])), null, 2)}\n`);
    } else {
      console.error("usage: xuan-ib-promotion.mjs validate-meta META CURRENT_BLOB [SOURCE_SHA SOURCE_EPOCH SOURCE_BLOB SOURCE_DATE] | select CANDIDATES META CURRENT_BLOB | create-meta CANDIDATE");
      process.exit(2);
    }
  } catch (error) {
    console.error(`XUAN-IB promotion failed: ${error.message}`);
    process.exit(1);
  }
}
