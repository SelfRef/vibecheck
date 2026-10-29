// GNOME Shell UI regression probe for Vibecheck.
//
// The unit tests cover pure logic and the GJS harnesses cover the services.
// Neither can touch St, Clutter, or PopupMenu, which is exactly where a new
// GNOME Shell release breaks an extension. This probe is installed as a
// throwaway extension next to a build of Vibecheck, drives its actors through
// every render path with a synthetic snapshot, and reports one line to the
// journal.
//
// It is test-only: it is never packaged and never installed on a real session.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { DesktopCard } from './ui/desktop-card.js';
import { UsageIndicator } from './ui/usage-indicator.js';

const ROLE = 'vibecheck-uicheck';

/** Long enough for the verification script to open a window on top. */
const STACKING_DELAY = 12;

function typeName(actor) {
	return actor.constructor?.$gtype?.name ?? '';
}

function isCard(actor) {
	return actor.has_style_class_name?.('vibecheck-desktop-card') === true;
}

function actorsWithStyle(root, styleClass) {
	const matches = [];
	const visit = (actor) => {
		if (actor.has_style_class_name?.(styleClass) === true) {
			matches.push(actor);
		}
		for (const child of actor.get_children?.() ?? []) {
			visit(child);
		}
	};
	visit(root);
	return matches;
}

function checkProgressBars(name, root) {
	const expectedFractions = SNAPSHOT.limits.map((limit) => limit.remainingPercent / 100);
	const tracks = root ? actorsWithStyle(root, 'vibecheck-progress-track') : [];
	if (tracks.length !== expectedFractions.length) {
		return [
			`${name}: expected ${expectedFractions.length} progress tracks, found ${tracks.length}`,
		];
	}

	const failures = [];
	for (const [index, track] of tracks.entries()) {
		const fill = track.get_first_child();
		const actualFraction = fill?.width / track.width;
		if (
			!Number.isFinite(actualFraction) ||
			Math.abs(actualFraction - expectedFractions[index]) > 0.01
		) {
			failures.push(
				`${name}: progress ${index} is ${fill?.width ?? 'missing'}/${track.width}px, expected ${expectedFractions[index] * 100}%`,
			);
		}
	}
	return failures;
}

/**
 * Verifies where the card ended up: inside the wallpaper's own container, on
 * top of the wallpaper, with the whole container below every window.
 *
 * Being a sibling of the window actors is not good enough. Mutter restacks the
 * window group on every stacking change and moves the actors it owns around
 * any foreign child, which floats the card above the windows. Only a window
 * that appears after the card is built can catch that, so a missing window is
 * reported as a failure rather than silently passing.
 */
function checkStacking() {
	const siblings = global.window_group.get_children();
	const groups = siblings.filter((child) => typeName(child) === 'MetaBackgroundGroup');
	if (groups.length === 0) {
		return ['the wallpaper group was not found in the window group'];
	}

	const owner = groups.find((group) => group.get_children().some(isCard));
	if (!owner) {
		return [
			siblings.some(isCard)
				? 'the desktop card is a sibling of the window actors instead of a child of the wallpaper group'
				: 'the desktop card was not added to the wallpaper group',
		];
	}

	const failures = [];
	const children = owner.get_children();
	console.log(`VIBECHECK UI LAYERS: ${children.map(typeName).join(',')}`);
	if (children.length < 2) {
		failures.push(
			'the wallpaper group holds no wallpaper actor, so the card layering is unverifiable',
		);
	}
	if (!isCard(children[children.length - 1])) {
		failures.push(
			`the desktop card is not on top of the wallpaper (${children.map(typeName).join(',')})`,
		);
	}

	const groupIndex = siblings.indexOf(owner);
	const windowIndexes = siblings
		.map((child, index) => (typeName(child).startsWith('MetaWindowActor') ? index : -1))
		.filter((index) => index >= 0);
	if (windowIndexes.length === 0) {
		failures.push('no window appeared, so the card stacking could not be verified');
	} else if (groupIndex > Math.min(...windowIndexes)) {
		failures.push(
			`the desktop card is not below application windows (wallpaper group ${groupIndex}, windows ${windowIndexes.join(',')})`,
		);
	}
	return failures;
}

const SNAPSHOT = {
	fetchedAt: new Date().toISOString(),
	limits: [
		{
			id: 'five_hour',
			label: 'Current session',
			consumedPercent: 20,
			remainingPercent: 80,
			resetsAt: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
			group: 'session',
			scope: null,
			severity: 'ok',
		},
		{
			id: 'seven_day',
			label: 'Weekly · all models',
			consumedPercent: 82,
			remainingPercent: 18,
			resetsAt: new Date(Date.now() + 4 * 24 * 3600 * 1000).toISOString(),
			group: 'weekly',
			scope: null,
			severity: 'warning',
		},
		{
			id: 'seven_day_some_model',
			label: 'Weekly · some-model',
			consumedPercent: 95,
			remainingPercent: 5,
			resetsAt: null,
			group: 'weekly',
			scope: 'some-model',
			severity: 'critical',
		},
	],
};

