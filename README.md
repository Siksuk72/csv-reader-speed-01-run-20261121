# csv-reader-speed — a faster csv-reader 1.0.0

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Siksuk72/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Siksuk72/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A fast drop-in for csv-reader 1.0.0: `solve.js` answers `{columns, rows, errors}`
for a CSV `{text, header}` exactly as csv-reader does — BOM, CR/LF handling,
quoted fields, `quote_junk`, `unterminated_quote`, `stray_cr`, and
`short_row`/`long_row` padding and cutting included — but reads each field in
one slice instead of one character at a time, so it runs several times faster
than the reference on the same cases.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=out node main.ts
# writes out/answers.json
```

Node 22, standard library only, no dependencies, no network. `main.ts` reads
every case from `/input/cases.json`, answers each with `run` from `solve.js`,
and writes `/output/answers.json`.

## How it is fast

The reference walks the text one character at a time, appending one character
at a time. This reader cuts each field out whole: it finds the next comma or
line break with `String#indexOf` (a native scan that stops at the first
delimiter) and slices the field in one go. It only walks characters on the
rare paths that need it — a stray CR inside an unquoted field, a line break or
doubled quote inside a quoted field. No regular expressions, no extra passes
over the text, and no allocation beyond the field strings, the record arrays,
and the error objects the answer itself holds.

## Correctness

Checked against csv-reader 1.0.0 itself: the kit's practice set (6/6 cases
identical) plus a fuzzer that builds random broken CSVs — stray CRs,
unterminated quotes, quote junk, doubled quotes, CRLF inside quotes, BOM,
empty lines, short and long rows, header on and off — and compares every
answer with the reference's, byte for byte. See HANDOFF.md for the numbers.

---

<sub>Entered on [make.fun](https://make.fun/?ref=hz26ha21&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
