import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
	InvalidUsagePayloadError,
	formatPanelPercents,
	formatPanelReset,
	formatPlanLabel,
	formatPercent,
	formatTimeRemaining,
	localizedLimitLabel,
	normalizeUsage,
	severityFor,
} from '../src/domain/usage.js';

function fixture(name: string): unknown {
	const url = new URL(`./fixtures/${name}`, import.meta.url);
	return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as unknown;
}

describe('normalizeUsage', () => {
	it('normalizes legacy limits as remaining capacity', () => {
		const snapshot = normalizeUsage(fixture('legacy-response.json'), {
			now: new Date('2030-01-01T10:00:00Z'),
		});

		expect(snapshot.limits.map((limit) => limit.id)).toEqual([
			'five_hour',
			'seven_day',
			'seven_day_sonnet',
		]);
		expect(snapshot.limits[0]).toMatchObject({
			consumedPercent: 42.4,
			remainingPercent: 57.6,
			label: 'Current session',
		});
	});

	it('deduplicates normalized limits and discovers future model scopes', () => {
		const snapshot = normalizeUsage(fixture('normalized-response.json'));

		expect(snapshot.limits.map((limit) => limit.id)).toEqual([
			'five_hour',
			'seven_day',
			'seven_day_fable',
			'seven_day_future_model',
		]);
		expect(snapshot.limits[2]).toMatchObject({
			label: 'Weekly · Fable',
			group: 'weekly',
			scope: 'Fable',
			remainingPercent: 94,
		});
	});

	it('labels limits by the window group and scope Claude reports', () => {
		const snapshot = normalizeUsage(fixture('grouped-response.json'));

		expect(snapshot.limits.map((limit) => [limit.id, limit.label])).toEqual([
			['five_hour', 'Current session'],
			['seven_day', 'Weekly · all models'],
			['five_hour_fable', 'Session · Fable'],
			['seven_day_cowork', 'Weekly · Cowork'],
			['seven_day_fable', 'Weekly · Fable'],
			['seven_day_sonnet', 'Weekly · Sonnet'],
			['monthly', 'Monthly'],
		]);
	});

	it('reads model limits from legacy keys', () => {
		const snapshot = normalizeUsage(fixture('legacy-response.json'));

		expect(snapshot.limits[2]).toMatchObject({
			label: 'Weekly · Sonnet',
			group: 'weekly',
			scope: 'Sonnet',
		});
	});

	it('keeps extra usage only while it is enabled', () => {
		const ids = (enabled: boolean) =>
			normalizeUsage({
				five_hour: { utilization: 10 },
				spend: { percent: 40, enabled },
			}).limits.map((limit) => limit.id);
		expect(ids(true)).toEqual(['five_hour', 'extra_usage']);
		expect(ids(false)).toEqual(['five_hour']);
	});

	it('clamps malformed percentages and honors remaining thresholds', () => {
		const snapshot = normalizeUsage(
			{
				five_hour: { utilization: 150 },
				seven_day: { utilization: -10 },
			},
			{ warningRemaining: 30, criticalRemaining: 15 },
		);

		expect(snapshot.limits[0]).toMatchObject({ remainingPercent: 0, severity: 'critical' });
		expect(snapshot.limits[1]).toMatchObject({ remainingPercent: 100, severity: 'ok' });
	});

	it('rejects payloads with no usable limits', () => {
		expect(() => normalizeUsage({ limits: [] })).toThrow(InvalidUsagePayloadError);
		expect(() => normalizeUsage(null)).toThrow('not an object');
	});
});

