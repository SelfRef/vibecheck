import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type { ClaudeCredential } from '../domain/credential.js';
import { canRenew, evaluateSession, isAccessTokenUsable } from '../domain/session.js';
import type { UsageInsightPeriod } from '../domain/usage-insights.js';
import {
	formatPlanLabel,
	isSessionIdle,
	normalizeUsage,
	severityFor,
	type NormalizeOptions,
	type UsageSnapshot,
} from '../domain/usage.js';
import { ClaudeAuth, launchLogin } from './claude-auth.js';
import { ClaudeCliUsage } from './claude-cli-usage.js';
import { ClaudeCredentials } from './claude-credentials.js';
import { ClaudeUsageClient } from './claude-usage-client.js';
import { VibecheckError } from './errors.js';

export interface UsageState {
	snapshot: UsageSnapshot | null;
	loading: boolean;
	renewing: boolean;
	stale: boolean;
	errorCode: VibecheckError['code'] | null;
	planLabel: string | null;
	/** What contributes to usage on this machine, or null before the first report. */
	insights: UsageInsightPeriod[] | null;
}

type StateListener = (state: Readonly<UsageState>) => void;

type UsageClient = Pick<ClaudeUsageClient, 'fetch' | 'destroy'>;
type UsageAuth = Pick<ClaudeAuth, 'status' | 'renew' | 'destroy'>;
type UsageCredentials = Pick<ClaudeCredentials, 'read'>;
type UsageCli = Pick<ClaudeCliUsage, 'run' | 'startSession' | 'destroy'>;

export interface UsageControllerDependencies {
	client?: UsageClient;
	auth?: UsageAuth;
	credentials?: UsageCredentials;
	cli?: UsageCli;
}

interface UsageResult {
	snapshot: UsageSnapshot;
	planLabel: string | null;
	/** Present when the same source also reported what contributes to usage. */
	insights?: UsageInsightPeriod[];
}

/**
 * How long to wait before asking the CLI to renew again after a failure, so a
 * broken session cannot turn every poll into a subprocess spawn.
 */
const RENEWAL_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * With direct requests, the contributing-usage report still comes from the
 * CLI. It covers the last day and week, so it changes slowly, and each report
 * is a CLI run that also queries the usage endpoint.
 */
const INSIGHTS_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How long to wait before prompting again to start a session, so a failing
 * CLI or a usage report that lags behind cannot cause a prompt on every poll.
 */
const SESSION_START_COOLDOWN_MS = 15 * 60 * 1000;

export class UsageController {
	private readonly listeners = new Set<StateListener>();
	private client: UsageClient | null;
	private auth: UsageAuth | null;
	private credentials: UsageCredentials | null;
	private cli: UsageCli | null;
	private timeoutId: number | null = null;
	private renewalBlockedUntil = 0;
	private insightsRequestedAt = 0;
	private sessionStartRequestedAt = 0;
	private state: UsageState = {
		snapshot: null,
		loading: false,
		renewing: false,
		stale: false,
		errorCode: null,
		planLabel: null,
		insights: null,
	};

	constructor(
		private readonly settings: Gio.Settings,
		dependencies: UsageControllerDependencies = {},
	) {
		this.client = dependencies.client ?? new ClaudeUsageClient();
		this.auth = dependencies.auth ?? new ClaudeAuth();
		this.credentials = dependencies.credentials ?? new ClaudeCredentials();
		this.cli = dependencies.cli ?? new ClaudeCliUsage();
	}

	start(): void {
		void this.refresh();
	}

	/** Re-render the cached snapshot after a display-only setting changed. */
	redraw(): void {
		const snapshot = this.state.snapshot;
		const warning = this.settings.get_uint('warning-remaining');
		const critical = this.settings.get_uint('critical-remaining');
		this.setState({
			snapshot: snapshot && {
				...snapshot,
				limits: snapshot.limits.map((limit) => ({
					...limit,
					severity: severityFor(limit.remainingPercent, warning, critical),
				})),
			},
		});
	}

	subscribe(listener: StateListener): () => void {
		this.listeners.add(listener);
		listener(this.state);
		return () => this.listeners.delete(listener);
	}

