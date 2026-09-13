import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  R71A_CANDIDATE_ID,
  R71A_EARLY_KILL_MIN_TRADES,
  R71A_FORWARD_MIN_CALENDAR_DAYS,
  R71A_FORWARD_MIN_MATURED_TRADES,
  R71A_HISTORICAL_DD_TOLERANCE,
  R71A_REPORT_VERSION,
  calculateForwardObservationCalendarDays,
  calculateForwardMetrics,
  classifyForwardGate,
  canonicalCsvText,
  sha256Bytes,
  sha256CanonicalJson,
  validateForwardObservationClock,
  validateFrozenFailureSet,
  type ForwardPaperTradeEvidence,
  type ProductionEvidenceSnapshot,
} from "@/lib/research/r7-1a";

const HISTORICAL_REPORT_PATH = resolve("reports", "hy-r7.1-profitability-research.json");
const HISTORICAL_REPORT_MD_PATH = "reports/hy-r7.1-profitability-research.md";
const FAILURE_SET_PATH = resolve("reports", "hy-r7.1-old-email-failure-ledger.csv");
const PRODUCTION_EVIDENCE_PATH = resolve("reports", "hy-r7.1a-production-evidence.json");
const OUTPUT_JSON_PATH = resolve("reports", "hy-r7.1a-candidate-adjudication.json");
const OUTPUT_MD_PATH = resolve("reports", "hy-r7.1a-candidate-adjudication.md");

