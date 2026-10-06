import { readSliceTestReviewEvents, validateSliceTestReviewEvent } from './slice-test-review.mjs';
import { digestJson, tinyError } from './fs-utils.mjs';

const UNKNOWN = 'UNKNOWN';

function ratio(numerator, denominator) {
  return { numerator, denominator, value: denominator === 0 ? UNKNOWN : numerator / denominator };
}

function measuredTotal(records, key) {
  let measured = 0;
  let missing = 0;
  for (const record of records) {
    const value = record.assessment.measurements[key];
    if (value === UNKNOWN) missing += 1;
    else measured += value;
  }
  if (!Number.isFinite(measured) || (!Number.isSafeInteger(measured) && key !== 'latencyMs')) throw tinyError('SLICE_TEST_REVIEW_REPORT_INVALID', 'measurement total exceeds the safe numeric range');
  return { measured, measuredCases: records.length - missing, missingCases: missing, total: missing === 0 && records.length > 0 ? measured : UNKNOWN };
}

export function buildSliceTestReviewReport(values, { feature } = {}) {
  if (!Array.isArray(values)) throw tinyError('SLICE_TEST_REVIEW_REPORT_INVALID', 'review events must be an array');
  if (feature !== undefined && (typeof feature !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u.test(feature))) {
    throw tinyError('SLICE_TEST_REVIEW_REPORT_INVALID', 'feature must be a bounded identifier');
  }
  const all = values.map(validateSliceTestReviewEvent);
  const ids = new Set();
  for (const event of all) {
    if (ids.has(event.eventId)) throw tinyError('SLICE_TEST_REVIEW_DUPLICATE', 'report contains duplicate events');
    ids.add(event.eventId);
  }
  const events = all.filter((event) => feature === undefined || event.identity.featureId === feature);
  const assessments = events.filter((event) => ['initial-assessment', 'revision-assessment'].includes(event.eventType));
  const pairs = [];
  for (const assessment of assessments) {
    const reviews = events.filter((event) => event.eventType === 'strong-review'
      && event.inputDigest === assessment.inputDigest
      && event.envelopeDigest === assessment.envelopeDigest
      && event.identity.featureId === assessment.identity.featureId
      && event.identity.taskId === assessment.identity.taskId
      && event.identity.sliceId === assessment.identity.sliceId
      && event.identity.lineageId === assessment.identity.lineageId
      && event.identity.runId === assessment.identity.runId
      && event.sequence > assessment.sequence
      && event.review !== UNKNOWN
      && event.review.inputDigest === assessment.inputDigest
      && event.review.strength === 'strong'
      && event.review.attested === true
      && ['accepted', 'rejected'].includes(event.review.verdict));
    if (reviews.length > 1) throw tinyError('SLICE_TEST_REVIEW_REPORT_INVALID', 'assessment has conflicting independent reviews');
    if (reviews.length === 1) {
      const matching = assessments.filter((event) => event.inputDigest === assessment.inputDigest
        && event.envelopeDigest === assessment.envelopeDigest
        && event.identity.featureId === assessment.identity.featureId
        && event.identity.taskId === assessment.identity.taskId
        && event.identity.sliceId === assessment.identity.sliceId
        && event.identity.lineageId === assessment.identity.lineageId
        && event.identity.runId === assessment.identity.runId
        && event.sequence < reviews[0].sequence);
      if (matching.length !== 1) throw tinyError('SLICE_TEST_REVIEW_REPORT_INVALID', 'review cannot be attributed to exactly one assessment');
      pairs.push({ assessment, review: reviews[0] });
    }
  }
  const positives = assessments.filter((event) => event.assessment.verdict === 'positive');
  const negatives = assessments.filter((event) => event.assessment.verdict === 'negative');
  const positivePairs = pairs.filter(({ assessment }) => assessment.assessment.verdict === 'positive');
  const negativePairs = pairs.filter(({ assessment }) => assessment.assessment.verdict === 'negative');
  const calibrationCases = pairs.flatMap(({ assessment, review }) => assessment.assessment.observations.map((observation) => ({
    eventId: assessment.eventId,
    reviewEventId: review.eventId,
    featureId: assessment.identity.featureId,
    lineageId: assessment.identity.lineageId,
    inputDigest: assessment.inputDigest,
    criterionId: observation.criterionId,
    probability: observation.probability,
    // A whole-slice verdict does not label each individual criterion.
    criterionReference: UNKNOWN,
    sliceReference: review.review.verdict,
    provenance: assessment.provenance,
  })));
  const live = assessments.filter((event) => event.provenance.source === 'validated-final-run' && !event.provenance.replayed);
  const replay = assessments.filter((event) => event.provenance.replayed);
  const report = {
    schemaVersion: 1,
    type: 'slice-test-review-report',
    feature: feature ?? UNKNOWN,
    events: events.length,
    assessments: assessments.length,
    positiveAssessments: positives.length,
    negativeAssessments: negatives.length,
    unclassifiedAssessments: assessments.filter((event) => event.assessment.verdict === UNKNOWN).length,
    positiveReviewCoverage: ratio(positivePairs.length, positives.length),
    positiveReviewDisagreement: ratio(positivePairs.filter(({ review }) => review.review.verdict === 'rejected').length, positivePairs.length),
    reviewedNegatives: negativePairs.length,
    unreviewedNegatives: negatives.length - negativePairs.length,
    negativeReviewDisagreement: ratio(negativePairs.filter(({ review }) => review.review.verdict === 'accepted').length, negativePairs.length),
    revisionAssessments: assessments.filter((event) => event.eventType === 'revision-assessment').length,
    escalations: events.filter((event) => event.eventType === 'escalation').length,
    failures: events.filter((event) => ['provider-failure', 'assessment-missing', 'assessment-unavailable'].includes(event.eventType)).length,
    liveAssessments: live.length,
    replayAssessments: replay.length,
    syntheticAssessments: assessments.filter((event) => event.provenance.source === 'synthetic').length,
    measuredJevUsage: Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'latencyMs'].map((key) => [key, measuredTotal(live, key)])),
    replayOriginalMeasurements: replay.map((event) => ({ eventId: event.eventId, measurements: event.assessment.measurements })),
    frontierReviewUsage: UNKNOWN,
    totalFeatureCost: UNKNOWN,
    directStrongImplementationComparison: UNKNOWN,
    populationCalibration: UNKNOWN,
    criterionCalibration: UNKNOWN,
    calibrationCases,
    grouping: 'featureId+lineageId',
    referenceMeaning: 'Independent review is a reference assessment, not infallible ground truth.',
    reviewAttribution: 'Counts use recorded strong-review attestations; the report does not verify model execution or reviewer independence.',
    sourceDigest: digestJson(events.map((event) => event.eventDigest)),
  };
  return report;
}

export async function reportSliceTestReviews(projectRoot, options = {}) {
  return buildSliceTestReviewReport(await readSliceTestReviewEvents(projectRoot), options);
}
