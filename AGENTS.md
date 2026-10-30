# AGENTS.md

Vibecheck is a GNOME Shell extension that shows the remaining Claude
subscription capacity: the five-hour window, weekly limits, model-scoped limits
discovered at runtime, and what contributed to usage on this machine.

## Workflow

- Work and commit on `master`, the only branch.
- Use `pnpm`. Run `pnpm build` before every commit; CI runs the rest.
- Releases are cut by the manual Release workflow, which bumps the version and
  moves the `Unreleased` changelog section under it. Add user-visible changes
  to `CHANGELOG.md` under `Unreleased`.

## GNOME support

- Target only maintained GNOME Shell releases (the current stable and the one
  before it). When a new release ships, drop the oldest: update `metadata.json`
  and the `tests/shell/Dockerfile.gnome*` containers together.
- No version checks or compatibility shims for unmaintained releases.

## Code layout

- `src/domain/`: pure types, normalization, and formatting. No GNOME imports;
  runs under Node and is covered by unit tests.
- `src/services/`: credentials, Claude Code authentication, the Claude Code
  `/usage` runner, and the HTTP adapter. Usage comes from
  `claude-cli-usage.ts` by default; direct requests are the opt-in and the
  fallback without Claude Code. The usage endpoint is undocumented: keep it
  isolated in `claude-usage-client.ts` and treat every response and all CLI
  output as untrusted.
- `src/ui/`: Shell actors and menus. `extension.ts` is lifecycle only;
  `prefs.ts` must not import Shell, St, or Clutter.
- Discover model-scoped limits dynamically; never hard-code model names.
- New response shapes get a fixture and a parser test.
- User-facing percentages are remaining capacity by default; the `show-used`
  setting switches every one of them to consumed. Thresholds stay on remaining.
- Wrap user-facing strings in gettext and update `po/vibecheck.pot` and every
  `po/*.po` catalog.

## GNOME Shell rules

- Clean up every signal, timeout, and actor in `disable()` or `destroy()`.
- No synchronous network or file I/O on the Shell main loop.
- Use public API only; never touch underscore-prefixed Shell fields.
- Keep the desktop card inside the wallpaper's `Meta.BackgroundGroup`. As a
  sibling in `global.window_group` it floats above application windows.

## Credentials and security

- Never log, persist, commit, or use in fixtures a real token, email address,
  or organization identifier.
- Authentication and session renewal belong to the Claude Code CLI. Do not
  implement the OAuth token protocol or scrape browser cookies.
- Run the CLI's `/usage` with `--setting-sources ''` and
  `--no-session-persistence`, so the user's hooks stay idle and the run is not
  counted in its own report.
- The refresh token stays in memory and reaches the CLI only through the child
  environment, never argv, GSettings, logs, or files.
- An expired access token is not an expired session: ask the user to sign in
  only when the refresh token is missing, expired, or rejected. Renew at most
  once per request cycle and back off after a failure.