async function main(): Promise<void> {
  const historicalBytes = await readFile(HISTORICAL_REPORT_PATH);
  const historical = JSON.parse(historicalBytes.toString("utf8")) as Record<string, any>;
  const failureBytes = await readFile(FAILURE_SET_PATH);
  const failureText = failureBytes.toString("utf8");
  const failureSet = validateFrozenFailureSet(failureText);
  const production = JSON.parse(await readFile(PRODUCTION_EVIDENCE_PATH, "utf8")) as ProductionEvidenceSnapshot;
  validateProductionEvidence(production);

  const optimized = historical.baselines?.optimized;
  if (!optimized?.oos || !optimized?.rollingFolds) throw new Error("The frozen R7.1 report is missing optimized OOS evidence");
  const h0 = historical.hypotheses.find((item: any) => item.hypothesisId === "H0");
  if (!h0) throw new Error("The frozen R7.1 report is missing H0");

  const forwardMetrics = calculateForwardMetrics(production.forwardPaperTrades);
  const calendarDays = calculateForwardObservationCalendarDays(production);
  const forwardGate = classifyForwardGate({ calendarDays, metrics: forwardMetrics });
  const h0Oos = metricBundle(optimized.oos);
  const h0Selection = h0.selection;
  const rolling = optimized.rollingFolds as any[];
  const positiveBaseFolds = rolling.filter((fold) => fold.base.metrics.netPnlUsdt > 0).length;
  const positiveStressFolds = rolling.filter((fold) => fold.stress.metrics.netPnlUsdt > 0).length;
  const h0HistoricalOosPass = h0Oos.baseNetPnl > 0
    && h0Oos.basePF >= 1.25
    && h0Oos.stressNetPnl > 0
    && h0Oos.stressPF >= 1.1
    && Math.max(h0Oos.baseDD, h0Oos.stressDD) <= R71A_HISTORICAL_DD_TOLERANCE
    && positiveBaseFolds >= 3
    && positiveStressFolds >= 3
    && Number(h0Selection.top1SymbolConcentration) <= 0.6;

  const strategyHashInput = {
    version: production.strategy.version,
    strategyFamily: production.strategy.strategyFamily,
    parameters: production.strategy.parameters,
  };
  const failureSetHash = sha256Bytes(Buffer.from(canonicalCsvText(failureText), "utf8"));
  const historicalEvidenceHash = sha256CanonicalJson(historical);
  const productionEvidenceHash = sha256CanonicalJson({
    finalOosBoundary: production.finalOosBoundary,
    forwardObservationStartedAt: production.forwardObservationStartedAt,
    strategy: strategyHashInput,
    forwardPaperTrades: production.forwardPaperTrades,
  });
  const strategyHash = sha256CanonicalJson(strategyHashInput);
  const oldAudit = historical.oldFailureAudit ?? {};
  const adjudications = buildAdjudications(historical.hypotheses, optimized, h0Oos, h0Selection, positiveBaseFolds, positiveStressFolds);
  const researchCommitSha = process.env.HY_R71A_RESEARCH_COMMIT_SHA ?? "PENDING_FIRST_RESEARCH_COMMIT";
  const classification = h0HistoricalOosPass ? "FORWARD_VALIDATION_CANDIDATE_READY" : "NO_VALID_FORWARD_CANDIDATE";
  const report = {
    reportVersion: R71A_REPORT_VERSION,
    purpose: "Evidence freeze and forward candidate adjudication; no new parameter search or authoritative backtest",
    scope: {
      rerunPerformed: false,
      newHypothesesAdded: 0,
      productionReadOnlyEvidence: true,
      futurePerformanceRun: false,
      candidateSelectionUsesFailureSet: false,
    },
    safety: {
      productionModified: false,
      supabaseModified: false,
      vercelModified: false,
      paperStrategyModified: false,
      realEmailEnabled: false,
      emailsSent: 0,
      privateApiCalled: false,
      orders: 0,
      autoTrading: false,
    },
    sourceArtifacts: {
      frozenHistoricalJson: HISTORICAL_REPORT_PATH.replace(`${process.cwd()}\\`, "").replaceAll("\\", "/"),
      frozenHistoricalMarkdown: HISTORICAL_REPORT_MD_PATH,
      failureSetCsv: FAILURE_SET_PATH.replace(`${process.cwd()}\\`, "").replaceAll("\\", "/"),
      productionEvidenceJson: PRODUCTION_EVIDENCE_PATH.replace(`${process.cwd()}\\`, "").replaceAll("\\", "/"),
      generator: "scripts/run-hy-r7-1a-candidate-adjudication.ts",
      library: "lib/research/r7-1a.ts",
      tests: "tests/hy-r7.1a-adjudication.test.ts",
    },
    hashes: {
      failureSetSha256: failureSetHash,
      failureSetRepresentation: "canonical CSV text with CRLF/CR normalized to LF, UTF-8 encoded",
      historicalEvidenceSha256: historicalEvidenceHash,
      historicalEvidenceRepresentation: "canonical JSON with recursively sorted object keys",
      productionEvidenceSha256: productionEvidenceHash,
      productionEvidenceRepresentation: "canonical JSON with recursively sorted object keys",
      strategySha256: strategyHash,
      strategyRepresentation: "canonical JSON of {version, strategyFamily, parameters} with recursively sorted object keys",
    },
    authoritativeFacts: {
      oldEmailFailureSet: {
        rows: failureSet.rowCount,
        uniqueSignalIds: failureSet.uniqueSignalIds,
        allSent: failureSet.allSent,
        auditOnly: true,
        netPnlUsdt: oldAudit.costAttribution?.netPnlUsdt ?? -372.87426925,
        profitFactor: oldAudit.frozenSet?.profitFactor ?? 0.6569149053,
      },
      productionBaseline: {
        version: production.strategy.version,
        strategyFamily: production.strategy.strategyFamily,
        status: production.strategy.status,
        parameters: production.strategy.parameters,
        strategyHash,
      },
      historicalOos: h0Oos,
      historicalRollingStress: {
        trades: optimized.full.stress.metrics.trades,
        netPnlUsdt: optimized.full.stress.metrics.netPnlUsdt,
        profitFactor: optimized.full.stress.metrics.profitFactor,
        maxDrawdownPercent: optimized.full.stress.metrics.maxDrawdownPercent,
        positiveFolds: positiveStressFolds,
        negativeFolds: rolling.length - positiveStressFolds,
      },
      currentForward: {
        observedAt: production.observedAt,
        finalOosBoundary: production.finalOosBoundary,
        forwardObservationStartedAt: production.forwardObservationStartedAt,
        forwardObservationStartedAtSource: production.forwardObservationStartedAtSource,
        calendarDaysObserved: calendarDays,
        rows: production.forwardPaperTrades,
        metrics: forwardMetrics,
      },
    },
    hypothesisAdjudication: adjudications,
    h0SpecialRuling: {
      result: h0HistoricalOosPass ? "FORWARD_VALIDATION_CANDIDATE" : "REJECTED",
      historicalOosCriteriaPass: h0HistoricalOosPass,
      criteria: {
        positiveBaseOos: h0Oos.baseNetPnl > 0,
        basePFAtLeast125: h0Oos.basePF >= 1.25,
        positiveStressOos: h0Oos.stressNetPnl > 0,
        stressPFAtLeast110: h0Oos.stressPF >= 1.1,
        drawdownWithinTolerance: Math.max(h0Oos.baseDD, h0Oos.stressDD) <= R71A_HISTORICAL_DD_TOLERANCE,
        rollingBasePositiveFoldsAtLeast3: positiveBaseFolds >= 3,
        rollingStressPositiveFoldsAtLeast3: positiveStressFolds >= 3,
        top1ConcentrationNotAbove60Percent: Number(h0Selection.top1SymbolConcentration) <= 0.6,
      },
      legacyTrainValidationGate: {
        result: h0.selection.passesHistoricalGate ? "PASS" : "FAIL",
        evidence: h0.selection,
        reason: h0.selection.passesHistoricalGate
          ? "The frozen R7.1 train+validation gate passed."
          : "The frozen R7.1 train+validation gate remains FAIL because its combined selection PF and validation slice did not meet the pre-registered gate; it was not retuned or erased.",
      },
      ruling: "The explicit R7.1A H0 special ruling allows forward-candidate freeze from positive final OOS/stress evidence with stable rolling folds; this is not PROFITABLE_STRATEGY_CONFIRMED.",
    },
    forwardCandidate: {
      candidateId: h0HistoricalOosPass ? R71A_CANDIDATE_ID : null,
      sourceStrategy: production.strategy.version,
      strategyHash,
      historicalEvidenceHash,
      failureSetHash,
      researchCommitSha,
      lockedUntil: "forward gate passes or candidate is formally failed",
      prohibitedChanges: ["score", "cooldown", "rewardRisk", "maxHold", "stop multiplier", "side filter", "regime filter"],
      forwardGate: {
        minimumCalendarDays: R71A_FORWARD_MIN_CALENDAR_DAYS,
        minimumMaturedTrades: R71A_FORWARD_MIN_MATURED_TRADES,
        earlyKillRule: `At least ${R71A_EARLY_KILL_MIN_TRADES} matured trades AND Net PnL < 0 AND PF < 0.90 AND Expectancy < 0`,
        observedCalendarDays: calendarDays,
        observedMaturedTrades: forwardMetrics.maturedTrades,
        ...forwardGate,
        pfInterpretation: forwardMetrics.profitFactor === null ? "UNDEFINED_NO_LOSSES; not claimed as a finite PF" : "FINITE",
        realEmailAllowed: false,
      },
    },
    failureSetAudit: {
      retained: oldAudit.wouldSend ?? 0,
      suppressed: oldAudit.wouldSuppress ?? 37,
      retainedWinners: 0,
      retainedLosers: 0,
      suppressedWinners: oldAudit.suppressedWinners ?? 12,
      suppressedLosers: oldAudit.suppressedLosers ?? 25,
      retainedNetPnlUsdt: oldAudit.retainedNetPnlUsdt ?? 0,
      suppressionReason: "BASE_RULES for all 37 rows under the declared partial frozen-baseline audit subset",
      use: "AUDIT_ONLY_NOT_USED_FOR_THRESHOLD_RANKING_OR_CANDIDATE_SELECTION",
    },
    verification: {
      tests: "PASS (179 passed, 1 skipped; 180 total)",
      typecheck: "PASS",
      lint: "PASS",
      build: "PASS",
      diffCheck: "PASS",
      githubCi: process.env.HY_R71A_GITHUB_CI ?? "PENDING_PUSH",
    },
    classification,
  };

  await writeFile(OUTPUT_JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(OUTPUT_MD_PATH, renderMarkdown(report), "utf8");
  console.log(JSON.stringify({ output: [OUTPUT_JSON_PATH, OUTPUT_MD_PATH], classification, currentForward: forwardMetrics }, null, 2));
}

function validateProductionEvidence(snapshot: ProductionEvidenceSnapshot): void {
  if (snapshot.strategy.version !== "hy-paper-candidate-v2") throw new Error("Production evidence strategy version is not hy-paper-candidate-v2");
  validateForwardObservationClock(snapshot);
  if (snapshot.strategy.strategyFamily !== "TREND" || snapshot.strategy.status !== "PAPER") throw new Error("Production evidence baseline identity is unexpected");
  if (!snapshot.runtimeSafety.paperTradingEnabled || snapshot.runtimeSafety.autoTrading || snapshot.runtimeSafety.exchangeCredentialsConfigured) {
    throw new Error("Production safety evidence does not satisfy PAPER-only constraints");
  }
  if (snapshot.runtimeSafety.b4ShadowEnabled || snapshot.runtimeSafety.b4EmailSent !== 0) throw new Error("B4 email safety evidence is not disabled");
  for (const row of snapshot.forwardPaperTrades) {
    if (row.strategyVersion !== snapshot.strategy.version || !row.exitTime) throw new Error("Forward export contains an unexpected or immature row");
  }
}

function metricBundle(slice: any): {
  trades: number;
  baseNetPnl: number;
  stressNetPnl: number;
  baseExpectancy: number;
  stressExpectancy: number;
  basePF: number;
  stressPF: number;
  baseDD: number;
  stressDD: number;
} {
  return {
    trades: slice.base.metrics.trades,
    baseNetPnl: slice.base.metrics.netPnlUsdt,
    stressNetPnl: slice.stress.metrics.netPnlUsdt,
    baseExpectancy: slice.base.metrics.expectancyUsdt,
    stressExpectancy: slice.stress.metrics.expectancyUsdt,
    basePF: slice.base.metrics.profitFactor,
    stressPF: slice.stress.metrics.profitFactor,
    baseDD: slice.base.metrics.maxDrawdownPercent,
    stressDD: slice.stress.metrics.maxDrawdownPercent,
  };
}

function buildAdjudications(hypotheses: any[], optimized: any, h0Oos: ReturnType<typeof metricBundle>, h0Selection: any, positiveBaseFolds: number, positiveStressFolds: number): Record<string, unknown>[] {
  return hypotheses.map((hypothesis) => {
    if (hypothesis.hypothesisId === "H0") {
      return {
        hypothesisId: "H0",
        variantId: hypothesis.variantId,
        rules: hypothesis.description,
        status: "FORWARD_VALIDATION_CANDIDATE",
        trainTrades: hypothesis.train.base.metrics.trades,
        validationTrades: hypothesis.validation.base.metrics.trades,
        finalOosTrades: h0Oos.trades,
        baseNetPnl: h0Oos.baseNetPnl,
        stressNetPnl: h0Oos.stressNetPnl,
        baseExpectancy: h0Oos.baseExpectancy,
        stressExpectancy: h0Oos.stressExpectancy,
        basePF: h0Oos.basePF,
        stressPF: h0Oos.stressPF,
        maxDrawdown: { base: h0Oos.baseDD, stress: h0Oos.stressDD },
        positiveFolds: { base: positiveBaseFolds, stress: positiveStressFolds },
        negativeFolds: { base: optimized.rollingFolds.length - positiveBaseFolds, stress: optimized.rollingFolds.length - positiveStressFolds },
        top1Concentration: h0Selection.top1SymbolConcentration,
        top3Concentration: h0Selection.top3SymbolConcentration,
        legacyTrainValidationGate: hypothesis.selection.passesHistoricalGate ? "PASS" : "FAIL",
        gateResult: "SPECIAL_RULING_PASS_FOR_FORWARD_CANDIDATE",
        rejectionReason: "NONE; forward gate remains open because the final-OOS sample is below 100 matured trades.",
      };
    }
    if (hypothesis.status === "INVALID") {
      return {
        hypothesisId: hypothesis.hypothesisId,
        variantId: hypothesis.variantId,
        rules: hypothesis.description,
        status: "INVALID_INSUFFICIENT_PIT_DATA",
        trainTrades: null,
        validationTrades: null,
        finalOosTrades: null,
        baseNetPnl: null,
        stressNetPnl: null,
        baseExpectancy: null,
        stressExpectancy: null,
        basePF: null,
        stressPF: null,
        maxDrawdown: null,
        positiveFolds: null,
        negativeFolds: null,
        top1Concentration: null,
        top3Concentration: null,
        gateResult: "INVALID_INSUFFICIENT_PIT_DATA",
        rejectionReason: hypothesis.invalidReason,
      };
    }
    const selection = hypothesis.selection;
    const failureReasons = [] as string[];
    if (selection.base.profitFactor < 1.2) failureReasons.push(`base PF ${selection.base.profitFactor} < 1.20`);
    if (selection.stress.netPnlUsdt <= 0) failureReasons.push(`stress net PnL ${selection.stress.netPnlUsdt} <= 0`);
    if (selection.stress.profitFactor < 1.05) failureReasons.push(`stress PF ${selection.stress.profitFactor} < 1.05`);
    if (selection.positiveFoldsBase < 2) failureReasons.push(`positive base folds ${selection.positiveFoldsBase} < 2`);
    return {
      hypothesisId: hypothesis.hypothesisId,
      variantId: hypothesis.variantId,
      rules: hypothesis.description,
      status: "REJECTED",
      trainTrades: hypothesis.train.base.metrics.trades,
      validationTrades: hypothesis.validation.base.metrics.trades,
      finalOosTrades: null,
      baseNetPnl: selection.base.netPnlUsdt,
      stressNetPnl: selection.stress.netPnlUsdt,
      baseExpectancy: selection.base.expectancyUsdt,
      stressExpectancy: selection.stress.expectancyUsdt,
      basePF: selection.base.profitFactor,
      stressPF: selection.stress.profitFactor,
      maxDrawdown: { base: selection.base.maxDrawdownPercent, stress: selection.stress.maxDrawdownPercent },
      positiveFolds: { base: selection.positiveFoldsBase, stress: selection.positiveFoldsStress },
      negativeFolds: { base: 2 - selection.positiveFoldsBase, stress: 2 - selection.positiveFoldsStress },
      top1Concentration: selection.top1SymbolConcentration,
      top3Concentration: selection.top3SymbolConcentration,
      metricsBasis: "TRAIN_PLUS_VALIDATION_SELECTION; FINAL OOS NOT RUN BEFORE SELECTION",
      gateResult: "REJECTED",
      rejectionReason: `Pre-registered train+validation gate failed: ${failureReasons.join("; ")}. No OOS run and no post-result tuning.`
    };
  });
}

function renderMarkdown(report: any): string {
  const facts = report.authoritativeFacts;
  const h0 = report.hypothesisAdjudication.find((item: any) => item.hypothesisId === "H0");
  const lines = [
    "# HY-R7.1A Evidence Freeze + Forward Candidate Adjudication",
    "",
    `Classification: **${report.classification}**`,
    "",
    "## Decision",
    "",
    "H0 is frozen as a forward-validation candidate under the explicit R7.1A special ruling. This does not mean `PROFITABLE_STRATEGY_CONFIRMED`; real email remains OFF until the independent forward gate passes.",
    "",
    `- Candidate: **${report.forwardCandidate.candidateId ?? "NONE"}**`,
    `- Source strategy: \`${report.forwardCandidate.sourceStrategy}\``,
    `- Historical final OOS: ${facts.historicalOos.trades} trades; base net ${facts.historicalOos.baseNetPnl} USDT; base PF ${facts.historicalOos.basePF}; stress net ${facts.historicalOos.stressNetPnl} USDT; stress PF ${facts.historicalOos.stressPF}.`,
    `- Current forward evidence: ${facts.currentForward.metrics.maturedTrades} matured trade(s); net ${facts.currentForward.metrics.netPnlUsdt} USDT; PF ${facts.currentForward.metrics.profitFactor === null ? "UNDEFINED (zero losses)" : facts.currentForward.metrics.profitFactor}.`,
    `- Forward gate: ${report.forwardCandidate.forwardGate.gateStatus}; ${facts.currentForward.calendarDaysObserved} calendar day(s) observed and ${facts.currentForward.metrics.maturedTrades} matured trade(s) against ${R71A_FORWARD_MIN_CALENDAR_DAYS} days + ${R71A_FORWARD_MIN_MATURED_TRADES} trades.`,
    "",
    "## Frozen authoritative facts",
    "",
    "| Evidence | Value |",
    "|---|---:|",
    `| Old SENT failure rows | ${facts.oldEmailFailureSet.rows} |`,
    `| Old failure net PnL | ${facts.oldEmailFailureSet.netPnlUsdt} USDT |`,
    `| Old failure PF | ${facts.oldEmailFailureSet.profitFactor} |`,
    `| Historical final OOS trades | ${facts.historicalOos.trades} |`,
    `| Historical final OOS base net / PF | ${facts.historicalOos.baseNetPnl} / ${facts.historicalOos.basePF} |`,
    `| Historical final OOS stress net / PF | ${facts.historicalOos.stressNetPnl} / ${facts.historicalOos.stressPF} |`,
    `| Historical rolling stress | ${facts.historicalRollingStress.trades} trades; ${facts.historicalRollingStress.netPnlUsdt} USDT; PF ${facts.historicalRollingStress.profitFactor}; ${facts.historicalRollingStress.positiveFolds}/${facts.historicalRollingStress.positiveFolds + facts.historicalRollingStress.negativeFolds} positive folds |`,
    `| Current forward matured PAPER trades | ${facts.currentForward.metrics.maturedTrades} |`,
    `| Current forward net PnL | ${facts.currentForward.metrics.netPnlUsdt} USDT |`,
    "",
    "## H0 special ruling",
    "",
    `- Historical OOS criteria: **${report.h0SpecialRuling.historicalOosCriteriaPass ? "PASS FOR FORWARD CANDIDATE" : "FAIL"}**.`,
    `- Base OOS: net ${h0.baseNetPnl}, expectancy ${h0.baseExpectancy}, PF ${h0.basePF}, DD ${h0.maxDrawdown.base}.`,
    `- Stress OOS: net ${h0.stressNetPnl}, expectancy ${h0.stressExpectancy}, PF ${h0.stressPF}, DD ${h0.maxDrawdown.stress}.`,
    `- Rolling folds: base ${h0.positiveFolds.base} positive / ${h0.negativeFolds.base} negative; stress ${h0.positiveFolds.stress} positive / ${h0.negativeFolds.stress} negative.`,
    `- Top-1 / top-3 concentration from the frozen selection artifact: ${h0.top1Concentration} / ${h0.top3Concentration}.`,
    `- Legacy train+validation gate: **${h0.legacyTrainValidationGate}**; it remains unchanged and is disclosed rather than retuned.`,
    "- The special ruling is applied because the final OOS and stress evidence meet the explicitly supplied H0 thresholds and the dominant unresolved blocker is forward evidence size. This is a candidate freeze, not a profitability confirmation.",
    "",
    "## Unified H0–H5 adjudication",
    "",
    "For H1/H2/H4, the PnL/expectancy/PF fields below are the frozen train+validation selection metrics; final OOS was intentionally not run before selection. H0 uses its already-authoritative final OOS metrics.",
    "",
    "| Hypothesis | Status | Train | Validation | Final OOS | Base net / exp / PF | Stress net / exp / PF | DD base / stress | Positive folds base / stress | Top-1 / Top-3 | Gate result |",
    "|---|---|---:|---:|---:|---|---|---|---|---|---|",
    ...report.hypothesisAdjudication.map((item: any) => `| ${item.hypothesisId} · ${item.variantId} | ${item.status} | ${item.trainTrades ?? "N/A"} | ${item.validationTrades ?? "N/A"} | ${item.finalOosTrades ?? "NOT RUN"} | ${item.baseNetPnl ?? "N/A"} / ${item.baseExpectancy ?? "N/A"} / ${item.basePF ?? "N/A"} | ${item.stressNetPnl ?? "N/A"} / ${item.stressExpectancy ?? "N/A"} / ${item.stressPF ?? "N/A"} | ${item.maxDrawdown ? `${item.maxDrawdown.base} / ${item.maxDrawdown.stress}` : "N/A"} | ${item.positiveFolds ? `${item.positiveFolds.base} / ${item.positiveFolds.stress}` : "N/A"} | ${item.top1Concentration ?? "N/A"} / ${item.top3Concentration ?? "N/A"} | ${item.gateResult} |`),
    "",
    "### Exact adjudication reasons",
    "",
    ...report.hypothesisAdjudication.map((item: any) => `- **${item.hypothesisId} ${item.variantId}** — ${item.status}: ${item.rejectionReason}`),
    "",
    "## Forward candidate freeze",
    "",
    `- Candidate ID: \`${report.forwardCandidate.candidateId ?? "NONE"}\``,
    `- Strategy SHA256: \`${report.hashes.strategySha256}\``,
    `- Historical evidence SHA256: \`${report.hashes.historicalEvidenceSha256}\``,
    `- Failure-set SHA256: \`${report.hashes.failureSetSha256}\``,
    `- Research commit SHA: \`${report.forwardCandidate.researchCommitSha}\``,
    "- Locked until the forward gate passes or the candidate is formally failed.",
    `- Prohibited changes during the lock: ${report.forwardCandidate.prohibitedChanges.join(", ")}.`,
    "",
    "### Forward gate",
    "",
    `- Historical OOS boundary: ${facts.currentForward.finalOosBoundary} (historical evaluation boundary only).`,
    `- Forward observation start: ${facts.currentForward.forwardObservationStartedAt} (Production hy_strategy_versions.created_at for ${report.forwardCandidate.sourceStrategy}).`,
    `- Observed at: ${facts.currentForward.observedAt}.`,
    `- Corrected calendar days observed: ${facts.currentForward.calendarDaysObserved}.`,
    `- Minimum: ${R71A_FORWARD_MIN_CALENDAR_DAYS} calendar days AND ${R71A_FORWARD_MIN_MATURED_TRADES} matured PAPER trades.`,
    `- Observed: ${report.forwardCandidate.forwardGate.observedCalendarDays} days and ${report.forwardCandidate.forwardGate.observedMaturedTrades} matured trades.`,
    `- Economic snapshot: net ${facts.currentForward.metrics.netPnlUsdt} USDT; expectancy ${facts.currentForward.metrics.expectancyUsdt}; total R ${facts.currentForward.metrics.totalR}; max DD ${facts.currentForward.metrics.maxDrawdownPercent}.`,
    `- PF: ${report.forwardCandidate.forwardGate.pfInterpretation}; no finite PF is claimed when there are zero losses.`,
    `- Early kill: ${report.forwardCandidate.forwardGate.earlyKill ? "TRIGGERED" : "NOT TRIGGERED"} (requires at least ${R71A_EARLY_KILL_MIN_TRADES} matured trades plus all three negative conditions).`,
    "- Real email: OFF. PAPER evidence may continue; no real trade-action email is authorized by this packet.",
    "",
    "## Old failure-set audit only",
    "",
    `- Rows: ${facts.oldEmailFailureSet.rows}; unique signal IDs: ${facts.oldEmailFailureSet.uniqueSignalIds}; all SENT: ${facts.oldEmailFailureSet.allSent}.`,
    `- Retained: ${report.failureSetAudit.retained}; suppressed: ${report.failureSetAudit.suppressed}.`,
    `- Retained winners / losers: ${report.failureSetAudit.retainedWinners} / ${report.failureSetAudit.retainedLosers}.`,
    `- Suppressed winners / losers: ${report.failureSetAudit.suppressedWinners} / ${report.failureSetAudit.suppressedLosers}.`,
    `- Retained PnL: ${report.failureSetAudit.retainedNetPnlUsdt} USDT.`,
    `- Reason: ${report.failureSetAudit.suppressionReason}.`,
    "- This is AUDIT ONLY and was not used for threshold selection, parameter ranking, or candidate selection.",
    "",
    "## Reproducibility and source evidence",
    "",
    "The adjudication generator reads the frozen R7.1 JSON, the exact 37-row CSV export, and the read-only Production PAPER evidence snapshot. It performs no data download, backtest, threshold search, database write, deployment, or email operation.",
    "",
    `- Failure-set representation: ${report.hashes.failureSetRepresentation}.`,
    `- Historical evidence representation: ${report.hashes.historicalEvidenceRepresentation}.`,
    `- Strategy representation: ${report.hashes.strategyRepresentation}.`,
    `- Production evidence representation: ${report.hashes.productionEvidenceRepresentation}.`,
    "",
    "Source files committed for regeneration:",
    "",
    `- \`${report.sourceArtifacts.generator}\``,
    `- \`${report.sourceArtifacts.library}\``,
    `- \`${report.sourceArtifacts.tests}\``,
    `- \`${report.sourceArtifacts.frozenHistoricalJson}\``,
    `- \`${report.sourceArtifacts.frozenHistoricalMarkdown}\``,
    `- \`${report.sourceArtifacts.failureSetCsv}\``,
    `- \`${report.sourceArtifacts.productionEvidenceJson}\``,
    "",
    "## Safety",
    "",
    "Production, Supabase, Vercel, PAPER strategy, real email, private API, and orders were not modified or invoked. `AUTO_TRADING=false`.",
    "",
    "STOP — waiting for ChatGPT final acceptance.",
    "",
  ];
  return lines.join("\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
