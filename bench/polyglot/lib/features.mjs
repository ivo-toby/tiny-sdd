// Failure features for one result, derived from its last attempt.

const OUTCOME_FEATURES = {
  timeout: 'worker_timeout',
  tool_limit: 'tool_limit',
  response_token_limit: 'response_token_limit',
  raw_output_limit: 'raw_output_limit',
  no_progress: 'no_progress',
};

const COMPILE_ERROR_PATTERNS = {
  python: [/SyntaxError|IndentationError|ERROR collecting/],
  go: [/\[build failed\]|\[setup failed\]|undefined: |syntax error|declared and not used/],
  rust: [/error\[E\d+\]|could not compile/],
  javascript: [/Test suite failed to run|SyntaxError/],
  java: [/cannot find symbol|COMPILATION ERROR|compile(Test)?Java FAILED|incompatible types/],
  cpp: [/error: |undefined reference to|CMake Error/],
};

const GENERIC_COMPILE_PATTERNS = [/SyntaxError|IndentationError|error\[E\d+\]|cannot find symbol|undefined reference to/];

export function isCompileError(language, text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const patterns = COMPILE_ERROR_PATTERNS[language] ?? GENERIC_COMPILE_PATTERNS;
  return patterns.some((pattern) => pattern.test(text));
}

export function featuresFor(result) {
  const attempt = Array.isArray(result?.attempts) ? result.attempts.at(-1) : null;
  if (!attempt) return [];
  const found = new Set();

  const outcome = attempt.workerOutcome;
  if (outcome && outcome !== 'completed') found.add(OUTCOME_FEATURES[outcome] ?? 'worker_failed');
  if (!Array.isArray(attempt.changedFiles) || attempt.changedFiles.length === 0) found.add('no_edits');
  if (attempt.scopeViolation) found.add('scope_violation');

  const test = attempt.test;
  if (test) {
    if (test.timedOut) {
      found.add('test_timeout');
    } else if (!test.passed && isCompileError(result.language, test.outputTail)) {
      found.add('compile_error');
    }
    if (test.passed) {
      found.add('passed');
    } else if (!found.has('test_timeout') && !found.has('compile_error')) {
      found.add('tests_failed');
    }
  }
  return [...found].sort();
}