const INSIGHTS = [
	{
		title: 'Last 24h · 387 requests · 10 sessions',
		lines: ['32% of your usage was at >150k context', 'Top subagents: general-purpose 5%'],
	},
	{
		title: 'Last 7d · 2682 requests · 27 sessions',
		lines: ['41% of your usage came from sessions active for 8+ hours'],
	},
];

/**
 * Renders the top bar under value, countdown, and icon combinations. Whatever
 * is switched off, the indicator must keep something visible.
 */
function checkPanelLabel(controller, settings, indicator) {
	const failures = [];
	for (const [primary, secondary, reset, icon, pattern, iconShown] of [
		['five_hour', 'seven_day', 'both', 'color', /^80%\/18% · \d+h \d+m\/\d+d \d+h$/, true],
		['none', 'seven_day', 'none', 'color', /^18%$/, true],
		['none', 'none', 'five_hour', 'none', /^\d+h \d+m$/, false],
		['none', 'none', 'none', 'mono', null, true],
		['none', 'none', 'none', 'none', null, true],
	]) {
		settings.set_string('panel-primary', primary);
		settings.set_string('panel-secondary', secondary);
		settings.set_string('panel-reset', reset);
		settings.set_string('panel-icon', icon);
		controller.emit({ snapshot: SNAPSHOT, planLabel: 'Claude Max 5x' });

		const label = indicator.panelLabel;
		const name = `${primary}/${secondary}, reset ${reset}, icon ${icon}`;
		if (pattern ? !label.visible || !pattern.test(label.text) : label.visible) {
			failures.push(`${name}: panel label is ${label.visible ? `"${label.text}"` : 'hidden'}`);
		}
		if (indicator.panelIcon.visible !== iconShown) {
			failures.push(`${name}: panel icon is ${indicator.panelIcon.visible ? 'shown' : 'hidden'}`);
		}
	}

	// The theme pads status icons; only the box spacing should separate icon and text.
	const node = indicator.panelIcon.get_theme_node();
	const inset = [St.Side.LEFT, St.Side.RIGHT].reduce(
		(sum, side) => sum + node.get_padding(side) + node.get_margin(side),
		0,
	);
	if (inset !== 0) {
		failures.push(`panel icon keeps ${inset}px of horizontal padding and margin`);
	}
	return failures;
}

/** Renders the report under each placement setting and counts the periods shown. */
function checkInsights(controller, settings) {
	const failures = [];
	for (const [place, inMenu, onCard] of [
		['both', true, true],
		['menu', true, false],
		['card', false, true],
		['none', false, false],
	]) {
		settings.set_string('show-insights', place);
		controller.emit({ snapshot: SNAPSHOT, planLabel: 'Claude Max 5x', insights: INSIGHTS });
		const card = actorsWithStyle(global.window_group, 'vibecheck-desktop-card')[0];
		for (const [name, root, shown] of [
			['menu', Main.panel.statusArea[ROLE]?.menu.box, inMenu],
			['desktop card', card, onCard],
		]) {
			const expected = shown ? INSIGHTS.length : 0;
			const found = root ? actorsWithStyle(root, 'vibecheck-insight-period').length : -1;
			if (found !== expected) {
				failures.push(
					`${name} shows ${found} usage periods with show-insights=${place}, expected ${expected}`,
				);
			}
		}
	}
	settings.reset('show-insights');
	return failures;
}

const STATES = [
	{ name: 'loading', patch: { loading: true } },
	{ name: 'renewing', patch: { loading: true, renewing: true } },
	{
		name: 'renewal failed',
		patch: {
			error: 'The Claude session could not be renewed automatically. Retrying later.',
			errorCode: 'renewal-failed',
		},
	},
	{
		name: 'stale after error',
		patch: {
			snapshot: SNAPSHOT,
			stale: true,
			error: 'Could not reach Anthropic. Check your connection.',
			errorCode: 'network-error',
			planLabel: 'Claude Max 5x',
		},
	},
	{
		name: 'snapshot',
		patch: { snapshot: SNAPSHOT, planLabel: 'Claude Max 5x' },
	},
];

function emptyState() {
	return {
		snapshot: null,
		loading: false,
		renewing: false,
		stale: false,
		error: null,
		errorCode: null,
		planLabel: null,
		insights: null,
	};
}

class ProbeController {
	constructor() {
		this._listeners = new Set();
		this._state = emptyState();
	}

	subscribe(listener) {
		this._listeners.add(listener);
		listener(this._state);
		return () => this._listeners.delete(listener);
	}

	emit(patch) {
		this._state = { ...emptyState(), ...patch };
		for (const listener of this._listeners) {
			listener(this._state);
		}
	}

	refreshes = 0;

	refresh() {
		this.refreshes += 1;
	}

