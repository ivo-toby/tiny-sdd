# Podcast checkpoint: Titan Qwen Q3 continuation

Date: 2026-09-05. Status: runtime usable; task02 still blocked after its two
additional invocations. Task01's earlier acceptance is retained; tasks03/04
remain unrun. No original project changes or global Pi configuration edits.

This continues the [earlier Q5 run](podcast-checkpoint-results-2026-09-05.md)
after the operator requested Titan's Qwen. Provider `titan`, exact model ID
`titan/llamacpp/qwen3.6-35b-a3b-256k`, Pi0.84.4. Q3 quantization is operator-reported;
the exact GGUF variant/digest is unknown. Direct routing has no fallback per
operator confirmation. Context262144 and max output16384 are configured values.

## Evidence and outcomes

The [continuation manifest](../experiments/runs/004-podcast-async-generation/qwen-titan-q3-aSyCOq/manifest.json)
records lineage, frozen inputs, new workspace, imported task01 acceptance,
task02's two-attempt allowance, and per-invocation runtime metadata. The old
run is retained. Titan started with a fresh Pi session over the prior candidate;
its second invocation continued that session. Neither is a clean-start feature
implementation. Worker tools were read/write/edit only; primary ran verification
separately with no credentials or external network.

Before Titan edits, the copied candidate passed build, 224 workspace tests and
10 independent job/factory checks. That was a baseline, not task02 acceptance:
the previous review had identified missing or inadequate tests.

| Invocation | Observed outcome | Duration | Tool starts |
| --- | --- | --- | --- |
| 1 | Output limit, no edits | 296.566s | 19 |
| 2, amended runtime | Test/evidence edits; final test suite fails to load | 92.255s | 3 |

Invocation1 emitted reasoning despite CLI thinking off. Installed Pi provider
code gates its thinking-toggle logic on model capability metadata. The configured
`reasoning:false` therefore did not send an explicit disabling flag. It was not
evidence that the server ignored such a flag.

A versioned, run-local profile used `reasoning:true` capability metadata and
`compat.thinkingFormat:"qwen-chat-template"`, while keeping CLI thinking off.
This makes Pi send `chat_template_kwargs.enable_thinking:false`; a no-network
payload-construction probe confirmed that field. No global configuration was
changed. The [runtime amendment](../experiments/runs/004-podcast-async-generation/qwen-titan-q3-aSyCOq/runtime-disable-thinking.md)
links the local adapter evidence and official documentation. Explicit template
control is documented by the [Qwen model card](https://huggingface.co/Qwen/Qwen3.6-35B-A3B#instruct-or-non-thinking-mode).
Invocation2 showed no thinking stream and produced edits. The prompt also
changed, so this is outcome-informed troubleshooting, not a controlled ablation.

Final primary verification: build passed, 208 workspace tests passed, and all
10 independent checks passed. However, the revised factory suite could not load
because it imported `inmemory.js` instead of `inMemory.js`. Overall verification
failed; the new tests did not execute. Source review also found a purported
>10MB fixture of only 5790891 bytes, ineffective structuredContent assertions,
incomplete cleanup, and unspecified listener interfaces. See the
[final review](../experiments/runs/004-podcast-async-generation/qwen-titan-q3-aSyCOq/review-02-inv2.md)
and [verification result](../experiments/runs/004-podcast-async-generation/qwen-titan-q3-aSyCOq/review-02-inv2/result.json).

## What this changes

Titan is a usable participant endpoint. Runtime profiles need request-level
qualification: a model's advertised capability and the effective request are
different things. Test quality remains a substantive part of the SDD work, not
something a green production build or participant self-review establishes.

This continuation does not measure Q3 against Q5 fairly, establish a general
model weakness, or demonstrate reliable completion of the feature. It inherited
Q5 code and review history, changed context at transfer, and amended runtime and
feedback after observing an output-limit failure. Preparation, review and
runtime diagnosis effort must not be omitted when evaluating workflow value.

Both additional task02 invocations are spent. Do not borrow task03's budget,
silently repair participant code, or apply the incomplete feature. A further
authorized experiment should split the test repair into smaller obligations
with exact SDK context and controller verification between edits. Keep these
results and frozen inputs unchanged when preparing that successor.

Final read-only audit: all 35 original project files represented in the run
baseline match their hashes (32 tracked files and the three pre-existing
untracked input documents). Git reports no tracked modifications; ten other
tracked files have no run-baseline hash for comparison. The only original
untracked paths remain those three documents. Luna-max collected the snapshot
and original-file audit; primary owns the verdict and interpretation.
