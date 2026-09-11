const numberWords = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
});

const dispositionAliases = Object.freeze([
  ["PERMANENT_PATHOLOGY", ["permanent pathology", "permanent"]],
  ["FROZEN_SECTION", ["frozen section", "frozen"]],
  ["CULTURE", ["culture"]],
  ["FRESH", ["fresh"]],
]);

const knownAnatomyPhrases = [
  "thyroid lobe", "lobe of thyroid", "parathyroid gland", "breast tissue",
  "breast specimen", "lymph node", "skin", "gallbladder", "appendix",
  "colon", "ovary", "uterus", "prostate",
];

const criticalFields = ["anatomicalStructure", "laterality", "disposition", "containerCount"];
const fieldLabels = {
  anatomicalStructure: "anatomical structure",
  laterality: "laterality",
  disposition: "disposition",
  containerCount: "container count",
};

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phrasePattern(phrase) {
  return normalizeText(phrase).split(" ").map(escapePattern).join("\\s+");
}

function phrasePresent(text, phrase) {
  return new RegExp(`\\b${phrasePattern(phrase)}\\b`).test(text);
}

export function normalizeText(input) {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\bdon't\b/g, "do not")
    .replace(/\bisn't\b/g, "is not")
    .replace(/\bcan't\b/g, "cannot")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values) {
  return [...new Set(values)];
}

function parseLaterality(text) {
  const mentions = [
    ["LEFT", /\bleft\b/], ["RIGHT", /\bright\b/], ["MIDLINE", /\bmidline\b/],
  ].filter(([, pattern]) => pattern.test(text)).map(([value]) => value);
  return {
    mentions,
    value: mentions.length === 1 ? mentions[0] : undefined,
    conflicts: mentions.length > 1
      ? [`Conflicting laterality: ${mentions.map(display).join(" and ")}.`]
      : [],
  };
}

function parseDisposition(text) {
  const mentions = dispositionAliases
    .filter(([, aliases]) => aliases.some((alias) => phrasePresent(text, alias)))
    .map(([value]) => value);
  return {
    mentions,
    value: mentions.length === 1 ? mentions[0] : undefined,
    conflicts: mentions.length > 1
      ? [`Conflicting dispositions: ${mentions.map(display).join(" and ")}.`]
      : [],
  };
}

function parseContainerCount(text) {
  const mentions = [];
  const unsupported = [];
  const countPattern = new RegExp(
    `\\b(\\d+|${Object.keys(numberWords).join("|")})\\s+(?:containers?|jars?)\\b`,
    "g",
  );
  for (const match of text.matchAll(countPattern)) {
    const value = numberWords[match[1]] ?? Number(match[1]);
    if (Number.isInteger(value) && value >= 1 && value <= 10) mentions.push(value);
    else unsupported.push(match[0]);
  }
  return {
    mentions,
    value: mentions.length === 1 ? mentions[0] : undefined,
    conflicts: mentions.length > 1
      ? [`Multiple container-count statements were detected: ${mentions.join(" and ")}.`]
      : [],
    unsupported,
  };
}

function parseAnatomy(order, text) {
  const approved = order.approvedAliases.filter((alias) => phrasePresent(text, alias));
  const foundKnown = knownAnatomyPhrases.filter((phrase) => phrasePresent(text, phrase));
  const additional = foundKnown.filter(
    (phrase) => !order.approvedAliases.some((alias) => normalizeText(alias) === normalizeText(phrase)),
  );
  return {
    value: approved.length > 0 ? order.anatomicalStructure : undefined,
    conflicts: approved.length > 0 && additional.length > 0
      ? [`Additional or conflicting anatomy was detected: ${additional.join(", ")}.`]
      : [],
  };
}

function supportedSyntax(order, text) {
  const anatomy = order.approvedAliases.map(phrasePattern).sort((a, b) => b.length - a.length).join("|");
  const dispositions = dispositionAliases.flatMap(([, aliases]) => aliases)
    .map(phrasePattern).sort((a, b) => b.length - a.length).join("|");
  const counts = `(?:[1-9]|10|${Object.keys(numberWords).join("|")})`;
  return new RegExp(
    `^(?:(?:the|a)\\s+)?(?:left|right|midline)\\s+(?:${anatomy})\\s+(?:${dispositions})\\s+${counts}\\s+(?:containers?|jars?)$`,
  ).test(text);
}

function findCaseReferences(text) {
  return [...text.matchAll(/\b(?:case\s+)?or\s*(\d{1,6})\b/g)].map((match) => `OR-${match[1]}`);
}

export function parseStatement(order, input) {
  const normalized = normalizeText(input);
  const laterality = parseLaterality(normalized);
  const disposition = parseDisposition(normalized);
  const containerCount = parseContainerCount(normalized);
  const anatomy = parseAnatomy(order, normalized);
  const caseReferences = findCaseReferences(normalized);
  const expectedCaseNumber = String(order.caseId).match(/\d+/)?.[0];
  const conflictingCases = unique(caseReferences).filter((caseId) => caseId !== `OR-${expectedCaseNumber}`);
  const patientIdentityMentioned = /\b(?:patient|mrn|medical record|date of birth|dob)\b/.test(normalized);
  const flags = {
    negation: /\b(?:not|no|never|without|cannot)\b/.test(normalized),
    uncertainty: /\b(?:unsure|uncertain|maybe|probably|possibly|perhaps|guess)\b|\b(?:i think|i believe|not sure)\b/.test(normalized),
    correction: /\b(?:actually|correction|correct that|instead|rather|i mean)\b/.test(normalized),
    stop: /\b(?:do not proceed|stop|hold|pause|cancel|abort)\b/.test(normalized),
    preservation: /\b(?:formalin|saline|fixative|preservative|dry container)\b/.test(normalized),
    patientIdentityMentioned,
  };
  return {
    original: String(input ?? ""),
    normalized,
    anatomicalStructure: anatomy.value,
    laterality: laterality.value,
    disposition: disposition.value,
    containerCount: containerCount.value,
    supportedSyntax: supportedSyntax(order, normalized),
    flags,
    caseReferences,
    unsupported: [
      ...containerCount.unsupported.map((value) => `Unsupported container count: ${value}.`),
      ...(flags.preservation ? ["Preservation medium is outside this prototype's supported disposition scope."] : []),
      ...(patientIdentityMentioned ? ["Patient identity is not verified by this prototype."] : []),
    ],
    conflicts: [
      ...laterality.conflicts,
      ...disposition.conflicts,
      ...containerCount.conflicts,
      ...anatomy.conflicts,
      ...(conflictingCases.length > 0
        ? [`Conflicting synthetic case identity was detected: ${conflictingCases.join(", ")}.`]
        : []),
    ],
  };
}

function display(value) {
  return String(value ?? "missing").replaceAll("_", " ").toLowerCase();
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function verifyStatement(order, input) {
  const parsed = parseStatement(order, input);
  const expected = {
    anatomicalStructure: order.anatomicalStructure,
    laterality: order.laterality,
    disposition: order.disposition,
    containerCount: order.containerCount,
  };
  const missing = criticalFields.filter((field) => parsed[field] === undefined);
  const differences = criticalFields.filter(
    (field) => parsed[field] !== undefined && parsed[field] !== expected[field],
  ).map((field) => ({ field, expected: display(expected[field]), received: display(parsed[field]) }));
  const reasons = [...parsed.conflicts, ...parsed.unsupported];

  const result = (status, summary) => ({ status, summary, parsed, missing, differences, reasons });
  if (!parsed.normalized) return result("RETRY", "No spoken statement was captured.");
  if (parsed.flags.stop) {
    return result("BLOCK", "Explicit stop language was detected. Do not proceed; provide a fresh complete statement only after the discrepancy is resolved.");
  }
  if (parsed.flags.negation) {
    return result("BLOCK", "Negated language was detected. Resolve the discrepancy and provide a fresh complete statement.");
  }
  if (parsed.flags.correction) {
    return result("RETRY", "Correction language was detected. Provide one fresh complete statement.");
  }
  if (parsed.flags.uncertainty) {
    return result("RETRY", "Uncertainty was detected. Resolve it and provide one fresh complete statement.");
  }
  if (parsed.conflicts.length > 0) return result("BLOCK", parsed.conflicts[0]);
  if (parsed.unsupported.length > 0) return result("RETRY", parsed.unsupported[0]);
  if (!parsed.supportedSyntax) {
    const missingText = missing.map((field) => fieldLabels[field]).join(", ");
    return result(
      "RETRY",
      missingText
        ? `Incomplete or unsupported statement: missing ${missingText}. Provide laterality, supported anatomy, disposition, and one container count in that order.`
        : "Unsupported statement pattern. Provide one complete statement with laterality, supported anatomy, disposition, and one container count in that order.",
    );
  }
  if (differences.length > 0) {
    const first = differences[0];
    return result("BLOCK", `${capitalize(fieldLabels[first.field])} mismatch: expected ${first.expected}, but heard ${first.received}.`);
  }
  return result("ACCEPT", "All required statement fields match.");
}

export function verifyReadbackAgainstCallout(order, callout, readbackText) {
  const result = verifyStatement(order, readbackText);
  if (result.status !== "ACCEPT") return result;
  const differences = criticalFields.filter((field) => result.parsed[field] !== callout[field]).map(
    (field) => ({ field, expected: display(callout[field]), received: display(result.parsed[field]) }),
  );
  if (differences.length === 0) return result;
  const first = differences[0];
  return {
    ...result,
    status: "BLOCK",
    summary: `Callout/read-back ${fieldLabels[first.field]} mismatch: expected ${first.expected}, but heard ${first.received}.`,
    differences,
  };
}

export function verifyLabel(order, scannedCode) {
  const normalizedCode = String(scannedCode ?? "").trim().toUpperCase();
  if (!normalizedCode) return { status: "RETRY", summary: "No label code was captured.", normalizedCode };
  if (normalizedCode !== order.labelCode) {
    return {
      status: "BLOCK",
      summary: `Label-code mismatch: ${normalizedCode} does not belong to ${order.caseId}.`,
      normalizedCode,
    };
  }
  return { status: "ACCEPT", summary: "Label code matches the active synthetic case.", normalizedCode };
}
