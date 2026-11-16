# culture-design

The design layer of the associate web UI, cited through qodo-cli's
`web/src/culture-design/` (commit `ee73d5682a02952a76567887995b4f2e3aca5ea2`), which
cited culture-rules' `web/src/culture-design/` (commit
`b7f861f690b57c4355f81371cc02ad1dd2ae9cac`).

## Contents

- `tokens.css` is agentculture/org `site-astro/src/styles/global.css`, copied
  **verbatim** below a provenance header that records the culture-rules commit it
  was cited from, the org commit it pins and the source's sha256. Do not hand-edit
  the copied section. Imported once, globally, from `src/main.tsx`.

The design canvas's tokens (background `#f4f5fb`, surface `#ffffff`, ink `#232a4d`,
soft ink `#4d546f`, accent `#0b655c`, filled accent `#0c5a53`) are exactly the
light-theme values of this file, and the associate artboards (Runs, One run) sit on
the same canvas in the same tokens, so nothing is adapted. associate-specific rules
live in `src/styles/app.css`.

## Verification

```bash
npm run check:tokens    # tokens.css byte identity (scripts/check-tokens.mjs)
```

It always checks the copied body against the recorded sha256. With
`ASSOCIATE_DESIGN_SOURCE_REPO` set to a culture-rules checkout it also reads that
file at the recorded commit with `git show` and asserts byte equality.

## Re-pin

1. Take the new culture-rules commit; re-copy the body of its `tokens.css` below the
   header, unchanged.
2. Update the header's `Commit:` and, if the org pin moved, the `Source sha256:` lines.
3. Run `npm run check:tokens`.
