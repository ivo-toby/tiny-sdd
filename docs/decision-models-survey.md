# Decision-model survey

Accessed: 2026-10-03

## Purpose

This survey supports issue [#6](https://github.com/ivo-toby/tiny-sdd/issues/6):
find cheap decision providers that can reduce frontier-model work without
changing operator ownership of approval. It covers the five decision points in
the [worker-runtime decision-model section](https://github.com/ivo-toby/tiny-sdd/blob/main/docs/worker-runtime-next.md#5-decision-models-jev-laya-and-others): failure triage, research relevance, review triage, spec coverage, and slice routing.

The comparison is a screening result, not a qualification result. The
deterministic baseline remains authoritative; every model below needs a
shadow-mode evaluation against retained labels before it can influence flow.

## Candidates

The table records the published contract and claims. “Unknown” means that the
primary sources reviewed here do not provide the fact; it is not an estimate.
Latency figures marked “vendor/author” are not TinySDD measurements.

| Model / provider | Question types | Licence | Runs locally? (Apple Silicon?) | Size and memory | Reported latency | Calibration claims | Fine-tuning path | Known failure modes / limits | Sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Jev / TypeSafe AI** | `choice`, `score`, and `noul` (yes-probability); no free-text generation. | Hosted early-access service. Public weight licence: **unknown**. | Hosted API; no public local weights are documented in the cited vendor sources. Apple Silicon: no. | Size and local memory: unknown. | Vendor says “100ms speeds” and says published evaluations were run from laptops on the US West Coast; exact p50/p95 for TinySDD: unknown. | Vendor claim: typed probabilistic outputs include calibrated probabilities and confidence. This is a claim to test, not an acceptance guarantee. | Public fine-tuning path: unknown. | The TinySDD POC detected missing evidence but not semantically false evidence. The fixed typed question space also means the caller must design the decision boundary; Jev is not a prose reviewer. | [TypeSafe launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev); [TypeSafe integration node](https://github.com/typesafe-ai/n8n-nodes-typesafe-ai); [TinySDD Jev decision](https://github.com/ivo-toby/tiny-sdd/blob/main/docs/jev-architecture-decision.md) |
| **Laya / ConvAI Innovations** (`convaiinnovations/laya`; `laya-typed-decisions`) | `choice`, `score`, and `noul`; one forward pass; no text generation. | Apache-2.0. | Yes. Upstream provides local Python/PyTorch inference and an Apple-Silicon MPS/CPU fine-tuning path. Exact TinySDD inference setup on Apple Silicon still needs measurement. | English checkpoint: 421M parameters and 512-token default context. Runtime memory depends on backend and precision. | Author report in the upstream README: 33 ms for one question and 7.2 ms/question when batched on a T4. | Upstream benchmark claim: the base checkpoint is over-confident; held-out temperature fitting reduced mean ECE from 0.466 to 0.081. | Official RLCD path uses domain-labelled decisions, calibration temperatures, and a held-out set; upstream supplies a 2xT4 notebook and an Apple-Silicon script. | The English base is weak zero-shot on the typed-decisions benchmark (0.362 accuracy versus a 0.461 majority baseline). Reported limits include English-only coverage, degradation with large choice sets, and a documented risk that `noul` follows `true`/`false` labels rather than state. | [Upstream repository](https://github.com/NandhaKishorM/laya); [English model card](https://huggingface.co/convaiinnovations/laya); [upstream benchmarks](https://github.com/NandhaKishorM/laya/blob/main/BENCHMARKS.md); [upstream issue #156](https://github.com/NandhaKishorM/laya/issues/156) |
| **Prometheus 2** (`prometheus-eval/prometheus-7b-v2.0`) | Absolute assessment: generated feedback plus an integer 1–5 score. Relative assessment: pairwise ranking. No native `noul` probability contract. | Apache-2.0 for the model; the model card notes that its generated-data collections are subject to OpenAI Terms of Use. | Yes through the published Transformer/runtime path. Apple Silicon: unknown in the cited project sources. | 7B checkpoint; an 8x7B variant is also published. Exact runtime memory: unknown. | Unknown in the cited primary sources. | Author/paper claim: strong correlation and agreement with human and proprietary-model judges on direct-assessment and pairwise benchmarks. No calibrated-probability contract is claimed. | The published model was fine-tuned on Feedback Collection and Preference Collection data; the repository publishes wrappers and data. A TinySDD-specific fine-tune recipe: unknown. | It requires an instruction, candidate response, score rubric, and reference answer for absolute grading. It emits generated feedback and a score marker, so parsing, rubric sensitivity, and probability calibration are evaluation risks. | [Prometheus 2 model card](https://huggingface.co/prometheus-eval/prometheus-7b-v2.0); [Prometheus 2 paper](https://arxiv.org/abs/2405.01535); [official repository](https://github.com/prometheus-eval/prometheus-eval) |
| **ArmoRM-Llama3-8B-v0.1** | Continuous multi-objective reward values and an aggregated preference score for a prompt/response pair. No native `choice` or `noul` output. | Llama 3 licence, not Apache-2.0. | Yes through Transformers with custom model code. Apple Silicon: unknown in the cited model sources. | 8B; the Hugging Face repository is about 15 GB. Quantized/runtime memory: unknown. | Unknown in the cited primary sources. | The authors report RewardBench performance and interpretable reward dimensions; no calibrated-probability claim is made. | The paper and repository publish the reward-modeling code and a model fine-tuned from an 8B Llama reward model. A TinySDD-specific fine-tune path: unknown. | The model card calls out a transform intended to reduce verbosity bias. Its scalar reward is not directly comparable to a yes-probability or a typed choice without a separately calibrated mapping. | [ArmoRM model card](https://huggingface.co/RLHFlow/ArmoRM-Llama3-8B-v0.1); [ArmoRM paper](https://arxiv.org/abs/2406.12845); [training repository](https://github.com/RLHFlow/RLHF-Reward-Modeling) |
| **Local LLM as judge**: the qualified worker model, represented by **Qwen3.8-27B** or **Gemma 4 26B A4B** | Free-text generation can be prompted into a choice, score, or yes/no answer. Neither is presented in the cited sources as a typed, calibrated decision API. | Qwen3.8-27B: Apache-2.0 in the release repository. Gemma 4: Apache-2.0 in the model card. Check the exact checkpoint before redistribution. | Yes. Qwen documents local Transformers serving and lists an Apple-Silicon MLX route for its Qwen open-model series; exact Qwen3.8 Apple support is unverified. Google targets Gemma 4 for laptops and consumer GPUs. Exact TinySDD runner and Apple memory need measurement. | Qwen3.8-27B: 27B dense. Gemma 4 26B A4B: 25.2B total and 3.8B active parameters. Quantized memory and resident footprint: unknown. | Unknown; depends on checkpoint, quantization, context, backend, and hardware. | No native calibration claim for judging was found. Any probability obtained from a generated answer or token likelihood must be calibrated on held-out TinySDD labels. | Qwen documents SFT, DPO, and GRPO through external training frameworks; Gemma documents fine-tuning through its supported training stack. Dataset and held-out calibration design remain TinySDD work. | Generation creates format/parsing and prompt-sensitivity risks, and judge bias must be measured. These are evaluation risks for this candidate class, not claims that either vendor has measured them on TinySDD. | [Qwen3.8 repository](https://github.com/QwenLM/Qwen3.8); [Qwen3.8-27B release repository](https://github.com/AlibabaCloud-Official/Qwen3.8-27B); [Qwen3.8-27B model card](https://huggingface.co/Qwen/Qwen3.8-27B); [Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4) |

## Fit per decision point

This is a proposed fit assessment for the TinySDD workflow, not a vendor
ranking. “Strong” means the published output shape is close to the decision;
“conditional” means a local adapter, rubric, calibration, or domain training
is required; “weak” means the candidate’s native output is a poor match.

| Candidate | Failure triage | Research relevance | Review triage | Spec coverage | Slice routing |
| --- | --- | --- | --- | --- | --- |
| Deterministic checks, IDs, and sizing rules | **Strong** for known error codes, check outcomes, traceability, and mechanical size signals | **Conditional**: symbol/grep rules cover obvious cases, not semantic relevance | **Strong** for green checks, scope, and exact state | **Strong** for requirement/criterion/check IDs | **Conditional**: current sizing signals identify some behavior-split risk, not all model difficulty |
| Jev | **Conditional**: `choice` can classify a bounded check log, but the POC does not establish semantic-false-evidence detection | **Conditional**: `score` can rank prepared chunks; state and question design must stay small and literal | **Conditional**: `noul` matches the gate, but false-accept behavior must be measured | **Strong on shape**: one `noul` per requirement is a direct mapping; correctness still needs labels | **Strong on shape**: `choice` can route a packet to split/continue/stronger review after calibration |
| Laya | **Conditional**: best after task-specific fine-tuning on TinySDD labels | **Conditional**: local `score`/`choice` is attractive after tuning; base zero-shot evidence is insufficient | **Conditional**: native `noul` fits, but over-confidence and label-following need controls | **Strong on shape**, conditional on held-out calibration | **Strong on shape**, conditional on behavior-split training data |
| Prometheus 2 | **Strong candidate** for rubric-based “can this log explain the failure?” review and pairwise ranking | **Strong candidate** for ranking candidate chunks with a reference/rubric | **Conditional**: direct assessment is useful, but it returns a score/critique rather than a calibrated yes-probability | **Conditional**: can judge a rubric, but lacks a native per-requirement probability | **Conditional**: can compare packet alternatives, with more prompt and parsing overhead |
| ArmoRM-Llama3-8B | **Weak initially**: scalar reward is not a failure class | **Weak initially**: reward score is not evidence relevance without a new calibration layer | **Weak initially**: no native yes-probability or abstention semantics | **Weak initially**: scalar reward does not expose requirement coverage | **Conditional** only if a labelled reward/routing task is built |
| Local LLM judge | **Strong reference** for open-ended failure explanations and the currently qualified worker baseline | **Strong reference** for semantic relevance, at higher latency and token cost | **Conditional**: flexible rubric judge, but generated output must be parsed and calibrated | **Conditional**: can reason over requirement/criterion pairs, but is not deterministic | **Conditional**: can make the routing decision, but routing it with the same worker model risks correlated errors |

The deterministic row is deliberately retained in every column. A decision model
must beat the corresponding deterministic baseline on held-out labels before it
is allowed to filter frontier work.

## Recommendation for evaluation (#32)

Enter these four candidates in the first evaluation:

1. **Jev**, as the hosted typed-decision reference and the only candidate with an
   existing TinySDD POC. Include the operator’s evidence-sufficiency case, but
   do not treat that POC as qualification.
2. **Laya**, evaluating both the English base and `laya-typed-decisions` where
   possible. This separates the local typed-model promise from the benefit of
   domain/task fine-tuning and calibration.
3. **Prometheus 2 7B**, for rubric-based direct assessment and pairwise review
   triage. Add an adapter that records the score and critique, then measure
   whether a calibrated mapping can support TinySDD thresholds.
4. **The qualified local LLM**, using the exact worker checkpoint and runtime
   already used in the TinySDD benchmark. This is the relevant cost/quality
   baseline for “use the worker as judge” and avoids assuming a specialised
   model wins before measurement.

Defer **ArmoRM** from the first panel. It is a credible reward-model control,
but its native scalar reward, larger local footprint, Llama licence, and lack of
an explicit calibrated-decision interface make it a second-stage experiment
rather than a first candidate for all five decision points. Keep it if #32 adds
a reward-specific question or a preference-ranking arm.

The evaluation should compare every candidate with the deterministic baseline,
use the same retained run labels, and report false-accept rate at the intended
operating threshold, abstention/coverage, calibration (Brier score and ECE),
latency, and frontier tokens avoided. Run shadow-only first; the operator still
owns review and acceptance, and worker-observed output is not acceptance
evidence. This preserves the [existing TinySDD Jev boundary](https://github.com/ivo-toby/tiny-sdd/blob/main/docs/jev-architecture-decision.md#deterministic--semantic--generative-boundary).
