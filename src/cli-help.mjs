export const STOP_WAIT_MS_DEFAULT = 30_000;
export const STOP_WAIT_MS_MAX = 600_000;

export const GLOBAL_FLAGS = [
  { flag: '--json', description: 'print exactly one JSON object on stdout (help included)' },
  { flag: '--project PATH', description: 'project root, default: current directory' },
  { flag: '--help, -h', description: 'show help for the whole CLI or for one command' },
  { flag: '--version, -v', description: 'print the CLI version' },
];

const COMMANDS = [
  {
    command: 'setup',
    group: 'Setup',
    summary: 'Check prerequisites and install the matching release: global skills links and the profile registry. Global; no --project.',
    usage: 'tinysdd [--json] setup',
    global: true,
    flags: [],
    example: 'tinysdd setup',
  },
  {
    command: 'skills update',
    group: 'Setup',
    summary: 'Replace the installed skills with this CLI version\'s release. Global; run after upgrading.',
    usage: 'tinysdd [--json] skills update',
    global: true,
    flags: [],
    example: 'tinysdd skills update',
  },
  {
    command: 'profiles update',
    group: 'Setup',
    summary: 'Replace the installed profile registry with this CLI version\'s release. Global; run after upgrading.',
    usage: 'tinysdd [--json] profiles update',
    global: true,
    flags: [],
    example: 'tinysdd profiles update',
  },
  {
    command: 'profiles new',
    group: 'Setup',
    summary: 'Write a configuration-only profile to ~/.config/tiny-sdd/profiles/; asks for missing values on a terminal.',
    usage: 'tinysdd [--json] profiles new [--route MODEL] [--id ID] [--context-window N] [--parallel N] [--max-tokens N] [--timeout-ms N] [--thinking LEVEL] [--family NAME] [--quantization NAME] [--server NAME]',
    flags: [
      { flag: '--route MODEL', description: 'worker model id (the exact Pi model / route)', required: true },
      { flag: '--id ID', description: 'profile id, default: derived from the route' },
      { flag: '--context-window N', description: 'context window in tokens (per request slot)' },
      { flag: '--parallel N', description: 'parallel server slots' },
      { flag: '--max-tokens N', description: 'max response tokens (Pi maxTokens)' },
      { flag: '--timeout-ms N', description: 'worker timeout in ms' },
      { flag: '--thinking LEVEL', description: 'thinking level (off, minimal, low, medium, high)' },
      { flag: '--family NAME', description: 'model family, e.g. gemma4-26b-a4b' },
      { flag: '--quantization NAME', description: 'quantization, e.g. Q4_K_M' },
      { flag: '--server NAME', description: 'inference server, e.g. llama.cpp' },
    ],
    example: 'tinysdd profiles new --route qwen3-30b --thinking low',
  },
  {
    command: 'models',
    group: 'Setup',
    summary: 'List known model profiles and the installed registry, optionally filtered by route.',
    usage: 'tinysdd [--json] [--project PATH] models [--route MODEL]',
    flags: [{ flag: '--route MODEL', description: 'show only profiles measured on this model route' }],
    example: 'tinysdd models --route qwen3-30b',
  },
  {
    command: 'init',
    group: 'Setup',
    summary: 'Create .tinysdd/config.json for the project and select the profile measured on the worker\'s model route.',
    usage: 'tinysdd [--json] [--project PATH] init [--worker NAME --provider ID --model ID [--profile ID|PATH]]',
    flags: [
      { flag: '--worker NAME', description: 'worker name to configure; give with --provider and --model' },
      { flag: '--provider ID', description: 'provider id for the worker' },
      { flag: '--model ID', description: 'model id; the profile is matched on this exact route' },
      { flag: '--profile ID|PATH', description: 'explicit profile, required when several match the route' },
    ],
    example: 'tinysdd init --worker coder --provider pi --model qwen3-30b',
  },
  {
    command: 'config show',
    group: 'Setup',
    summary: 'Show the effective configuration for a worker, resolved with its profile.',
    usage: 'tinysdd [--json] [--project PATH] config show [--worker NAME] [--profile ID|PATH]',
    flags: [
      { flag: '--worker NAME', description: 'worker to resolve, default: defaultWorker' },
      { flag: '--profile ID|PATH', description: 'override the profile' },
    ],
    example: 'tinysdd config show --worker coder',
  },
  {
    command: 'config validate',
    group: 'Setup',
    summary: 'Validate .tinysdd/config.json and report problems without changing it.',
    usage: 'tinysdd [--json] [--project PATH] config validate [--worker NAME] [--profile ID|PATH]',
    flags: [
      { flag: '--worker NAME', description: 'worker to validate, default: defaultWorker' },
      { flag: '--profile ID|PATH', description: 'override the profile' },
    ],
    example: 'tinysdd config validate',
  },
  {
    command: 'status',
    group: 'Tasks',
    summary: 'Show tasks, blockers and the next pending action, optionally for one feature.',
    usage: 'tinysdd [--json] [--project PATH] status [--feature NAME]',
    flags: [{ flag: '--feature NAME', description: 'show only this feature' }],
    example: 'tinysdd status --feature reservations',
  },
  {
    command: 'next',
    group: 'Tasks',
    summary: 'Show the single next action TinySDD wants the operator to take.',
    usage: 'tinysdd [--json] [--project PATH] next',
    flags: [],
    example: 'tinysdd next',
  },
  {
    command: 'change validate',
    group: 'Tasks',
    summary: 'Validate a change file and report its readiness for task registration.',
    usage: 'tinysdd [--json] [--project PATH] change validate --change PATH [--ready]',
    flags: [
      { flag: '--change PATH', description: 'path to the change file', required: true },
      { flag: '--ready', description: 'require the change to be ready for registration' },
    ],
    example: 'tinysdd change validate --change changes/reservations/change.json --ready',
  },
  {
    command: 'change export',
    group: 'Tasks',
    summary: 'Export one slice of a change as a bundle to a directory.',
    usage: 'tinysdd [--json] [--project PATH] change export --change PATH --slice ID --out DIR',
    flags: [
      { flag: '--change PATH', description: 'path to the change file', required: true },
      { flag: '--slice ID', description: 'slice of the change to export', required: true },
      { flag: '--out DIR', description: 'output directory for the bundle', required: true },
    ],
    example: 'tinysdd change export --change changes/reservations/change.json --slice validation --out /tmp/tinysdd-export/validation',
  },
  {
    command: 'task add',
    group: 'Tasks',
    summary: 'Register a bounded slice with its brief, allowed files and checks.',
    usage: 'tinysdd [--json] [--project PATH] task add --id ID --brief PATH --allow FILE[,FILE] [--context PATH] [--checks PATH] [--protect FILE[,FILE]] [--preparation FILE[,FILE]] [--depends-on ID[,ID]] [--feature NAME] [--worker NAME [--worker-reason TEXT]]',
    flags: [
      { flag: '--id ID', description: 'task identifier', required: true },
      { flag: '--brief PATH', description: 'path to the task brief', required: true },
      { flag: '--allow FILE[,FILE]', description: 'files the worker may change', required: true },
      { flag: '--context PATH', description: 'extra context file for the packet' },
      { flag: '--checks PATH', description: 'checks manifest describing how to verify the slice' },
      { flag: '--protect FILE[,FILE]', description: 'files that must stay untouched' },
      { flag: '--preparation FILE[,FILE]', description: 'preparation files shipped with the packet' },
      { flag: '--depends-on ID[,ID]', description: 'tasks that must be accepted first' },
      { flag: '--feature NAME', description: 'feature this task belongs to' },
      { flag: '--worker NAME', description: 'preferred worker for this task' },
      { flag: '--worker-reason TEXT', description: 'why this worker was chosen' },
    ],
    example: 'tinysdd task add --id validation --feature reservations --brief docs/tasks/validation.md --allow src/validation.ts,tests/validation.test.mjs',
  },
  {
    command: 'task update',
    group: 'Tasks',
    summary: 'Change a task\'s inputs; bound changes require explicit reapproval.',
    usage: 'tinysdd [--json] [--project PATH] task update --id ID --by LABEL --reason TEXT [--brief PATH] [--context PATH] [--checks PATH] [--allow FILE[,FILE]] [--protect FILE[,FILE]] [--preparation FILE[,FILE]] [--depends-on ID[,ID]] [--worker NAME] [--worker-reason TEXT]',
    flags: [
      { flag: '--id ID', description: 'task identifier', required: true },
      { flag: '--by LABEL', description: 'operator label making the change', required: true },
      { flag: '--reason TEXT', description: 'why the task changed', required: true },
      { flag: '--brief PATH', description: 'new brief path' },
      { flag: '--context PATH', description: 'new context file' },
      { flag: '--checks PATH', description: 'new checks manifest' },
      { flag: '--allow FILE[,FILE]', description: 'new allowed files' },
      { flag: '--protect FILE[,FILE]', description: 'new protected files' },
      { flag: '--preparation FILE[,FILE]', description: 'new preparation files' },
      { flag: '--depends-on ID[,ID]', description: 'new dependencies' },
      { flag: '--worker NAME', description: 'new preferred worker' },
      { flag: '--worker-reason TEXT', description: 'why this worker was chosen' },
    ],
    example: 'tinysdd task update --id validation --by operator --reason "extend scope to migrations" --allow src/validation.ts,src/migrate.ts',
  },
  {
    command: 'task approve',
    group: 'Tasks',
    summary: 'Approve a pending task so a worker can be dispatched for it.',
    usage: 'tinysdd [--json] [--project PATH] task approve --id ID --by LABEL --reason TEXT',
    flags: [
      { flag: '--id ID', description: 'task identifier', required: true },
      { flag: '--by LABEL', description: 'operator label approving', required: true },
      { flag: '--reason TEXT', description: 'approval rationale', required: true },
    ],
    example: 'tinysdd task approve --id validation --by operator --reason "brief matches the spec"',
  },
  {
    command: 'task packet',
    group: 'Tasks',
    summary: 'Print the resolved worker packet (brief, context, checks, allowed paths) for a task.',
    usage: 'tinysdd [--json] [--project PATH] task packet --id ID',
    flags: [{ flag: '--id ID', description: 'task identifier', required: true }],
    example: 'tinysdd task packet --id validation',
  },
  {
    command: 'task apply',
    group: 'Tasks',
    summary: 'Copy a reviewed run\'s retained eligible files into the project; apply before task review.',
    usage: 'tinysdd [--json] [--project PATH] task apply --id ID --run RUN_ID --by LABEL',
    flags: [
      { flag: '--id ID', description: 'task identifier', required: true },
      { flag: '--run RUN_ID', description: 'worker run whose candidate to apply', required: true },
      { flag: '--by LABEL', description: 'operator label applying', required: true },
    ],
    example: 'tinysdd task apply --id validation --run run-1 --by operator',
  },
  {
    command: 'task review',
    group: 'Tasks',
    summary: 'Record the operator\'s verdict on an applied run; acceptance binds the project files.',
    usage: 'tinysdd [--json] [--project PATH] task review --id ID --verdict accepted|revision|blocked --evidence PATH --by LABEL [--candidate-paths FILE[,FILE]]',
    flags: [
      { flag: '--id ID', description: 'task identifier', required: true },
      { flag: '--verdict accepted|revision|blocked', description: 'operator verdict', required: true },
      { flag: '--evidence PATH', description: 'path to the review evidence', required: true },
      { flag: '--by LABEL', description: 'operator label reviewing', required: true },
      { flag: '--candidate-paths FILE[,FILE]', description: 'candidate files that were reviewed' },
    ],
    example: 'tinysdd task review --id validation --verdict accepted --evidence docs/reviews/validation.md --by operator',
  },
  {
    command: 'task close',
    group: 'Tasks',
    summary: 'Close a task that is no longer needed; refused while open tasks depend on it.',
    usage: 'tinysdd [--json] [--project PATH] task close --id ID --by LABEL --reason TEXT',
    flags: [
      { flag: '--id ID', description: 'task identifier', required: true },
      { flag: '--by LABEL', description: 'operator label closing', required: true },
      { flag: '--reason TEXT', description: 'why the task is closed', required: true },
    ],
    example: 'tinysdd task close --id draft --by operator --reason "folded into validation"',
  },
  {
    command: 'task supersede',
    group: 'Tasks',
    summary: 'Retire a task in favor of one or more replacement tasks.',
    usage: 'tinysdd [--json] [--project PATH] task supersede --id ID --with ID[,ID] --by LABEL --reason TEXT',
    flags: [
      { flag: '--id ID', description: 'task identifier', required: true },
      { flag: '--with ID[,ID]', description: 'replacement task id(s)', required: true },
      { flag: '--by LABEL', description: 'operator label superseding', required: true },
      { flag: '--reason TEXT', description: 'why the task is superseded', required: true },
    ],
    example: 'tinysdd task supersede --id draft --with validation --by operator --reason "replaced by the bounded slice"',
  },
  {
    command: 'worker run',
    group: 'Worker',
    summary: 'Run a worker in the foreground for a task and print its outcome.',
    usage: 'tinysdd [--json] [--project PATH] worker run --task ID [--worker NAME] [--profile ID|PATH] [--base-run RUN_ID] [--baseline-run RUN_ID] [--escalated-from RUN_ID]',
    flags: [
      { flag: '--task ID', description: 'approved task to run', required: true },
      { flag: '--worker NAME', description: 'worker to use, default: the task\'s or default worker' },
      { flag: '--profile ID|PATH', description: 'override the worker\'s profile' },
      { flag: '--base-run RUN_ID', description: 'run this one builds on' },
      { flag: '--baseline-run RUN_ID', description: 'benchmark baseline run to compare against' },
      { flag: '--escalated-from RUN_ID', description: 'run this one escalates from' },
    ],
    example: 'tinysdd worker run --task validation --worker coder',
  },
  {
    command: 'worker start',
    group: 'Worker',
    summary: 'Start a detached worker launch for real model calls from an agent; poll it with worker status.',
    usage: 'tinysdd [--json] [--project PATH] worker start --task ID [--worker NAME] [--profile ID|PATH] [--base-run RUN_ID] [--baseline-run RUN_ID] [--escalated-from RUN_ID]',
    flags: [
      { flag: '--task ID', description: 'approved task to run', required: true },
      { flag: '--worker NAME', description: 'worker to use, default: the task\'s or default worker' },
      { flag: '--profile ID|PATH', description: 'override the worker\'s profile' },
      { flag: '--base-run RUN_ID', description: 'run this one builds on' },
      { flag: '--baseline-run RUN_ID', description: 'benchmark baseline run to compare against' },
      { flag: '--escalated-from RUN_ID', description: 'run this one escalates from' },
    ],
    example: 'tinysdd worker start --task validation --worker coder',
  },
  {
    command: 'worker status',
    group: 'Worker',
    summary: 'Poll a detached launch: running, stopping, finished (with its result) or interrupted.',
    usage: 'tinysdd [--json] [--project PATH] worker status --id LAUNCH_ID',
    flags: [{ flag: '--id LAUNCH_ID', description: 'launch identifier returned by worker start', required: true }],
    example: 'tinysdd worker status --id launch-0123abcd-...',
  },
  {
    command: 'worker stop',
    group: 'Worker',
    summary: 'Stop a launch, finalizing the run with outcome stopped while keeping its evidence and candidate.',
    usage: 'tinysdd [--json] [--project PATH] worker stop --id LAUNCH_ID [--wait-ms N]',
    flags: [
      { flag: '--id LAUNCH_ID', description: 'launch identifier returned by worker start', required: true },
      { flag: `--wait-ms N`, description: `wait for the result, 0-${STOP_WAIT_MS_MAX}, default ${STOP_WAIT_MS_DEFAULT}` },
    ],
    example: 'tinysdd worker stop --id launch-0123abcd-... --wait-ms 60000',
  },
  {
    command: 'worker settings',
    group: 'Worker',
    summary: 'Inspect the effective model settings a worker entry would use.',
    usage: 'tinysdd [--json] [--project PATH] worker settings --worker NAME [--profile ID|PATH] --entry-kind real|synthetic [--observed-reasoning-tokens N]',
    flags: [
      { flag: '--worker NAME', description: 'worker to inspect', required: true },
      { flag: '--profile ID|PATH', description: 'override the worker\'s profile' },
      { flag: '--entry-kind real|synthetic', description: 'settings entry kind', required: true },
      { flag: '--observed-reasoning-tokens N', description: 'observed reasoning tokens for the entry' },
    ],
    example: 'tinysdd worker settings --worker coder --entry-kind real',
  },
  {
    command: 'bench run',
    group: 'Bench',
    summary: 'Run a benchmark suite against a worker and record attempts in .tinysdd/bench/.',
    usage: 'tinysdd [--json] [--project PATH] bench run --worker NAME [--profile ID|PATH] [--suite PATH] [--repeat K] --entry-kind real|synthetic --confirm-settings DIGEST [--ack-finding CODE] [--observed-reasoning-tokens N]',
    flags: [
      { flag: '--worker NAME', description: 'worker to benchmark', required: true },
      { flag: '--profile ID|PATH', description: 'override the worker\'s profile' },
      { flag: '--suite PATH', description: 'benchmark suite path' },
      { flag: '--repeat K', description: 'attempts per challenge' },
      { flag: '--entry-kind real|synthetic', description: 'settings entry kind being confirmed', required: true },
      { flag: '--confirm-settings DIGEST', description: 'settings digest the operator confirms', required: true },
      { flag: '--ack-finding CODE', description: 'acknowledged benchmark finding code (repeatable)' },
      { flag: '--observed-reasoning-tokens N', description: 'observed reasoning tokens for the entry' },
    ],
    example: 'tinysdd bench run --worker coder --suite bench/suite.json --repeat 3 --entry-kind synthetic --confirm-settings abc123',
  },
  {
    command: 'bench qualify',
    group: 'Bench',
    summary: 'Assess benchmark results against qualification targets and write a qualification record.',
    usage: 'tinysdd [--json] [--project PATH] bench qualify --results PATH[,PATH] [--suite PATH] [--worker NAME] [--target ROLE=NUMBER,...]',
    flags: [
      { flag: '--results PATH[,PATH]', description: 'retained benchmark invocation directories', required: true },
      { flag: '--suite PATH', description: 'benchmark suite the results belong to' },
      { flag: '--worker NAME', description: 'worker the results are for' },
      { flag: '--target ROLE=NUMBER,...', description: 'qualification targets per role (repeatable)' },
    ],
    example: 'tinysdd bench qualify --results .tinysdd/bench/write-tests-v1/INVOCATION --suite bench/write-tests-suite --target write-tests=0.8',
  },
  {
    command: 'bench rescore',
    group: 'Bench',
    summary: 'Re-score an existing qualification record against (possibly new) targets.',
    usage: 'tinysdd [--json] [--project PATH] bench rescore --record PATH [--target ROLE=NUMBER,...]',
    flags: [
      { flag: '--record PATH', description: 'qualification record to re-score', required: true },
      { flag: '--target ROLE=NUMBER,...', description: 'qualification targets per role (repeatable)' },
    ],
    example: 'tinysdd bench rescore --record .tinysdd/qualifications/DIGEST.json --target implement-slice=0.8',
  },
  {
    command: 'bench qualification show',
    group: 'Bench',
    summary: 'Show a stored qualification record, optionally filtered by suite and worker.',
    usage: 'tinysdd [--json] [--project PATH] bench qualification show --record PATH [--suite PATH] [--worker NAME]',
    flags: [
      { flag: '--record PATH', description: 'qualification record to show', required: true },
      { flag: '--suite PATH', description: 'filter by suite' },
      { flag: '--worker NAME', description: 'filter by worker' },
    ],
    example: 'tinysdd bench qualification show --record .tinysdd/qualifications/DIGEST.json',
  },
  {
    command: 'usage record',
    group: 'Usage',
    summary: 'Record a token-usage entry for a phase, model and task or feature.',
    usage: 'tinysdd [--json] [--project PATH] usage record --phase PHASE --model MODEL --input N --output N [--reasoning N] [--cache-read N] [--cache-write N] [--total N] [--task ID] [--feature NAME]',
    flags: [
      { flag: '--phase PHASE', description: 'usage phase (specify, research, plan, slice, write-tests, review, rescue)', required: true },
      { flag: '--model MODEL', description: 'model the tokens were spent on', required: true },
      { flag: '--input N', description: 'input tokens', required: true },
      { flag: '--output N', description: 'output tokens', required: true },
      { flag: '--reasoning N', description: 'reasoning tokens, default 0' },
      { flag: '--cache-read N', description: 'cache-read tokens, default 0' },
      { flag: '--cache-write N', description: 'cache-write tokens, default 0' },
      { flag: '--total N', description: 'total tokens; derived when omitted' },
      { flag: '--task ID', description: 'attribute the entry to a task' },
      { flag: '--feature NAME', description: 'attribute the entry to a feature' },
    ],
    example: 'tinysdd usage record --phase review --model frontier/model --input 1200 --output 400 --reasoning 80 --feature reservations',
  },
  {
    command: 'usage import',
    group: 'Usage',
    summary: 'Import usage records from a JSON file into the project ledger.',
    usage: 'tinysdd [--json] [--project PATH] usage import --file PATH',
    flags: [{ flag: '--file PATH', description: 'JSON file with usage records', required: true }],
    example: 'tinysdd usage import --file usage-export.json',
  },
  {
    command: 'usage report',
    group: 'Usage',
    summary: 'Report recorded usage aggregated for a feature.',
    usage: 'tinysdd [--json] [--project PATH] usage report --feature NAME',
    flags: [{ flag: '--feature NAME', description: 'feature to report on', required: true }],
    example: 'tinysdd usage report --feature reservations',
  },
  {
    command: 'feature accept',
    group: 'Usage',
    summary: 'Record feature acceptance; runs the configured featureIntegration check first when enabled.',
    usage: 'tinysdd [--json] [--project PATH] feature accept --feature NAME --by LABEL --reason TEXT',
    flags: [
      { flag: '--feature NAME', description: 'feature to accept', required: true },
      { flag: '--by LABEL', description: 'operator label accepting', required: true },
      { flag: '--reason TEXT', description: 'acceptance rationale', required: true },
    ],
    example: 'tinysdd feature accept --feature reservations --by operator --reason "all slices accepted"',
  },
  {
    command: 'feature report',
    group: 'Usage',
    summary: 'Report the state of a feature: tasks, usage and acceptance.',
    usage: 'tinysdd [--json] [--project PATH] feature report --feature NAME',
    flags: [{ flag: '--feature NAME', description: 'feature to report on', required: true }],
    example: 'tinysdd feature report --feature reservations',
  },
  {
    command: 'slice-tests report',
    group: 'Slice tests',
    summary: 'Report slice-test review coverage: assessments, escalations and disagreement.',
    usage: 'tinysdd [--json] [--project PATH] slice-tests report [--feature NAME]',
    flags: [{ flag: '--feature NAME', description: 'show only this feature' }],
    example: 'tinysdd slice-tests report',
  },
  {
    command: 'slice-tests dataset',
    group: 'Slice tests',
    summary: 'Export the slice-test review dataset for one partition.',
    usage: 'tinysdd [--json] [--project PATH] slice-tests dataset --partition train|validation|test [--feature NAME]',
    flags: [
      { flag: '--partition train|validation|test', description: 'dataset partition to export', required: true },
      { flag: '--feature NAME', description: 'export only this feature' },
    ],
    example: 'tinysdd slice-tests dataset --partition validation',
  },
  {
    command: 'slice-tests status',
    group: 'Slice tests',
    summary: 'Show the slice-test review status of one task.',
    usage: 'tinysdd [--json] [--project PATH] slice-tests status --id ID',
    flags: [{ flag: '--id ID', description: 'task id whose slice tests are reviewed', required: true }],
    example: 'tinysdd slice-tests status --id validation',
  },
  {
    command: 'slice-tests assess',
    group: 'Slice tests',
    summary: 'Assess a slice-test change with the configured producer model.',
    usage: 'tinysdd [--json] [--project PATH] slice-tests assess --id ID --run RUN --change PATH --implementer ID --producer ID --provider-config PATH --credential-env NAME',
    flags: [
      { flag: '--id ID', description: 'task id whose slice tests are reviewed', required: true },
      { flag: '--run RUN', description: 'run the change belongs to', required: true },
      { flag: '--change PATH', description: 'change file (changes/ID/change.json) the slice belongs to', required: true },
      { flag: '--implementer ID', description: 'implementer worker id', required: true },
      { flag: '--producer ID', description: 'producer model id used for the assessment', required: true },
      { flag: '--provider-config PATH', description: 'provider configuration file (max 64 KiB)', required: true },
      { flag: '--credential-env NAME', description: 'environment variable holding the provider credential', required: true },
    ],
    example: 'tinysdd slice-tests assess --id validation --run run-1 --change changes/reservations/change.json --implementer coder --producer frontier/model --provider-config provider.json --credential-env PROVIDER_KEY',
  },
  {
    command: 'slice-tests check',
    group: 'Slice tests',
    summary: 'Run the task\'s approved slice checks independently for an assessment event.',
    usage: 'tinysdd [--json] [--project PATH] slice-tests check --id ID --event EVENT',
    flags: [
      { flag: '--id ID', description: 'task id whose slice tests are reviewed', required: true },
      { flag: '--event EVENT', description: 'event to check', required: true },
    ],
    example: 'tinysdd slice-tests check --id validation --event EVENT_ID',
  },
  {
    command: 'slice-tests review',
    group: 'Slice tests',
    summary: 'Record an attested strong review verdict for a slice-test check event.',
    usage: 'tinysdd [--json] [--project PATH] slice-tests review --id ID --event EVENT --input-digest SHA --reviewer ID --strength strong --attested true --verdict accepted|rejected --evidence PATH',
    flags: [
      { flag: '--id ID', description: 'task id whose slice tests are reviewed', required: true },
      { flag: '--event EVENT', description: 'event being reviewed', required: true },
      { flag: '--input-digest SHA', description: 'digest of the reviewed input', required: true },
      { flag: '--reviewer ID', description: 'reviewer id', required: true },
      { flag: '--strength strong', description: 'review strength', required: true },
      { flag: '--attested true', description: 'whether the review is attested', required: true },
      { flag: '--verdict accepted|rejected', description: 'review verdict', required: true },
      { flag: '--evidence PATH', description: 'path to the review evidence', required: true },
    ],
    example: 'tinysdd slice-tests review --id validation --event CHECK_EVENT_ID --input-digest SHA256 --reviewer frontier/model --strength strong --attested true --verdict accepted --evidence docs/reviews/validation-tests.md',
  },
  {
    command: 'phase record',
    group: 'Phases',
    summary: 'Record an approval for the research phase of a feature.',
    usage: 'tinysdd [--json] [--project PATH] phase record|research [--phase research] --feature NAME --proposal PATH --context PATH --by LABEL --reason TEXT [--predecessor ID] [--worker NAME]',
    flags: [
      { flag: '--phase research', description: 'phase being recorded, default: research' },
      { flag: '--feature NAME', description: 'feature the phase belongs to', required: true },
      { flag: '--proposal PATH', description: 'path to the research proposal', required: true },
      { flag: '--context PATH', description: 'path to the research context', required: true },
      { flag: '--by LABEL', description: 'operator label recording', required: true },
      { flag: '--reason TEXT', description: 'recording rationale', required: true },
      { flag: '--predecessor ID', description: 'record this one supersedes' },
      { flag: '--worker NAME', description: 'worker attributed with the phase work' },
    ],
    example: 'tinysdd phase record --phase research --feature reservations --proposal docs/research.md --context docs/context.md --by operator --reason "reviewed"',
  },
  {
    command: 'phase status',
    group: 'Phases',
    summary: 'Show the phase statuses of a feature.',
    usage: 'tinysdd [--json] [--project PATH] phase status --feature NAME [--worker NAME]',
    flags: [
      { flag: '--feature NAME', description: 'feature to show', required: true },
      { flag: '--worker NAME', description: 'worker attributed with the phase work' },
    ],
    example: 'tinysdd phase status --feature reservations',
  },
  {
    command: 'phase advance',
    group: 'Phases',
    summary: 'Advance a feature from one phase to the next (research to plan) with an approval.',
    usage: 'tinysdd [--json] [--project PATH] phase advance --from research --to plan --feature NAME --by LABEL --reason TEXT [--record ID] [--worker NAME]',
    flags: [
      { flag: '--from research', description: 'phase to advance from', required: true },
      { flag: '--to plan', description: 'phase to advance to', required: true },
      { flag: '--feature NAME', description: 'feature being advanced', required: true },
      { flag: '--by LABEL', description: 'operator label advancing', required: true },
      { flag: '--reason TEXT', description: 'advancement rationale', required: true },
      { flag: '--record ID', description: 'research record this advancement is based on' },
      { flag: '--worker NAME', description: 'worker attributed with the phase work' },
    ],
    example: 'tinysdd phase advance --from research --to plan --feature reservations --by operator --reason "plan approved"',
  },
];