	async refresh(): Promise<void> {
		const client = this.client;
		if (!client || this.state.loading) {
			return;
		}

		this.setState({ loading: true, errorCode: null });
		let nextDelay = this.baseIntervalSeconds();

		try {
			const options = {
				warningRemaining: this.settings.get_uint('warning-remaining'),
				criticalRemaining: this.settings.get_uint('critical-remaining'),
			};
			const result = this.usesCli()
				? await this.fetchFromCli(options)
				: await this.fetchDirectly(client, options);
			if (this.client !== client || !result) {
				return;
			}

			this.setState({
				snapshot: result.snapshot,
				planLabel: result.planLabel,
				insights: result.insights ?? this.state.insights,
				loading: false,
				renewing: false,
				stale: false,
				errorCode: null,
			});
			if (!result.insights) {
				void this.refreshInsights();
			}
			void this.startSessionIfIdle();
			// Poll again right as the window ends, so the next one starts on time.
			const reset = result.snapshot.limits.find((limit) => limit.id === 'five_hour')?.resetsAt;
			const untilReset = reset ? (Date.parse(reset) - Date.now()) / 1000 : 0;
			if (untilReset > 0 && this.settings.get_boolean('auto-start-session')) {
				nextDelay = Math.min(nextDelay, untilReset + 5);
			}
		} catch (error) {
			if (this.client !== client) {
				return;
			}
			if (error instanceof VibecheckError && error.code === 'rate-limited') {
				nextDelay = Math.max(nextDelay, error.retryAfterSeconds ?? nextDelay * 2);
			}
			this.setState({
				loading: false,
				renewing: false,
				stale: this.state.snapshot !== null,
				errorCode: error instanceof VibecheckError ? error.code : 'network-error',
			});
		} finally {
			if (this.client === client) {
				this.schedule(nextDelay);
			}
		}
	}

	/**
	 * With direct requests, asks Claude Code for its contributing-usage report
	 * while the report is shown somewhere, at most once per interval whether or
	 * not it succeeds. Through the CLI, every refresh already includes it.
	 */
	async refreshInsights(): Promise<void> {
		const cli = this.cli;
		if (
			!cli ||
			this.usesCli() ||
			this.settings.get_string('show-insights') === 'none' ||
			Date.now() - this.insightsRequestedAt < INSIGHTS_INTERVAL_MS
		) {
			return;
		}

		this.insightsRequestedAt = Date.now();
		const report = await cli.run();
		if (this.cli === cli && report) {
			this.setState({ insights: report.insights });
		}
	}

	/**
	 * When enabled and no five-hour window is running, sends one cheap prompt
	 * through Claude Code so the window starts counting now rather than at the
	 * user's next request, then refreshes to show it.
	 */
	async startSessionIfIdle(): Promise<void> {
		const cli = this.cli;
		const snapshot = this.state.snapshot;
		if (
			!cli ||
			!snapshot ||
			!this.settings.get_boolean('auto-start-session') ||
			!isSessionIdle(snapshot.limits) ||
			Date.now() - this.sessionStartRequestedAt < SESSION_START_COOLDOWN_MS
		) {
			return;
		}

		this.sessionStartRequestedAt = Date.now();
		const started = await cli.startSession(this.settings.get_string('auto-start-model'));
		if (this.cli === cli && started) {
			void this.refresh();
		}
	}

	/** Claude Code is the default source; direct requests are the fallback. */
	private usesCli(): boolean {
		return !this.settings.get_boolean('direct-requests') && ClaudeCliUsage.isInstalled();
	}

	/**
	 * Asks Claude Code for usage. It reads and renews its own session, so this
	 * path needs no credential handling beyond naming the plan.
	 */
	private async fetchFromCli(options: NormalizeOptions): Promise<UsageResult | null> {
		const cli = this.cli;
		if (!cli) {
			return null;
		}
		const report = await cli.run();
		if (this.cli !== cli) {
			return null;
		}
		if (!report) {
			throw new VibecheckError('claude-cli-failed');
		}
		if (!report.rateLimits) {
			// Claude Code reports no limits while signed out, and says nothing else.
			throw new VibecheckError(
				(await this.isSignedOut()) ? 'not-authenticated' : 'claude-cli-failed',
			);
		}

		let snapshot: UsageSnapshot;
		try {
			snapshot = normalizeUsage(report.rateLimits, options);
		} catch {
			throw new VibecheckError('invalid-response');
		}
		return { snapshot, planLabel: await this.readPlanLabel(), insights: report.insights };
	}

	/** Queries the usage endpoint with Claude Code's credential, renewing it first if needed. */
	private async fetchDirectly(
		client: UsageClient,
		options: NormalizeOptions,
	): Promise<UsageResult | null> {
		let credential = await this.readCredential();
		if (this.client !== client) {
			return null;
		}

		// An expired access token is not a lost session: the CLI can still
		// exchange its refresh token for a new one.
		let renewed = false;
		if (evaluateSession(credential) !== 'valid') {
			credential = await this.renewCredential(credential);
			renewed = true;
			if (this.client !== client) {
				return null;
			}
		}

		let result;
		try {
			result = await client.fetch(credential, options);
		} catch (error) {
			// The server is the authority on token validity: honour a 401 even
			// when the recorded expiry still looked fine.
			if (
				!renewed &&
				error instanceof VibecheckError &&
				error.code === 'unauthorized' &&
				canRenew(credential)
			) {
				credential = await this.renewCredential(credential);
				if (this.client !== client) {
					return null;
				}
				result = await client.fetch(credential, options);
			} else {
				throw error;
			}
		}
		this.renewalBlockedUntil = 0;
		return result;
	}

