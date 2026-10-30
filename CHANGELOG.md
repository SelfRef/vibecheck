# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Vibecheck now asks you to sign in when the Claude session has expired.
  Claude Code still reports itself signed in after its renewal fails, so
  Vibecheck used to keep saying it could not report usage.

## [1.2.1] - 2026-10-30

### Fixed

- Automatic session start now also works while the screen is locked. GNOME
  used to disable Vibecheck on the lock screen, so no window started until
  the next unlock. The panel indicator and the desktop card stay hidden there.
- A limit that has not started yet, such as the session between two windows,
  now says it starts with your next request instead of "reset unavailable".

## [1.2.0] - 2026-10-29

### Added

- A preferences switch to show used capacity, as Claude does, instead of
  remaining capacity in the top bar, the menu, and the desktop card. Remaining
  stays the default, and the warning thresholds still apply to what remains.
- Automatic session start, off by default: when no five-hour window is
  running, Vibecheck sends one short prompt through Claude Code with a
  selectable model (Haiku by default) so the next window starts counting right
  away. A switch in the panel indicator's right-click menu turns it on or off
  and can be hidden.

### Changed

- Refresh now and Preferences moved from the panel indicator's menu to its
  right-click menu, so a click shows usage only. The Menu key and Shift+F10
  open it from the keyboard.

## [1.1.2] - 2026-10-25

### Added

- An About page in the preferences with the author, the source code, issue
  reporting, the license, credits, and links to support development.

## [1.1.1] - 2026-10-22

### Changed

- A Vibecheck logo, half asterisk and half meter, replaces the Claude icon in
  the top bar. The color icon is now the same shape in Claude orange.
- The symbolic top bar icon is now called mono. A saved `symbolic` setting
  falls back to the default color icon.

### Fixed

- The top bar icon sits closer to the percentages.

## [1.1.0] - 2026-10-22

### Added

- Choose the top bar area (left, center, or right) and the position within
  it. The indicator keeps its position when other icons appear later, so 0
  keeps it before tray and other extension icons.
- Brazilian Portuguese, French, German, Polish, and Spanish translations.

## [1.0.0] - 2026-10-18

### Added

- GNOME Shell 51 support and a Fedora 45 verification container.
- Choose up to two remaining percentages for the top bar, shown as `n%/m%`:
  current session, weekly for all models, or the lowest remaining of all
  limits. Defaults to session and weekly.
- The top bar shows the Claude icon in color (default), symbolic so it follows
  the panel color, or not at all.
- The top bar shows the time until the current session resets, the weekly
  limit resets, or both, as `n%/m% · 2h 10m/3d 4h`. Session by default.
- The desktop card shows a meter and reset time for each limit, like the menu.
- Right-click the desktop card to refresh or open the preferences.
- What contributed to usage on this machine over the last day and week, from
  Claude Code's `/usage` report: request and session counts, behaviors such as
  long context or subagent-heavy sessions, and top subagents and MCP servers.
  Refreshed with every poll through Claude Code, otherwise at most every 15
  minutes.

### Changed

- Usage is read through Claude Code's `/usage` command whenever Claude Code is
  installed, so Claude Code handles the session and the usage endpoint. A
  "Request usage directly" setting restores direct requests, which are also
  used without Claude Code.
- The Claude account preferences are now Data source: they show whether
  Claude Code is installed and signed in, and offer sign-in only when it is
  needed.
- The project is renamed to Vibecheck, with the extension UUID
  `vibecheck@selfref.dev` and settings schema
  `org.gnome.shell.extensions.vibecheck`. Settings from Claudeland do not carry
  over.
- Only maintained GNOME Shell releases are supported: 50 and 51.
- Refresh now closes the menu like every other menu item.
- The desktop card is shown by default.

### Fixed

- Changing a display setting redraws the cached usage instead of requesting it
  again, so adjusting preferences no longer runs into the rate limit.
- The "updated" time follows the GNOME 12h/24h clock setting.
- Extra usage is hidden while it is switched off, instead of showing as 100%
  remaining, and the weekly limit no longer appears twice.
- The Sign in button in Preferences reports a missing Claude Code or terminal
  instead of doing nothing.
- Menu text and the progress track follow the Shell style instead of assuming
  a dark menu.
- Limits are read from the window and scope Claude reports, so a model limit
  on the session window or a surface limit such as Cowork gets its own row
  instead of being labelled weekly or dropped.
- Team Premium seats are labelled "Team Premium" instead of "Max (5x)".
- Polling no longer stops for good when `claude auth status` hangs; the check
  now gives up after 15 seconds.

### Removed

- The compact panel switch, replaced by the panel value choices.
- The source code link in Preferences; the Extensions app already links to it.

## [0.3.1] - 2026-09-28

### Changed

- Limit the extensions.gnome.org package to GNOME Shell 45 through 50, keeping
  the submitted JavaScript modular and removing the legacy transpilation path.