const GROUPS = [
  { name: 'Setup', blurb: 'global install, profiles and project configuration' },
  { name: 'Tasks', blurb: 'the normal task flow' },
  { name: 'Worker', blurb: 'run and poll implementation workers' },
  { name: 'Bench', blurb: 'benchmark and qualification runs' },
  { name: 'Usage', blurb: 'feature reporting and token usage' },
  { name: 'Slice tests', blurb: 'slice-test assessment and review' },
  { name: 'Phases', blurb: 'research/plan phase policy' },
];

const FLOW = 'setup → init → task add → task approve → worker start → worker status → task apply → task review';

const NOTE = [
  'Usage phases: specify, research, plan, slice, write-tests, review, rescue.',
  'Retired (closed or superseded) tasks leave `next`, cannot be approved, reviewed or dispatched, and are refused while open tasks depend on them.',
  '`task update` keeps shape history and requires explicit reapproval after bound inputs change. Accepted tasks cannot be updated; `task supersede` still refuses a current acceptance and open dependents.',
  'Workers return isolated candidates and patches; they never apply or accept them. `task apply` copies a reviewed run\'s retained eligible actual files into the project and records the run; apply before `task review`, because acceptance binds the project\'s files.',
  'Use `worker start` for real model calls from an agent: it detaches the controller from short-lived interactive shells. Poll it with `worker status`. Stopping a launch with `worker stop` finalizes the run with outcome `stopped`, keeping its evidence and candidate.',
  'Use --json for machine-readable results, including failed worker evidence.',
  'Feature acceptance requires featureIntegration in .tinysdd/config.json; TinySDD executes that typed command through the host check runner before recording an event.',
  'Every command accepts --help (and `tinysdd help <command> [<sub>]`) for its own usage, flags and an example.',
];

