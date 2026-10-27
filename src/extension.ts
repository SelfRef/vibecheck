import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { UsageController } from './services/usage-controller.js';
import { DesktopCard } from './ui/desktop-card.js';
import { releaseClockSettings } from './ui/localization.js';
import { UsageIndicator } from './ui/usage-indicator.js';

export default class VibecheckExtension extends Extension {
	private settings: Gio.Settings | null = null;
	private controller: UsageController | null = null;
	private indicator: InstanceType<typeof UsageIndicator> | null = null;
	private desktopCard: DesktopCard | null = null;

	enable(): void {
		this.settings = this.getSettings();
		this.controller = new UsageController(this.settings);

		this.settings.connectObject('changed::show-panel', () => this.syncSurfaces(), this);
		this.settings.connectObject('changed::show-desktop-widget', () => this.syncSurfaces(), this);
		this.settings.connectObject(
			'changed::desktop-position',
			() => this.recreateDesktopCard(),
			this,
		);
		for (const key of ['panel-box', 'panel-index']) {
			this.settings.connectObject(`changed::${key}`, () => this.recreateIndicator(), this);
		}
		// Display-only keys redraw the cached snapshot; refetching on every change
		// runs into the usage endpoint's rate limit. A new refresh interval takes
		// effect after the next poll.
		for (const key of [
			'panel-primary',
			'panel-secondary',
			'panel-reset',
			'panel-icon',
			'show-used',
			'warning-remaining',
			'critical-remaining',
		]) {
			this.settings.connectObject(`changed::${key}`, () => this.controller?.redraw(), this);
		}
		// A new source is a deliberate switch, so it is fetched from right away.
		this.settings.connectObject(
			'changed::direct-requests',
			() => void this.controller?.refresh(),
			this,
		);
		this.settings.connectObject(
			'changed::show-insights',
			() => {
				this.controller?.redraw();
				// Hidden reports are not requested, so showing one may need a first run.
				void this.controller?.refreshInsights();
			},
			this,
		);

		this.syncSurfaces();
		this.controller.start();
	}

	disable(): void {
		this.indicator?.destroy();
		this.indicator = null;
		this.desktopCard?.destroy();
		this.desktopCard = null;
		this.controller?.destroy();
		this.controller = null;
		releaseClockSettings();

		this.settings?.disconnectObject(this);
		this.settings = null;
	}

	private syncSurfaces(): void {
		if (!this.settings || !this.controller) {
			return;
		}

		const showPanel = this.settings.get_boolean('show-panel');
		if (showPanel && !this.indicator) {
			this.indicator = new UsageIndicator(this.controller, this.settings, this.path, () =>
				this.openPreferences(),
			);
			const index = this.settings.get_uint('panel-index');
			Main.panel.addToStatusArea(
				this.uuid,
				this.indicator,
				index,
				this.settings.get_string('panel-box') as 'left' | 'center' | 'right',
			);
			// Indicators added later, such as tray icons, take the slot; move back.
			const container = this.indicator.container;
			const box = container.get_parent();
			box?.connectObject(
				'child-added',
				() => {
					const target = Math.min(index, box.get_n_children() - 1);
					if (box.get_children().indexOf(container) !== target) {
						box.set_child_at_index(container, target);
					}
				},
				this.indicator,
			);
		} else if (!showPanel && this.indicator) {
			this.indicator.destroy();
			this.indicator = null;
		}

		const showDesktop = this.settings.get_boolean('show-desktop-widget');
		if (showDesktop && !this.desktopCard) {
			try {
				this.desktopCard = new DesktopCard(this.controller, this.settings, () =>
					this.openPreferences(),
				);
			} catch (error) {
				logError(
					error instanceof Error ? error : new Error(String(error)),
					'Vibecheck could not create the desktop card',
				);
				Main.notifyError(_('Vibecheck'), _('The desktop card could not be shown.'));
			}
		} else if (!showDesktop && this.desktopCard) {
			this.desktopCard.destroy();
			this.desktopCard = null;
		}
	}

	private recreateIndicator(): void {
		this.indicator?.destroy();
		this.indicator = null;
		this.syncSurfaces();
	}

	private recreateDesktopCard(): void {
		this.desktopCard?.destroy();
		this.desktopCard = null;
		this.syncSurfaces();
	}
}
