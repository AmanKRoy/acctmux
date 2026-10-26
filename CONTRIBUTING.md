# Contributing

Thanks for looking. A small, focused change with a test is the easiest to review.

## Run the tests

```
npm ci
npm run lint
npm test
```

Use `npm test`, not `node --test tests/`: the second form fails on Node 24. The suite runs the router against a fake stdio upstream (`tests/fake-upstream.mjs`), needs no account and takes about a minute. Node 22 or newer.

`tests/e2e.py` is a live end-to-end script for a running router with real accounts. It is not part of CI and you do not need it for a pull request.

## Rules

- **One commit per change.** A change is one behaviour, fix or doc update, with its test and the docs it affects (README, `docs/CONFIG.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md`). Do not mix a refactor with a fix.
- **A test that fails without the change.** Fix a bug by first writing the test that shows it. Run it against the old code to see it fail.
- **Lint and tests pass before you push**, on both. CI also runs Node 22 and 24, the newest published MCP SDK, and macOS.
- Keep the code in the style of the surrounding file. Comments say why, not what.
- Do not commit tokens, keys or real account names. Test configs use the fake upstream.

## Layout

`router.mjs` is the entry point; the code is in `lib/` (see "Code layout" in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)). `lib/pool.mjs` and `lib/accounts.mjs` import without a server and have direct unit tests in `tests/pool.test.mjs`.

## Reporting a security problem

Do not open a public issue. Use GitHub's private vulnerability reporting on the repository, or contact the maintainer directly.
