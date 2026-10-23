# Review workflow research

These are observations of actual public prompts/code fetched during implementation, not product capability guarantees. Links use mutable upstream branches, not pinned releases. No upstream implementation was copied into this package.

| Source | Observed method | Adopted here | Deliberately not adopted |
|---|---|---|---|
| [Anthropic code-review command](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/commands/code-review.md) | Parallel candidates, separate verification, deduplication, commit-line locations, opt-in publication | Candidate → counterevidence → verified finding; team tracks; precise locations | PR-only checks, assuming tools always work, excluding all narrow-trigger defects |
| [Official code-simplifier agent](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-simplifier/agents/code-simplifier.md) | Preserve behavior; scope to changed code; reduce nesting/redundancy without sacrificing clarity | Separate cleanliness track, explicit maintenance benefit, avoid over-abstraction | Autonomous editing; universalizing React/JS conventions |
| [Qodo reviewer prompts](https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/settings/pr_reviewer_prompts.toml) and [implementation](https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/tools/pr_reviewer.py) | Introduced defects, concrete triggers, untrusted input, structured locations, honest test status and partial coverage | Common finding fields; confidence/severity/coverage separation; bounded evidence | Treating schema validation as factual validation; automatic GitHub publication |
| [AI Scientist reviewer](https://github.com/SakanaAI/AI-Scientist/blob/main/ai_scientist/perform_review.py) | Originality/soundness/clarity; claims supported by theory or experiments; reproducibility; meta-review/reflection | Claim–evidence assessment; methods/experiments/writing tracks; actionable questions | Reject-when-unsure bias, binary decisions by default, averaged confidence as truth |

Important source discrepancy: Anthropic's fetched README describes numerical confidence thresholds and a history reviewer, while the fetched command uses high-confidence validation with different assignments. The command, not its marketing summary, informed this implementation.

## Synthesis

Scope and coverage → evidence collection → focused review → challenge candidates → deduplicate → structured report. Team coordination remains model-mediated through the existing team tool; this package does not implement its own agent runner. The scientific claim–evidence ledger is our synthesis, not a schema directly supplied by AI Scientist.

## Limits

The current collector does not validate scientific truth, execute tests, compile TeX, expand macros or assess figures. The reviewer must disclose those gaps. Prompt instructions reduce unwanted editing but are not a sandbox or a tool permission boundary.
