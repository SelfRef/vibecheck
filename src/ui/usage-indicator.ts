import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
	formatMessage,
	formatPanelPercents,
	formatPanelReset,
	type UsageLimit,
} from '../domain/usage.js';
import { VibecheckError } from '../services/errors.js';
import type { UsageController, UsageState } from '../services/usage-controller.js';
import { createLimitContent } from './limit-content.js';
import { createInsightsContent } from './insights-content.js';
import { formatClockTime, localizedError } from './localization.js';

class UsageIndicatorImpl extends PanelMenu.Button {
	private readonly panelIcon: St.Icon;
	private readonly panelLabel: St.Label;
	private readonly statusItem: PopupMenu.PopupMenuItem;
	private readonly limitsSection: PopupMenu.PopupMenuSection;
	private readonly insightsSection: PopupMenu.PopupMenuSection;
	private readonly loginItem: PopupMenu.PopupMenuItem;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly controller: UsageController,
		private readonly settings: Gio.Settings,
		private readonly extensionPath: string,
		openPreferences: () => void,
	) {
		super(0, 'Vibecheck', false);
		const menu = this.menu as PopupMenu.PopupMenu;
		const box = new St.BoxLayout({
			style_class: 'panel-status-menu-box vibecheck-panel',
			y_align: Clutter.ActorAlign.CENTER,
		});
		// St recolors file icons whose name ends in -symbolic with the CSS color.
		this.panelIcon = new St.Icon({
			style_class: 'system-status-icon vibecheck-panel-icon',
			gicon: Gio.icon_new_for_string(`${this.extensionPath}/icons/vibecheck-symbolic.svg`),
		});
		box.add_child(this.panelIcon);
		this.panelLabel = new St.Label({
			text: formatMessage(_('Claude %s'), '--'),
			y_align: Clutter.ActorAlign.CENTER,
		});
		box.add_child(this.panelLabel);
		this.add_child(box);

		this.statusItem = new PopupMenu.PopupMenuItem(_('Loading…'), {
			reactive: false,
			can_focus: false,
		});
		this.statusItem.add_style_class_name('vibecheck-status');
		menu.addMenuItem(this.statusItem);
		menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

		this.limitsSection = new PopupMenu.PopupMenuSection();
		menu.addMenuItem(this.limitsSection);
		this.insightsSection = new PopupMenu.PopupMenuSection();
		menu.addMenuItem(this.insightsSection);
		menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

		this.loginItem = new PopupMenu.PopupMenuItem(_('Sign in / renew session'));
		this.loginItem.connectObject(
			'activate',
			() => {
				try {
					this.controller.launchLogin();
				} catch (error) {
					if (!(error instanceof VibecheckError)) {
						throw error;
					}
					Main.notifyError(_('Vibecheck'), localizedError(error.code));
				}
			},
			this,
		);
		menu.addMenuItem(this.loginItem);

		const refreshItem = new PopupMenu.PopupMenuItem(_('Refresh now'));
		refreshItem.connectObject('activate', () => void this.controller.refresh(), this);
		menu.addMenuItem(refreshItem);

		const settingsItem = new PopupMenu.PopupMenuItem(_('Preferences'));
		settingsItem.connectObject('activate', openPreferences, this);
		menu.addMenuItem(settingsItem);

		this.unsubscribe = controller.subscribe((state) => this.render(state));
	}

	override destroy(): void {
		this.unsubscribe();
		super.destroy();
	}

	private render(state: Readonly<UsageState>): void {
		this.renderPanel(state);
		this.renderMenu(state);
	}

	private renderPanel(state: Readonly<UsageState>): void {
		this.showPanelIcon(this.settings.get_string('panel-icon'));

		if (!state.snapshot) {
			this.panelLabel.text = formatMessage(_('Claude %s'), state.loading ? '…' : '--');
			this.panelLabel.visible = true;
			return;
		}

		const percents = formatPanelPercents(
			state.snapshot.limits,
			[this.settings.get_string('panel-primary'), this.settings.get_string('panel-secondary')],
			this.settings.get_boolean('show-used'),
		);
		// The countdown advances with each poll rather than every minute.
		const reset = formatPanelReset(
			state.snapshot.limits,
			this.settings.get_string('panel-reset'),
			new Date(),
			_,
		);
		const text = [percents, reset].filter(Boolean).join(' · ');
		this.panelLabel.text = text + (state.stale ? ' *' : '');
		this.panelLabel.visible = this.panelLabel.text !== '';
		// With no values, no countdown, and no icon, the indicator would vanish.
		if (!this.panelLabel.visible && !this.panelIcon.visible) {
			this.showPanelIcon('color');
		}
	}

	private showPanelIcon(style: string): void {
		this.panelIcon.visible = style !== 'none';
		if (style === 'color') {
			this.panelIcon.add_style_class_name('vibecheck-panel-icon-color');
		} else {
			this.panelIcon.remove_style_class_name('vibecheck-panel-icon-color');
		}
	}

	private renderMenu(state: Readonly<UsageState>): void {
		this.limitsSection.removeAll();
		this.insightsSection.removeAll();

		if (state.renewing) {
			this.statusItem.label.text = _('Renewing the Claude session…');
		} else if (state.loading && !state.snapshot) {
			this.statusItem.label.text = _('Loading Claude usage…');
		} else if (state.errorCode) {
			const error = localizedError(state.errorCode);
			this.statusItem.label.text = state.stale ? formatMessage(_('Stale data · %s'), error) : error;
		} else if (state.snapshot) {
			const updated = formatClockTime(state.snapshot.fetchedAt);
			const title = formatMessage(
				_('%s · updated %s'),
				state.planLabel ?? _('Claude plan'),
				updated,
			);
			this.statusItem.label.text = state.stale ? formatMessage(_('%s · stale'), title) : title;
		}

		if (state.snapshot) {
			const used = this.settings.get_boolean('show-used');
			for (const limit of state.snapshot.limits) {
				this.limitsSection.addMenuItem(createLimitRow(limit, used));
			}
		}

		const insights = this.settings.get_string('show-insights');
		if (state.insights?.length && (insights === 'both' || insights === 'menu')) {
			this.insightsSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
			const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
			item.add_style_class_name('vibecheck-limit-item');
			item.add_child(createInsightsContent(state.insights));
			this.insightsSection.addMenuItem(item);
		}

		const needsLogin =
			state.errorCode === 'not-authenticated' ||
			state.errorCode === 'credentials-missing' ||
			state.errorCode === 'credentials-expired' ||
			state.errorCode === 'renewal-failed' ||
			state.errorCode === 'unauthorized';
		this.loginItem.visible = needsLogin;
	}
}

export const UsageIndicator = GObject.registerClass(
	UsageIndicatorImpl as any,
) as unknown as typeof UsageIndicatorImpl;

function createLimitRow(limit: UsageLimit, used: boolean): PopupMenu.PopupBaseMenuItem {
	const item = new PopupMenu.PopupBaseMenuItem({
		reactive: false,
		can_focus: false,
	});
	item.add_style_class_name('vibecheck-limit-item');
	item.add_child(createLimitContent(limit, used));
	return item;
}
