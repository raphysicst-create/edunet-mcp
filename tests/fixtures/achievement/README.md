# Achievement parser fixtures

`synthetic-*` are authored structural fixtures, **not official curriculum text**. Regenerate with `node tests/fixtures/achievement/generate.mjs` (HWPX archive dates can change). PDF fixtures have Unicode text and drawn table grids; the HWP fixture has an explicit three-row merged cell. Generated PDF fonts are extraction fixtures, not a visual rendering reference.

`public/hwpjs-basics-report.hwp` is the public layout fixture from [hwp.js](https://github.com/hahnlee/hwp.js/blob/main/packages/parser/src/__tests__/data/basicsReport.hwp), downloaded 2026-09-18, under the project's Apache-2.0 license (`public/HWPJS-LICENSE`). It is an ordinary report layout, not an achievement document.

`public/kordoc-simple-form.hwpx` is `templates/간이기안문_서식.hwpx` from the installed, locked `kordoc@4.14.0` distribution ([upstream template](https://github.com/chrisryugj/kordoc/blob/main/templates/%EA%B0%84%EC%9D%B4%EA%B8%B0%EC%95%88%EB%AC%B8_%EC%84%9C%EC%8B%9D.hwpx)), under MIT (`public/KORDOC-LICENSE`). It verifies actual HWPX layout parsing, not educational semantics.

The test suite covers row/column PDF tables, multiple-page repeated headers, simple/merged HWP, experimental HWPX, descriptive/custom labels, absent codes, exact field evidence, ambiguous context, unrecognized tables, no-text PDF, corrupt files, and decompression limits. HWP/HWPX cell page numbers are omitted because the parser supplies table-start pages rather than exact per-cell pages; table/row/column positions remain available.

`node evals/achievement.mjs` computes field precision/recall/F1, code accuracy, label fidelity, evidence attachment, unsupported inference, per-format parse success and local parse/extract p95. Description and standard-text comparison ignores whitespace because PDF text lines can split words; evidence quotes and raw labels remain exact. Expected values are separately authored in `evals/achievement-golden.jsonl`. The JSON report includes expected and actual records side by side at `evals/results/achievement-latest.json`.

No fixture has received human educational-domain review. HWPX stays disabled by default; these tests do not satisfy the blueprint's real educational-document review, live discovery recall, or production release gates.