function pad(text, width) {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export function topLevelHelp(version) {
  const lines = [`TinySDD ${version}`, '', 'Usage: tinysdd [--json] [--project PATH] <command> [<subcommand>] [flags]', ''];
  lines.push(`Normal flow: ${FLOW}`, '');
  const width = Math.max(...COMMANDS.map((entry) => entry.command.length));
  for (const group of GROUPS) {
    const entries = COMMANDS.filter((entry) => entry.group === group.name);
    if (entries.length === 0) continue;
    lines.push(`${group.name} (${group.blurb}):`);
    for (const entry of entries) lines.push(`  ${pad(entry.command, width)}  ${entry.summary}`);
    lines.push('');
  }
  lines.push(`Global flags: ${GLOBAL_FLAGS.map((flag) => flag.flag).join(', ')}.`);
  lines.push('');
  lines.push(...NOTE);
  return `${lines.join('\n')}\n`;
}

export function commandHelp(command, subcommand) {
  if (subcommand === 'research' && command === 'phase') subcommand = 'record';
  const entries = COMMANDS.filter((entry) => entry.command.split(' ')[0] === command);
  if (entries.length === 0) return undefined;
  if (subcommand === '') subcommand = undefined;
  if (subcommand !== undefined) {
    const entry = entries.find((candidate) => candidate.command === `${command} ${subcommand}`);
    return entry ? renderCommand(entry) : undefined;
  }
  if (entries.length === 1) return renderCommand(entries[0]);
  const lines = [`tinysdd ${command} <subcommand> [flags]`, ''];
  const width = Math.max(...entries.map((entry) => entry.command.split(' ').slice(1).join(' ').length));
  for (const entry of entries) {
    const sub = entry.command.split(' ').slice(1).join(' ');
    lines.push(`  ${pad(sub, width)}  ${entry.summary}`);
  }
  lines.push('', `Run \`tinysdd ${command} <subcommand> --help\` for one subcommand's flags and an example.`);
  return `${lines.join('\n')}\n`;
}

export function usageHintForArgs(args, version) {
  for (let end = args.length; end >= 2; end -= 1) {
    const text = commandHelp(args[0], args.slice(1, end).join(' '));
    if (text !== undefined && !text.startsWith(`tinysdd ${args[0]} <subcommand>`)) return text;
  }
  return commandHelp(args[0]) ?? topLevelHelp(version);
}

function renderCommand(entry) {
  const lines = [`Usage: ${entry.usage}`, '', entry.summary, ''];
  if (entry.flags.length > 0) {
    lines.push('Flags:');
    const width = Math.max(...entry.flags.map((flag) => flag.flag.length));
    for (const flag of entry.flags) {
      const required = flag.required ? ' (required)' : '';
      lines.push(`  ${pad(flag.flag, width)}  ${flag.description}${required}`);
    }
    lines.push('');
  }
  lines.push(entry.global ? 'Global flags: --json, --help, --version. This command is global and refuses --project.' : 'Global flags: --json, --project PATH, --help, --version.');
  lines.push('');
  lines.push(`Example: ${entry.example}`);
  return `${lines.join('\n')}\n`;
}

function levenshtein(a, b) {
  const rows = a.length + 1;
  const columns = b.length + 1;
  const distance = Array.from({ length: rows }, (_, row) => {
    const line = new Array(columns).fill(0);
    line[0] = row;
    return line;
  });
  for (let column = 1; column < columns; column += 1) distance[0][column] = column;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      distance[row][column] = Math.min(distance[row - 1][column] + 1, distance[row][column - 1] + 1, distance[row - 1][column - 1] + cost);
    }
  }
  return distance[rows - 1][columns - 1];
}

