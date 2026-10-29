import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { parseUsageCommandStream, type CliUsageReport } from '../domain/usage-insights.js';
import { ChildProcess } from './child-process.js';

/** A report that has not finished by then is abandoned. */
const TIMEOUT_SECONDS = 30;

/** A session-start prompt that has not finished by then is abandoned. */
const SESSION_START_TIMEOUT_SECONDS = 60;

/**
 * Keeps both commands away from the user's configuration: no settings, so the
 * user's hooks and plugins do not run, and no saved session, so neither run
 * adds itself to the transcripts the report is built from.
 */
const ISOLATION_ARGS = ['--setting-sources', '', '--no-session-persistence'];

/**
 * Runs Claude Code's `/usage` command. Claude Code then reads its own
 * credentials, renews its session when needed, and queries the usage endpoint
 * itself. Its structured report carries the rate limits; the contributing-usage
 * section, which it builds from the transcripts on this machine, exists only in
 * the printed text and is parsed in the domain layer.
 *
 * The command makes no model request.
 */
export class ClaudeCliUsage {
	private process: ChildProcess | null = null;
	private sessionProcess: ChildProcess | null = null;

	static isInstalled(): boolean {
		return GLib.find_program_in_path('claude') !== null;
	}

	/** Resolves with the report, or null when the command failed or is busy. */
	async run(): Promise<CliUsageReport | null> {
		if (this.process) {
			return null;
		}

		const child = spawn(
			['claude', '-p', '/usage', ...ISOLATION_ARGS, '--output-format', 'stream-json', '--verbose'],
			Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
			TIMEOUT_SECONDS,
		);
		if (!child) {
			return null;
		}

		this.process = child;
		try {
			return parseUsageCommandStream(await child.output());
		} catch {
			return null;
		} finally {
			if (this.process === child) {
				this.process = null;
			}
		}
	}

	/**
	 * Sends one tiny prompt, without tools or MCP servers, to the given model
	 * alias. Any model request opens the five-hour window, so a cheap model is
	 * enough. Resolves true when the CLI exits successfully.
	 */
	async startSession(model: string): Promise<boolean> {
		if (this.sessionProcess) {
			return false;
		}

		const child = spawn(
			[
				'claude',
				'-p',
				'Reply with OK.',
				'--model',
				model,
				'--tools',
				'',
				'--strict-mcp-config',
				...ISOLATION_ARGS,
			],
			Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
			SESSION_START_TIMEOUT_SECONDS,
		);
		if (!child) {
			return false;
		}

		this.sessionProcess = child;
		try {
			return await child.succeeded();
		} finally {
			if (this.sessionProcess === child) {
				this.sessionProcess = null;
			}
		}
	}

	destroy(): void {
		this.process?.cancel();
		this.process = null;
		this.sessionProcess?.cancel();
		this.sessionProcess = null;
	}
}

function spawn(
	argv: string[],
	flags: Gio.SubprocessFlags,
	timeoutSeconds: number,
): ChildProcess | null {
	if (!ClaudeCliUsage.isInstalled()) {
		return null;
	}
	try {
		const launcher = new Gio.SubprocessLauncher({ flags });
		// The CLI must never block on a prompt inherited from GNOME Shell.
		launcher.set_stdin_file_path('/dev/null');
		launcher.set_cwd(GLib.get_home_dir());
		return new ChildProcess(launcher.spawnv(argv), timeoutSeconds);
	} catch {
		return null;
	}
}
