export type UsageSeverity = 'ok' | 'warning' | 'critical';

export interface UsageLimit {
	id: string;
	label: string;
	consumedPercent: number;
	remainingPercent: number;
	resetsAt: string | null;
	/** Reset window reported by Claude, such as `session` or `weekly`. */
	group: string | null;
	/** Model or surface the limit is restricted to, or null for all usage. */
	scope: string | null;
	severity: UsageSeverity;
}

export interface UsageSnapshot {
	fetchedAt: string;
	limits: UsageLimit[];
}

export interface NormalizeOptions {
	warningRemaining?: number;
	criticalRemaining?: number;
	now?: Date;
}

export type Translator = (message: string) => string;

export class InvalidUsagePayloadError extends Error {
	constructor(message = 'Claude returned no supported usage limits') {
		super(message);
		this.name = 'InvalidUsagePayloadError';
	}
}

type UnknownRecord = Record<string, unknown>;

const PRIORITY: Record<string, number> = {
	five_hour: 0,
	seven_day: 1,
	extra_usage: 3,
};

export function normalizeUsage(payload: unknown, options: NormalizeOptions = {}): UsageSnapshot {
	if (!isRecord(payload)) {
		throw new InvalidUsagePayloadError('Claude usage response is not an object');
	}

	const warningRemaining = clamp(options.warningRemaining ?? 25, 0, 100);
	const criticalRemaining = clamp(options.criticalRemaining ?? 10, 0, warningRemaining);
	const candidates = collectCandidates(payload);
	const limits = new Map<string, UsageLimit>();

	for (const { key, group, scope, candidate } of candidates) {
		// A switched-off feature such as extra usage still reports 0% used.
		if (candidate.enabled === false || candidate.is_enabled === false) {
			continue;
		}

		const utilization = firstNumber(candidate.utilization, candidate.percent);
		if (utilization === null) {
			continue;
		}

		const id = canonicalId(key, group, scope);
		if (!id || limits.has(id)) {
			continue;
		}

		const consumedPercent = round(clamp(utilization, 0, 100), 1);
		const remainingPercent = round(100 - consumedPercent, 1);
		limits.set(id, {
			id,
			label: limitLabel(id, group, scope),
			consumedPercent,
			remainingPercent,
			resetsAt: readReset(candidate),
			group,
			scope,
			severity: severityFor(remainingPercent, warningRemaining, criticalRemaining),
		});
	}

	if (limits.size === 0) {
		throw new InvalidUsagePayloadError();
	}

	return {
		fetchedAt: (options.now ?? new Date()).toISOString(),
		limits: [...limits.values()].sort(compareLimits),
	};
}

export function severityFor(
	remainingPercent: number,
	warningRemaining = 25,
	criticalRemaining = 10,
): UsageSeverity {
	if (remainingPercent <= criticalRemaining) {
		return 'critical';
	}
	if (remainingPercent <= warningRemaining) {
		return 'warning';
	}
	return 'ok';
}

