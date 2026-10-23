# Acceptance record — 0.2

## Offline

`node --test packages/magic-review/tests/*.test.mjs`: **80 tests passed, 0 failed**.

Coverage includes collection, ranges/context, persistence and cross-process locking, ownership races, independent verification and semantic duplicate references, cancellation uncertainty, bounded evidence packing, UI component rendering/navigation, input routing, extension prepare→run integration, safe image loading and mocked DOI lookup, sandbox capability/denial paths.

Runtime discovery was checked through an actual Pi RPC process, not only mocked registration: `/magic-review` and both skill commands were found without extension startup errors.

## Real model and background team

Command:

```bash
python packages/magic-review/scripts/acceptance.py --live --team
```

Local evidence:

`.local/magic-review-acceptance/f8d9a42d-860f-4080-a5e2-e342823515a4/results.json`

| Scenario | Managed invocations | Outcome |
|---|---:|---|
| Local commit: addition deliberately changed to subtraction | 2 | completed; 1 confirmed finding |
| TeX fixture: unsupported universal claim and false algebra identity | 2 | completed; 4 confirmed findings |
| Actual `team run backend=background` integration | 4 | completed; exposed duplicate root-cause findings |

The initial team run returned three versions of the same bug. This was not considered satisfactory deduplication even though the execution completed. The verifier schema was extended with `duplicate` + validated `duplicateOf`, requiring a confirmed canonical finding.

Rerun:

```bash
python packages/magic-review/scripts/acceptance.py --live --scenario team
```

Evidence:

`.local/magic-review-acceptance/d7492914-26e7-490a-98ea-7d41c4eba0f2/results.json`

Outcome: **completed, 4 managed invocations, 1 confirmed canonical finding**. Full run:

`.local/magic-review-acceptance/d7492914-26e7-490a-98ea-7d41c4eba0f2/team/.local/magic-review/01c5b022-7ba8-49a1-a7ff-48a81cd38f84/run.json`

The acceptance uses the configured real Pi model and incurs tokens. Fixtures are temporary test projects retained under `.local`, not changes to user source. JSONL event logs, stderr, evidence and reports are retained for inspection. These small deliberately flawed fixtures establish an execution path, not broad review-quality calibration.

## Explicitly not established

- Bubblewrap, pdflatex/latexmk and pdftotext are absent on this host. Sandbox execution fails closed; real isolated TeX compilation and PDF conversion were not tested. PDF/SVG/EPS rendering is not implemented.
- UI component tests do not replace manual verification across terminal sizes, terminal emulators and all Pi configurations.
- Image hash/confinement and DOI handling were tested offline. No real Crossref requests were sent; no real multimodal figure-review quality assessment was performed.
- Automated team coordination uses the existing background backend. No Herdr-pane lifecycle changes or pane acceptance test was performed.
- Token reservations are estimates. The external team backend lacks an API for a hard per-worker turn/output-token cap; its managed invocation/deadline limits and actual usage accounting must not be presented as a hard remote spending ceiling.
- Independent model requests and schema gates do not prove findings correct or mathematically validate a paper.