- Use libsoup 3 directly and remove the unused libsoup 2.4 transport fallback.
- Import libsoup without a version query, as the extensions.gnome.org review
  asks for. GNOME Shell has already loaded libsoup 3 into its own process.

### Removed

- The rejected GNOME Shell 42 through 44 package, its build shims, compatibility
  UI fallbacks, and legacy container definitions.

## [0.3.0] - 2026-09-03

### Added

- Support for GNOME Shell 42, 43 and 44. Those releases predate the ES module
  extension API introduced in Shell 45, so the build now produces a second
  package from the same sources, bundled as legacy scripts. `pnpm dev:install`
  installs whichever package matches the running Shell, and `pnpm package`
  produces both archives.
- Compatibility metadata for GNOME Shell 45, 47, 48 and 49, completing the
  supported range from 42 to 50.
- Container definitions and verification runs for every newly declared release,
  so all nine are exercised against a real headless Shell.
- A blank line between functions and classes in the packaged JavaScript, as the
  extensions.gnome.org review asks for. The TypeScript sources already complied;
  the emitters dropped those lines, and `scripts/format-output.mjs` restores
  them in both packages.
- A libsoup 2.4 fallback for the usage request. Ubuntu 22.04, which carries
  GNOME Shell 42, installs no libsoup 3 introspection data by default.
- A libadwaita fallback for the preferences rows, which are built from an
  `Adw.ActionRow` and a `Gtk` control on libadwaita older than 1.4.

### Changed

- Documentation no longer describes Vibecheck as Ubuntu- or Wayland-specific.
  It runs on any distribution shipping a supported GNOME Shell, under X11 and
  Wayland alike.

## [0.2.0] - 2026-08-30

### Added

- Automatic session renewal. When the Claude access token has expired, or an
  authenticated request is rejected, Vibecheck asks the Claude Code CLI to
  renew the session non-interactively and retries once. Sign-in is requested
  only when the refresh token is missing, expired, or rejected.
- GNOME Shell 50 compatibility metadata, type validation, and runtime smoke
  testing while retaining GNOME Shell 46 support. Both releases are now
  verified automatically with `pnpm verify:shell`, which starts a real headless
  GNOME Shell in a container, activates the extension, opens its preferences
  dialog, and renders every panel and card state.
- A GJS harness for credential reading and session renewal, covering what the
  Node tests cannot reach: `Gio` file access and the subprocess handover to the
  Claude Code CLI.
- Submission notes for extensions.gnome.org documenting every subprocess the
  extension launches and why.

### Changed

- Consult the Claude Code CLI only when the credential file is unusable or a
  renewal is required, so ordinary polling no longer spawns a subprocess.
- Place the desktop card through public shell API instead of `LayoutManager`'s
  private background group. The card keeps its position above the wallpaper and
  below application windows: it is parented into the wallpaper's own group,
  because a sibling of the window actors is restacked above them by mutter as
  soon as a window appears. The stacking is asserted against a window opened
  after the card on every supported GNOME Shell release.
- Align lifecycle, signal cleanup, imports, and actor orientation with current
  GNOME Extensions review guidance.
- Apply consistent source formatting with Prettier and verify it in `pnpm check`.
- Prepare a minimal extensions.gnome.org package without unnecessary compiled
  schemas or unreachable JavaScript, verify release-version consistency, and
  generate its SHA-256 checksum automatically.
- Expand extension metadata with Claude Code, OAuth credential, Anthropic
  endpoint, and unofficial-project disclosures.

### Fixed

- Stop demanding a browser sign-in after the access token expires. An eight-hour
  access token expiring overnight left the panel asking for a login even though
  the session remained renewable for weeks.
- Apply warning and critical colors to percentage text without painting its
  background, while preserving the matching progress-bar colors.
- Keep bottom-positioned desktop cards inside the monitor after their content
  changes height.

## [0.1.0] - 2026-08-28

### Added

- Initial GNOME Shell extension architecture.
- Claude Code authentication integration.
- Five-hour, weekly, and dynamic model-scoped limit display.
- Optional non-interactive desktop card.
- System-locale support through gettext with English fallback and Italian
  translations.
- Claude plan tier in the usage header, including Max 5x/20x detection.

### Fixed

- Keep the usage popup open when selecting “Refresh now”.

[Unreleased]: https://github.com/SelfRef/vibecheck/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/SelfRef/vibecheck/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/SelfRef/vibecheck/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/SelfRef/vibecheck/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/SelfRef/vibecheck/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/SelfRef/vibecheck/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/SelfRef/vibecheck/compare/v0.3.1...v1.0.0
[0.3.1]: https://github.com/SelfRef/vibecheck/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/SelfRef/vibecheck/compare/c62d96e...v0.3.0
[0.2.0]: https://github.com/SelfRef/vibecheck/compare/v0.1.0...c62d96e
[0.1.0]: https://github.com/SelfRef/vibecheck/releases/tag/v0.1.0