	/**
	 * Whether Claude Code needs an interactive sign-in. Its status alone is not
	 * enough: after a failed renewal it clears the tokens from its credential
	 * file but still reports itself signed in.
	 */
	private async isSignedOut(): Promise<boolean> {
		const status = await this.auth?.status();
		if (status && !status.loggedIn) {
			return true;
		}
		try {
			const credential = await this.credentials?.read();
			return credential ? !canRenew(credential) : false;
		} catch (error) {
			return error instanceof VibecheckError && error.code === 'credentials-missing';
		}
	}

	/** The plan named in Claude Code's credential file, which only the CLI writes. */
	private async readPlanLabel(): Promise<string | null> {
		try {
			const credential = await this.credentials?.read();
			return credential
				? formatPlanLabel(credential.subscriptionType, credential.rateLimitTier)
				: null;
		} catch {
			return null;
		}
	}

	launchLogin(): void {
		// A manual sign-in is an explicit fresh start for automatic renewal too.
		this.renewalBlockedUntil = 0;
		launchLogin();
	}

	destroy(): void {
		const client = this.client;
		const auth = this.auth;
		const cli = this.cli;
		this.client = null;
		this.auth = null;
		this.credentials = null;
		this.cli = null;
		if (this.timeoutId !== null) {
			GLib.Source.remove(this.timeoutId);
			this.timeoutId = null;
		}
		this.listeners.clear();
		auth?.destroy();
		client?.destroy();
		cli?.destroy();
	}

	/**
	 * Reads the credential Claude Code owns, asking the CLI for context only
	 * when the file cannot be used. The happy path stays free of subprocesses.
	 */
	private async readCredential(): Promise<ClaudeCredential> {
		const credentials = this.credentials;
		if (!credentials) {
			throw new VibecheckError('credentials-missing');
		}

		try {
			return await credentials.read();
		} catch (error) {
			if (error instanceof VibecheckError && error.code === 'credentials-missing') {
				const status = await this.auth?.status();
				if (status && !status.installed) {
					throw new VibecheckError('claude-cli-missing');
				}
				if (status && !status.loggedIn) {
					throw new VibecheckError('not-authenticated');
				}
			}
			throw error;
		}
	}

	/**
	 * Delegates renewal to the Claude Code CLI and returns the credential it
	 * wrote. Vibecheck never talks to the OAuth token endpoint itself.
	 */
	private async renewCredential(credential: ClaudeCredential): Promise<ClaudeCredential> {
		const auth = this.auth;
		if (!auth) {
			throw new VibecheckError('credentials-expired');
		}
		if (!canRenew(credential)) {
			throw new VibecheckError('credentials-expired');
		}
		if (Date.now() < this.renewalBlockedUntil) {
			throw new VibecheckError('renewal-failed');
		}

		this.setState({ renewing: true });
		try {
			await auth.renew(credential);
		} finally {
			if (this.auth === auth) {
				this.setState({ renewing: false });
			}
		}

		// The credential file is the authority, not this subprocess's exit code.
		// Another Claude Code process can rotate the single-use refresh token at
		// the same time: our process then fails even though the shared file now
		// contains a valid replacement.
		const next = await this.readCredential();
		if (isAccessTokenUsable(next)) {
			this.renewalBlockedUntil = 0;
			return next;
		}

		this.renewalBlockedUntil = Date.now() + RENEWAL_COOLDOWN_MS;
		throw new VibecheckError('renewal-failed');
	}

	private setState(patch: Partial<UsageState>): void {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) {
			listener(this.state);
		}
	}

	private schedule(seconds: number): void {
		if (!this.client) {
			return;
		}
		if (this.timeoutId !== null) {
			GLib.Source.remove(this.timeoutId);
			this.timeoutId = null;
		}
		this.timeoutId = GLib.timeout_add_seconds(
			GLib.PRIORITY_DEFAULT,
			Math.max(60, Math.round(seconds)),
			() => {
				this.timeoutId = null;
				void this.refresh();
				return GLib.SOURCE_REMOVE;
			},
		);
	}

	private baseIntervalSeconds(): number {
		return Math.max(1, this.settings.get_uint('refresh-interval')) * 60;
	}
}
