import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { formatMessage } from '../domain/usage.js';
import type { UsageController, UsageState } from '../services/usage-controller.js';
import { createInsightsContent } from './insights-content.js';
import { createLimitContent } from './limit-content.js';
import { formatClockTime, localizedError } from './localization.js';

export class DesktopCard {
	private readonly actor: St.BoxLayout;
	private readonly title: St.Label;
	private readonly content: St.BoxLayout;
	private readonly menu: PopupMenu.PopupMenu;
	private readonly menuManager: PopupMenu.PopupMenuManager;
	private readonly unsubscribe: () => void;
	private positionSourceId: number | null = null;
	private backgroundGroup: Meta.BackgroundGroup | null;

	constructor(
		controller: UsageController,
		private readonly settings: Gio.Settings,
		openPreferences: () => void,
	) {
		// The card belongs above the wallpaper and below every application window,
		// so it lives inside the wallpaper's own container rather than beside it.
		// Mutter restacks the window group itself on every stacking change and
		// moves the actors it owns around any foreign sibling, which would float
		// the card above the windows; it never reorders inside the background
		// group. Locating that group by its public type keeps the same parent the
		// shell uses without reaching for LayoutManager's private field. It is
		// looked up first so a failure leaves nothing behind.
		this.backgroundGroup =
			global.window_group
				?.get_children()
				.find((child): child is Meta.BackgroundGroup => child instanceof Meta.BackgroundGroup) ??
			null;
		if (!this.backgroundGroup) {
			throw new Error('The GNOME Shell background group is unavailable');
		}

		this.actor = new St.BoxLayout({
			// Reactive only for its context menu. Below every window, it can only be
			// clicked where the desktop shows.
			reactive: true,
			can_focus: false,
			width: 300,
			orientation: Clutter.Orientation.VERTICAL,
			style_class: 'vibecheck-desktop-card',
		});
		this.title = new St.Label({
			text: _('Claude plan'),
			style_class: 'vibecheck-desktop-title',
		});
		this.content = new St.BoxLayout({
			orientation: Clutter.Orientation.VERTICAL,
			style_class: 'vibecheck-desktop-content',
		});
		this.actor.add_child(this.title);
		this.actor.add_child(this.content);
		this.backgroundGroup.add_child(this.actor);
		this.raiseAboveWallpaper();

		Main.layoutManager.connectObject(
			'monitors-changed',
			() => {
				// A monitor change rebuilds the wallpaper actors in this same group.
				this.raiseAboveWallpaper();
				this.position();
			},
			this.actor,
		);

		// The same pattern as the desktop's own menu: anchored to the layout
		// manager's dummy cursor, which is moved to wherever the click landed.
		this.menu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor, 0, St.Side.TOP);
		const refreshItem = new PopupMenu.PopupMenuItem(_('Refresh now'));
		refreshItem.connectObject('activate', () => void controller.refresh(), this.actor);
		this.menu.addMenuItem(refreshItem);
		const preferencesItem = new PopupMenu.PopupMenuItem(_('Preferences'));
		preferencesItem.connectObject('activate', openPreferences, this.actor);
		this.menu.addMenuItem(preferencesItem);
		Main.layoutManager.uiGroup.add_child(this.menu.actor);
		this.menu.actor.hide();
		// The manager drops the menu by itself when the menu is destroyed.
		this.menuManager = new PopupMenu.PopupMenuManager(this.actor);
		this.menuManager.addMenu(this.menu);
		this.actor.connectObject(
			'button-release-event',
			(_actor: St.BoxLayout, event: Clutter.Event) => {
				if (event.get_button() !== Clutter.BUTTON_SECONDARY) {
					return Clutter.EVENT_PROPAGATE;
				}
				const [x, y] = event.get_coords();
				this.openMenu(x, y);
				return Clutter.EVENT_STOP;
			},
			this.actor,
		);

		this.unsubscribe = controller.subscribe((state) => this.render(state));
	}

	/** Opens the card's menu at a stage position, as a right-click does. */
	openMenu(x: number, y: number): void {
		Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
		this.menu.open(BoxPointer.PopupAnimation.FULL);
	}

	destroy(): void {
		this.unsubscribe();
		this.menu.destroy();
		Main.layoutManager.disconnectObject(this.actor);
		this.backgroundGroup = null;
		if (this.positionSourceId !== null) {
			GLib.Source.remove(this.positionSourceId);
			this.positionSourceId = null;
		}
		this.actor.destroy();
	}

	private render(state: Readonly<UsageState>): void {
		this.content.destroy_all_children();
		if (state.snapshot) {
			const updated = formatClockTime(state.snapshot.fetchedAt);
			const title = formatMessage(
				_('%s · updated %s'),
				state.planLabel ?? _('Claude plan'),
				updated,
			);
			this.title.text = state.stale ? formatMessage(_('%s · stale'), title) : title;
		} else {
			this.title.text = _('Claude plan');
		}

		if (!state.snapshot) {
			const message = new St.Label({
				text: state.renewing
					? _('Renewing the Claude session…')
					: state.loading
						? _('Loading…')
						: state.errorCode
							? localizedError(state.errorCode)
							: _('Data unavailable'),
				style_class: 'vibecheck-desktop-empty',
			});
			// Error messages run longer than the card is wide; wrap them in full.
			message.clutter_text.line_wrap = true;
			message.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
			this.content.add_child(message);
			this.queuePosition();
			return;
		}

		const used = this.settings.get_boolean('show-used');
		for (const limit of state.snapshot.limits) {
			this.content.add_child(createLimitContent(limit, used));
		}
		const insights = this.settings.get_string('show-insights');
		if (state.insights?.length && (insights === 'both' || insights === 'card')) {
			this.content.add_child(createInsightsContent(state.insights));
		}
		this.queuePosition();
	}

	/** Keeps the card on top of the wallpaper actors sharing its container. */
	private raiseAboveWallpaper(): void {
		this.backgroundGroup?.set_child_above_sibling(this.actor, null);
	}

	private queuePosition(): void {
		if (this.positionSourceId !== null) {
			return;
		}
		this.positionSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
			this.positionSourceId = null;
			this.position();
			return GLib.SOURCE_REMOVE;
		});
	}

	private position(): void {
		const monitor = Main.layoutManager.primaryMonitor ?? Main.layoutManager.monitors[0];
		if (!monitor) {
			return;
		}
		const margin = 28;
		const cardWidth = 300;
		const [, naturalHeight] = this.actor.get_preferred_height(cardWidth);
		const cardHeight = Math.max(this.actor.height, naturalHeight, 140);
		const position = this.settings.get_string('desktop-position');
		const left = monitor.x + margin;
		const right = monitor.x + monitor.width - cardWidth - margin;
		const top = monitor.y + margin + Main.panel.height;
		const bottom = monitor.y + monitor.height - cardHeight - margin;

		let x: number;
		let y: number;
		switch (position) {
			case 'top-left':
				x = left;
				y = top;
				break;
			case 'bottom-left':
				x = left;
				y = bottom;
				break;
			case 'bottom-right':
				x = right;
				y = bottom;
				break;
			default:
				x = right;
				y = top;
				break;
		}

		if (this.actor.x !== x || this.actor.y !== y) {
			this.actor.set_position(x, y);
		}
	}
}