	launchLogin() {}
}

/**
 * Opens the card's menu as a right-click would and activates each item. The
 * click routing itself needs a real pointer, which the headless Shell lacks.
 */
function checkCardMenu(card, controller, preferences) {
	const failures = [];
	const items = () =>
		card.menu.box.get_children().filter((child) => child instanceof PopupMenu.PopupMenuItem);
	const labels = items().map((item) => item.label.text);
	if (labels.join(',') !== 'Refresh now,Preferences') {
		return [`the card menu holds ${labels.join(',') || 'nothing'}`];
	}

	for (const [index, counter, name] of [
		[0, () => controller.refreshes, 'refresh'],
		[1, () => preferences.opened, 'preferences'],
	]) {
		card.openMenu(200, 200);
		if (!card.menu.isOpen) {
			failures.push('the card menu did not open');
			break;
		}
		const before = counter();
		items()[index].activate(Clutter.get_current_event());
		if (counter() !== before + 1) {
			failures.push(`the card menu ${name} item did nothing`);
		}
		if (card.menu.isOpen) {
			failures.push(`the card menu stayed open after ${name}`);
			card.menu.close();
		}
	}
	return failures;
}

/** The left-click menu shows usage; the actions are in the right-click menu. */
function checkIndicatorMenus(indicator) {
	const labels = (menu) =>
		menu.box
			.get_children()
			.filter((child) => child instanceof PopupMenu.PopupBaseMenuItem && child.label)
			.map((item) => item.label.text);
	const failures = [];
	const usage = labels(indicator.menu);
	if (usage.includes('Refresh now') || usage.includes('Preferences')) {
		failures.push(`the usage menu holds ${usage.join(',')}`);
	}
	const actions = labels(indicator.contextMenu).join(',');
	if (actions !== 'Start sessions automatically,Refresh now,Preferences') {
		failures.push(`the right-click menu holds ${actions || 'nothing'}`);
	}
	return failures;
}

export default class VibecheckUiCheck extends Extension {
	_timeoutId = null;

	_progressTimeoutId = null;

	enable() {
		const failures = [];
		const settings = this.getSettings();
		const controller = new ProbeController();
		const preferences = { opened: 0 };

		let indicator = null;
		let card = null;
		try {
			indicator = new UsageIndicator(controller, settings, this.path, () => {});
			Main.panel.addToStatusArea(ROLE, indicator);
			card = new DesktopCard(controller, settings, () => {
				preferences.opened += 1;
			});
			// The shell starts in the overview, which hides the desktop. The card is
			// only laid out, and its meters sized, once the desktop is showing.
			Main.overview.hide();

			for (const [secondary, icon] of [
				['seven_day', 'color'],
				['none', 'mono'],
				['seven_day', 'none'],
			]) {
				settings.set_string('panel-secondary', secondary);
				settings.set_string('panel-icon', icon);
				for (const state of STATES) {
					try {
						controller.emit(state.patch);
					} catch (error) {
						failures.push(`${state.name} (secondary=${secondary}, icon=${icon}): ${error}`);
					}
				}
			}
			failures.push(...checkInsights(controller, settings));
			failures.push(...checkPanelLabel(controller, settings, indicator));
			failures.push(...checkIndicatorMenus(indicator));
			controller.emit({ snapshot: SNAPSHOT, planLabel: 'Claude Max 5x' });

			indicator.menu.open();
			this._progressTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
				this._progressTimeoutId = null;
				failures.push(...checkProgressBars('menu', indicator.menu.box));
				indicator.menu.close();
				return GLib.SOURCE_REMOVE;
			});
		} catch (error) {
			failures.push(String(error));
		}

		// The stacking is only observable once a window has appeared after the card
		// was built, so the check waits for the verification script to open one.
		this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, STACKING_DELAY, () => {
			this._timeoutId = null;
			failures.push(...checkStacking());
			const cardActor = actorsWithStyle(global.window_group, 'vibecheck-desktop-card')[0];
			failures.push(...checkProgressBars('desktop card', cardActor));
			if (card) {
				failures.push(...checkCardMenu(card, controller, preferences));
			}
			try {
				card?.destroy();
				indicator?.destroy();
			} catch (error) {
				failures.push(`teardown: ${error}`);
			}
			for (const key of ['panel-primary', 'panel-secondary', 'panel-reset', 'panel-icon']) {
				settings.reset(key);
			}

			if (failures.length > 0) {
				console.error(`VIBECHECK UI CHECK FAILED: ${failures.join(' | ')}`);
			} else {
				console.log('VIBECHECK UI CHECK OK');
			}
			return GLib.SOURCE_REMOVE;
		});
	}

	disable() {
		if (this._progressTimeoutId) {
			GLib.Source.remove(this._progressTimeoutId);
			this._progressTimeoutId = null;
		}
		if (this._timeoutId) {
			GLib.Source.remove(this._timeoutId);
			this._timeoutId = null;
		}
	}
}