describe('formatting', () => {
	it('formats percentages without unnecessary decimals', () => {
		expect(formatPercent(50)).toBe('50%');
		expect(formatPercent(50.25)).toBe('50.3%');
	});

	it('formats reset countdowns', () => {
		const now = new Date('2030-01-01T10:00:00Z');
		expect(formatTimeRemaining('2030-01-01T15:00:00Z', now)).toBe('resets in 5h 0m');
		expect(formatTimeRemaining('2030-01-03T12:30:00Z', now)).toBe('resets in 2d 2h');
		expect(formatTimeRemaining(null, now)).toBe('reset unavailable');
	});

	it('assigns severity', () => {
		expect(severityFor(10)).toBe('critical');
		expect(severityFor(25)).toBe('warning');
		expect(severityFor(26)).toBe('ok');
	});

	it('formats one or two panel percentages from the selected limits', () => {
		const limit = (id: string, remainingPercent: number, scope: string | null = null) => ({
			id,
			label: id,
			consumedPercent: 100 - remainingPercent,
			remainingPercent,
			resetsAt: null,
			group: null,
			scope,
			severity: 'ok' as const,
		});
		const limits = [
			limit('five_hour', 80),
			limit('seven_day', 60),
			limit('seven_day_fable', 40, 'Fable'),
			limit('seven_day_opus', 70, 'Opus'),
		];
		expect(formatPanelPercents(limits, ['five_hour', 'seven_day'])).toBe('80%/60%');
		expect(formatPanelPercents(limits, ['seven_day', 'none'])).toBe('60%');
		expect(formatPanelPercents(limits, ['seven_day', 'lowest'])).toBe('60%/40%');
		expect(formatPanelPercents(limits, ['seven_day', 'lowest'], true)).toBe('40%/60%');
		expect(formatPanelPercents([limit('five_hour', 80)], ['five_hour', 'seven_day'])).toBe(
			'80%/--',
		);
		expect(formatPanelPercents(limits, ['bogus'])).toBe('--');
	});

	it('formats a compact panel countdown for the selected limit', () => {
		const now = new Date('2030-01-01T10:00:00Z');
		const limit = (id: string, resetsAt: string | null) => ({
			id,
			label: id,
			consumedPercent: 50,
			remainingPercent: 50,
			resetsAt,
			group: null,
			scope: null,
			severity: 'ok' as const,
		});
		const limits = [
			limit('five_hour', '2030-01-01T12:10:00Z'),
			limit('seven_day', '2030-01-03T12:30:00Z'),
			limit('seven_day_opus', null),
		];
		expect(formatPanelReset(limits, 'five_hour', now)).toBe('2h 10m');
		expect(formatPanelReset(limits, 'seven_day', now)).toBe('2d 2h');
		expect(formatPanelReset([limit('five_hour', '2030-01-01T10:05:00Z')], 'five_hour', now)).toBe(
			'5m',
		);
		expect(formatPanelReset(limits, 'seven_day_opus', now)).toBe('');
		expect(formatPanelReset([limit('five_hour', null)], 'five_hour', now)).toBe('');
		expect(formatPanelReset(limits, 'both', now)).toBe('2h 10m/2d 2h');
		expect(formatPanelReset([limit('seven_day', '2030-01-03T12:30:00Z')], 'both', now)).toBe(
			'2d 2h',
		);
		expect(formatPanelReset(limits, 'none', now)).toBe('');
	});

	it('supports injected system translations without coupling the domain to GNOME', () => {
		const translations: Record<string, string> = {
			'Weekly · %s': 'Settimanale · %s',
			'resets in %dh %dm': 'reset tra %dh %dm',
		};
		const translate = (message: string) => translations[message] ?? message;
		expect(
			localizedLimitLabel(
				{
					id: 'seven_day_fable',
					label: 'Weekly · Fable',
					group: 'weekly',
					scope: 'Fable',
				},
				translate,
			),
		).toBe('Settimanale · Fable');
		expect(
			formatTimeRemaining('2030-01-01T15:00:00Z', new Date('2030-01-01T10:00:00Z'), translate),
		).toBe('reset tra 5h 0m');
	});

	it('formats Claude plan tiers from credential metadata', () => {
		expect(formatPlanLabel('max', 'default_claude_max_5x')).toBe('Max (5x)');
		expect(formatPlanLabel('max', 'default_claude_max_20x')).toBe('Max (20x)');
		expect(formatPlanLabel('pro', 'default')).toBe('Pro');
		expect(formatPlanLabel('team', 'default_claude_max_5x')).toBe('Team Premium');
		expect(formatPlanLabel('team', 'default')).toBe('Team');
		expect(formatPlanLabel(null, null)).toBe('Claude');
	});
});