export function formatPercent(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

export function formatTimeRemaining(
	resetsAt: string | null,
	now = new Date(),
	translate: Translator = identity,
): string {
	const remaining = splitRemaining(resetsAt, now);
	if (!remaining) {
		return translate('reset unavailable');
	}

	const [days, hours, minutes] = remaining;
	if (days === 0 && hours === 0 && minutes === 0) {
		return translate('reset imminent');
	}
	if (days > 0) {
		return formatMessage(translate('resets in %dd %dh'), days, hours);
	}
	if (hours > 0) {
		return formatMessage(translate('resets in %dh %dm'), hours, minutes);
	}
	return formatMessage(translate('resets in %dm'), minutes);
}

/**
 * Compact countdowns for the top bar: `five_hour`, `seven_day`, or `both`
 * joined by a slash. Limits without a reset are left out, so the result can be
 * an empty string.
 */
export function formatPanelReset(
	limits: readonly UsageLimit[],
	choice: string,
	now = new Date(),
	translate: Translator = identity,
): string {
	return (choice === 'both' ? ['five_hour', 'seven_day'] : [choice])
		.map((id) => formatCountdown(limits, id, now, translate))
		.filter(Boolean)
		.join('/');
}

function formatCountdown(
	limits: readonly UsageLimit[],
	choice: string,
	now: Date,
	translate: Translator,
): string {
	const remaining = splitRemaining(selectPanelLimit(limits, choice)?.resetsAt ?? null, now);
	if (!remaining) {
		return '';
	}

	const [days, hours, minutes] = remaining;
	if (days > 0) {
		return formatMessage(translate('%dd %dh'), days, hours);
	}
	if (hours > 0) {
		return formatMessage(translate('%dh %dm'), hours, minutes);
	}
	return formatMessage(translate('%dm'), minutes);
}

export function localizedLimitLabel(
	limit: Pick<UsageLimit, 'id' | 'label' | 'group' | 'scope'>,
	translate: Translator = identity,
): string {
	if (limit.id === 'five_hour') {
		return translate('Current session');
	}
	if (limit.id === 'seven_day') {
		return translate('Weekly · all models');
	}
	if (limit.scope && limit.group === 'weekly') {
		return formatMessage(translate('Weekly · %s'), limit.scope);
	}
	if (limit.scope && limit.group === 'session') {
		return formatMessage(translate('Session · %s'), limit.scope);
	}
	if (limit.id === 'extra_usage') {
		return translate('Extra usage');
	}
	// A limit kind or window this version does not know yet, labelled from the API.
	return limit.label;
}

export function selectPanelLimit(limits: readonly UsageLimit[], choice: string): UsageLimit | null {
	const candidates = choice === 'lowest' ? limits : limits.filter((limit) => limit.id === choice);
	return candidates.reduce<UsageLimit | null>(
		(lowest, limit) =>
			!lowest || limit.remainingPercent < lowest.remainingPercent ? limit : lowest,
		null,
	);
}

export function formatPanelPercents(
	limits: readonly UsageLimit[],
	choices: readonly string[],
	used = false,
): string {
	return choices
		.filter((choice) => choice && choice !== 'none')
		.map((choice) => {
			const limit = selectPanelLimit(limits, choice);
			if (!limit) {
				return '--';
			}
			return formatPercent(used ? limit.consumedPercent : limit.remainingPercent);
		})
		.join('/');
}

export function formatPlanLabel(
	subscriptionType: string | null,
	rateLimitTier: string | null,
): string {
	const subscription = subscriptionType?.trim().toLowerCase() ?? '';
	const tier = rateLimitTier?.trim().toLowerCase() ?? '';

	// Team Premium seats share the Max 5x rate-limit tier.
	if (subscription === 'team' && tier.includes('claude_max')) {
		return 'Team Premium';
	}

	if (subscription === 'max' || (!subscription && tier.includes('claude_max'))) {
		if (tier.includes('20x')) {
			return 'Max (20x)';
		}
		if (tier.includes('5x')) {
			return 'Max (5x)';
		}
		return 'Max';
	}

	const knownPlans: Record<string, string> = {
		free: 'Free',
		pro: 'Pro',
		team: 'Team',
		enterprise: 'Enterprise',
	};
	if (knownPlans[subscription]) {
		return knownPlans[subscription];
	}

	return subscriptionType?.trim() || 'Claude';
}

interface Candidate {
	key: string;
	group: string | null;
	scope: string | null;
	candidate: UnknownRecord;
}

/** Top-level keys for the session and weekly windows, by API group. */
const GROUP_IDS: Record<string, string> = {
	session: 'five_hour',
	weekly: 'seven_day',
};

function collectCandidates(payload: UnknownRecord): Candidate[] {
	const candidates: Candidate[] = [];

	// The `limits` array describes each limit by kind, window group, and scope,
	// so it comes first. The legacy top-level keys still back it up, and limits
	// both shapes report are deduplicated by id.
	if (Array.isArray(payload.limits)) {
		for (const entry of payload.limits) {
			if (!isRecord(entry)) {
				continue;
			}
			const key = firstString(entry.kind) ?? 'unknown';
			candidates.push({
				key,
				group: firstString(entry.group) ?? key.split('_')[0] ?? null,
				scope: readScope(entry),
				candidate: entry,
			});
		}
	}
	for (const [key, value] of Object.entries(payload)) {
		if (isRecord(value)) {
			candidates.push({ key, ...legacyGroupAndScope(key), candidate: value });
		}
	}
	return candidates;
}

/** Splits a legacy key such as `seven_day_sonnet` into its window and scope. */
function legacyGroupAndScope(key: string): { group: string | null; scope: string | null } {
	for (const [group, prefix] of Object.entries(GROUP_IDS)) {
		if (key === prefix) {
			return { group, scope: null };
		}
		if (key.startsWith(`${prefix}_`)) {
			return { group, scope: titleCase(key.slice(prefix.length + 1)) };
		}
	}
	return { group: null, scope: null };
}

function canonicalId(key: string, group: string | null, scope: string | null): string | null {
	if (key === 'spend') {
		return 'extra_usage';
	}
	if (!group) {
		return slugify(key) || null;
	}
	const base = GROUP_IDS[group] ?? slugify(group);
	if (scope) {
		return `${base}_${slugify(scope)}`;
	}
	// `session` and `weekly_all` are the whole window; any other unscoped kind
	// is a separate limit within it.
	return key === group || key === `${group}_all` || key === base ? base : slugify(key) || null;
}

function limitLabel(id: string, group: string | null, scope: string | null): string {
	if (id === 'five_hour') {
		return 'Current session';
	}
	if (id === 'seven_day') {
		return 'Weekly · all models';
	}
	if (id === 'extra_usage') {
		return 'Extra usage';
	}
	if (scope && group) {
		return `${titleCase(group)} · ${scope}`;
	}
	return titleCase(id);
}

function readScope(candidate: UnknownRecord): string | null {
	if (!isRecord(candidate.scope)) {
		return null;
	}
	const { model, surface } = candidate.scope;
	return readName(model) ?? readName(surface);
}

function readName(value: unknown): string | null {
	if (isRecord(value)) {
		return firstString(value.display_name, value.name, value.id);
	}
	return firstString(value);
}

function titleCase(value: string): string {
	return value
		.split('_')
		.filter(Boolean)
		.map((part) => part[0]?.toUpperCase() + part.slice(1))
		.join(' ');
}

function readReset(candidate: UnknownRecord): string | null {
	const reset = firstString(candidate.resets_at);
	return reset && Number.isFinite(Date.parse(reset)) ? reset : null;
}

function splitRemaining(resetsAt: string | null, now: Date): [number, number, number] | null {
	const resetTime = resetsAt ? Date.parse(resetsAt) : NaN;
	if (!Number.isFinite(resetTime)) {
		return null;
	}

	const totalMinutes = Math.ceil(Math.max(0, resetTime - now.getTime()) / 60_000);
	return [
		Math.floor(totalMinutes / 1_440),
		Math.floor((totalMinutes % 1_440) / 60),
		totalMinutes % 60,
	];
}

function compareLimits(left: UsageLimit, right: UsageLimit): number {
	const leftPriority = PRIORITY[left.id] ?? (left.scope ? 2 : 4);
	const rightPriority = PRIORITY[right.id] ?? (right.scope ? 2 : 4);
	return leftPriority - rightPriority || left.label.localeCompare(right.label);
}

function firstNumber(...values: unknown[]): number | null {
	for (const value of values) {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
	}
	return null;
}

function firstString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}
	return null;
}

export function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, decimals: number): number {
	const multiplier = 10 ** decimals;
	return Math.round(value * multiplier) / multiplier;
}

export function formatMessage(template: string, ...values: Array<string | number>): string {
	let index = 0;
	return template.replace(/%[sd]/g, () => String(values[index++] ?? ''));
}

function identity(message: string): string {
	return message;
}