export function closestCommand(command) {
  let best;
  let bestDistance = Infinity;
  for (const entry of COMMANDS) {
    const distance = levenshtein(command, entry.command.split(' ')[0]);
    if (distance < bestDistance) {
      best = entry.command.split(' ')[0];
      bestDistance = distance;
    }
  }
  return best;
}

export function closestSubcommand(command, subcommand) {
  const entries = COMMANDS.filter((entry) => entry.command.split(' ')[0] === command);
  let best;
  let bestDistance = Infinity;
  for (const entry of entries) {
    const sub = entry.command.split(' ').slice(1).join(' ');
    const distance = levenshtein(subcommand, sub);
    if (distance < bestDistance) {
      best = entry.command;
      bestDistance = distance;
    }
  }
  return best;
}

export function unknownCommandHelp(command) {
  const closest = closestCommand(command);
  return `unknown command: ${command}. Did you mean \`${closest}\`?\n\n${commandHelp(closest)}`;
}

export function unknownSubcommandHelp(command, subcommand) {
  const closest = closestSubcommand(command, subcommand);
  const closestSub = closest.split(' ').slice(1).join(' ');
  return `unknown subcommand: ${command} ${subcommand}. Did you mean \`${closest}\`?\n\n${commandHelp(command, closestSub || undefined)}`;
}
