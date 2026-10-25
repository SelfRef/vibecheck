import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {
	ExtensionPreferences,
	gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { ClaudeAuth, launchLogin } from './services/claude-auth.js';
import { VibecheckError } from './services/errors.js';

const POSITIONS = ['top-right', 'top-left', 'bottom-right', 'bottom-left'] as const;
const PANEL_BOXES = ['left', 'center', 'right'] as const;
const PANEL_ICONS = ['none', 'color', 'mono'] as const;
const PANEL_LIMITS = ['five_hour', 'seven_day', 'lowest', 'none'] as const;
const PANEL_RESETS = ['five_hour', 'seven_day', 'both', 'none'] as const;
const INSIGHT_PLACES = ['both', 'menu', 'card', 'none'] as const;

const REPOSITORY = 'https://github.com/SelfRef/vibecheck';
const AUTHOR = 'SelfRef';
const ORIGINAL_AUTHOR = 'FabioSM46';
const DONATIONS = [
	['Ko-fi', 'https://ko-fi.com/N5E229GJPZ'],
	['GitHub Sponsors', 'https://github.com/sponsors/SelfRef'],
	['Liberapay', 'https://liberapay.com/SelfRef/donate'],
] as const;

export default class VibecheckPreferences extends ExtensionPreferences {
	async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
		const settings = this.getSettings();
		const page = new Adw.PreferencesPage({
			title: _('Vibecheck'),
			icon_name: 'network-transmit-receive-symbolic',
		});
		window.add(page);

		const appearance = new Adw.PreferencesGroup({
			title: _('Appearance'),
			description: _('Choose where to show remaining Claude capacity.'),
		});
		page.add(appearance);

		appearance.add(
			boundSwitch(
				settings,
				'show-panel',
				_('Panel indicator'),
				_('Show percentages in the GNOME top bar.'),
			),
		);
		appearance.add(
			boundCombo(
				settings,
				'panel-box',
				_('Panel area'),
				_('Part of the top bar that holds the indicator.'),
				PANEL_BOXES,
				[_('Left'), _('Center'), _('Right')],
			),
		);
		appearance.add(
			boundSpin(
				settings,
				'panel-index',
				_('Panel position'),
				_('0 places it before the other icons in the area.'),
				0,
				99,
				1,
			),
		);
		const panelLimitLabels = [
			_('Current session'),
			_('Weekly · all models'),
			_('Lowest remaining'),
			_('None'),
		];
		appearance.add(
			boundCombo(
				settings,
				'panel-primary',
				_('First panel value'),
				_('Remaining capacity shown first in the top bar.'),
				PANEL_LIMITS,
				panelLimitLabels,
			),
		);
		appearance.add(
			boundCombo(
				settings,
				'panel-secondary',
				_('Second panel value'),
				_('Shown after a slash, or None for a single value.'),
				PANEL_LIMITS,
				panelLimitLabels,
			),
		);
		appearance.add(
			boundCombo(
				settings,
				'panel-reset',
				_('Time until reset'),
				_('Shown after the percentages in the top bar.'),
				PANEL_RESETS,
				[_('Current session'), _('Weekly · all models'), _('Both'), _('None')],
			),
		);
		appearance.add(
			boundCombo(
				settings,
				'panel-icon',
				_('Panel icon'),
				_('Mono follows the top bar color.'),
				PANEL_ICONS,
				[_('None'), _('Color'), _('Mono')],
			),
		);
		appearance.add(
			boundCombo(
				settings,
				'show-insights',
				_('Usage contributors'),
				_('What drove usage on this machine over the last day and week, from Claude Code.'),
				INSIGHT_PLACES,
				[_('Menu and card'), _('Menu only'), _('Card only'), _('Hidden')],
			),
		);
		appearance.add(
			boundSwitch(
				settings,
				'show-desktop-widget',
				_('Desktop card'),
				_('Show a card below application windows. Right-click it to refresh.'),
			),
		);

		const positionRow = new Adw.ComboRow({
			title: _('Card position'),
			subtitle: _('Corner of the primary monitor.'),
			model: Gtk.StringList.new([
				_('Top right'),
				_('Top left'),
				_('Bottom right'),
				_('Bottom left'),
			]),
		});
		positionRow.selected = Math.max(
			0,
			POSITIONS.indexOf(settings.get_string('desktop-position') as (typeof POSITIONS)[number]),
		);
		positionRow.connect('notify::selected', () => {
			settings.set_string('desktop-position', POSITIONS[positionRow.selected] ?? 'top-right');
		});
		appearance.add(positionRow);

		const behavior = new Adw.PreferencesGroup({
			title: _('Updates and thresholds'),
		});
		page.add(behavior);
		behavior.add(
			boundSpin(
				settings,
				'refresh-interval',
				_('Refresh interval'),
				_('Minutes between usage requests.'),
				1,
				60,
				1,
			),
		);
		behavior.add(
			boundSpin(
				settings,
				'warning-remaining',
				_('Remaining capacity warning'),
				_('Use the warning color below this percentage.'),
				1,
				99,
				1,
			),
		);
		behavior.add(
			boundSpin(
				settings,
				'critical-remaining',
				_('Critical remaining capacity'),
				_('Use the critical color below this percentage.'),
				0,
				98,
				1,
			),
		);

		const source = new Adw.PreferencesGroup({
			title: _('Data source'),
			description: _('Sign-in is handled by the official Claude Code CLI.'),
		});
		page.add(source);

		const cliRow = new Adw.ActionRow({
			title: _('Claude Code'),
			subtitle: _('Checking…'),
		});
		source.add(cliRow);

		const directRow = boundSwitch(
			settings,
			'direct-requests',
			_('Request usage directly'),
			_(
				"Query Anthropic's usage endpoint with Claude Code's credentials instead of running Claude Code.",
			),
		);
		source.add(directRow);

		const loginRow = new Adw.ActionRow({
			title: _('Sign in or renew the session'),
			subtitle: _('Open Claude browser sign-in through Claude Code.'),
			visible: false,
		});
		const loginButton = new Gtk.Button({
			label: _('Sign in'),
			valign: Gtk.Align.CENTER,
			css_classes: ['suggested-action'],
		});
		loginButton.connect('clicked', () => {
			try {
				launchLogin();
			} catch (error) {
				if (!(error instanceof VibecheckError)) {
					throw error;
				}
				window.add_toast(
					new Adw.Toast({
						title:
							error.code === 'terminal-missing'
								? _('No compatible terminal was found to start Claude sign-in.')
								: _('Install Claude Code to authenticate.'),
					}),
				);
			}
		});
		loginRow.add_suffix(loginButton);
		loginRow.activatable_widget = loginButton;
		source.add(loginRow);

		const auth = new ClaudeAuth();
		let checking = false;
		const updateStatus = async () => {
			if (checking) {
				return;
			}
			checking = true;
			try {
				const status = await auth.status();
				cliRow.subtitle = !status.installed
					? _('Not installed. Usage is requested directly.')
					: status.loggedIn
						? _('Installed and signed in.')
						: _('Installed, not signed in.');
				// Without Claude Code there is nothing to choose and no one to sign in with.
				directRow.sensitive = status.installed;
				loginRow.visible = status.installed && !status.loggedIn;
			} finally {
				checking = false;
			}
		};
		void updateStatus();
		// Sign-in happens in a terminal, so check again when the user comes back.
		window.connect('notify::is-active', () => {
			if (window.is_active) {
				void updateStatus();
			}
		});
		window.connect('close-request', () => {
			auth.destroy();
			return false;
		});

		window.add(this.aboutPage(window));
	}

	private aboutPage(window: Adw.PreferencesWindow): Adw.PreferencesPage {
		const page = new Adw.PreferencesPage({
			title: _('About'),
			icon_name: 'help-about-symbolic',
		});

		const header = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			spacing: 6,
		});
		header.append(
			new Gtk.Image({
				gicon: Gio.icon_new_for_string(`${this.path}/icons/vibecheck-symbolic.svg`),
				pixel_size: 96,
				margin_bottom: 12,
			}),
		);
		header.append(new Gtk.Label({ label: _('Vibecheck'), css_classes: ['title-1'] }));
		const version = this.metadata['version-name'];
		if (version) {
			header.append(
				new Gtk.Label({
					label: _('Version %s').replace('%s', version),
					css_classes: ['dimmed'],
				}),
			);
		}
		header.append(
			new Gtk.Label({
				label: _('Unofficial and not affiliated with Anthropic.'),
				css_classes: ['caption', 'dimmed'],
				wrap: true,
				justify: Gtk.Justification.CENTER,
			}),
		);
		const headerGroup = new Adw.PreferencesGroup();
		headerGroup.add(header);
		page.add(headerGroup);

		const project = new Adw.PreferencesGroup({ title: _('Project') });
		page.add(project);
		project.add(linkRow(window, _('Author'), AUTHOR, `https://github.com/${AUTHOR}`));
		project.add(linkRow(window, _('Source code'), withoutScheme(REPOSITORY), REPOSITORY));
		project.add(
			linkRow(
				window,
				_('Report an issue'),
				withoutScheme(`${REPOSITORY}/issues`),
				`${REPOSITORY}/issues`,
			),
		);
		project.add(linkRow(window, _('License'), 'MIT', `${REPOSITORY}/blob/master/LICENSE`));
		project.add(
			linkRow(
				window,
				_('Credits'),
				_('Forked from Claudeland by %s').replace('%s', ORIGINAL_AUTHOR),
				`https://github.com/${ORIGINAL_AUTHOR}`,
			),
		);

		const support = new Adw.PreferencesGroup({
			title: _('Support development'),
			description: _(
				'Vibecheck is developed in my free time, mostly by burning through the very limits it tracks. If it saved you from a surprise rate limit, help me keep my Claude subscription paid.',
			),
		});
		page.add(support);
		for (const [name, uri] of DONATIONS) {
			support.add(linkRow(window, name, withoutScheme(uri), uri));
		}

		return page;
	}
}

function linkRow(
	window: Adw.PreferencesWindow,
	title: string,
	subtitle: string,
	uri: string,
): Adw.ActionRow {
	const row = new Adw.ActionRow({ title, subtitle, activatable: true });
	row.add_suffix(new Gtk.Image({ icon_name: 'adw-external-link-symbolic' }));
	row.connect('activated', () => {
		const launcher = new Gtk.UriLauncher({ uri });
		launcher.launch(window, null, (_source, result) => {
			try {
				launcher.launch_finish(result);
			} catch (error) {
				if (
					!(error instanceof GLib.Error) ||
					!error.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED)
				) {
					window.add_toast(new Adw.Toast({ title: _('Could not open the link.') }));
				}
			}
		});
	});
	return row;
}

function withoutScheme(uri: string): string {
	return uri.replace(/^https:\/\//, '');
}

function boundSwitch(
	settings: Gio.Settings,
	key: string,
	title: string,
	subtitle: string,
): Adw.ActionRow {
	const row = new Adw.SwitchRow({ title, subtitle });
	settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
	return row;
}

function boundCombo(
	settings: Gio.Settings,
	key: string,
	title: string,
	subtitle: string,
	values: readonly string[],
	labels: string[],
): Adw.ComboRow {
	const row = new Adw.ComboRow({ title, subtitle, model: Gtk.StringList.new(labels) });
	row.selected = Math.max(0, values.indexOf(settings.get_string(key)));
	row.connect('notify::selected', () => {
		settings.set_string(key, values[row.selected] ?? values[0]);
	});
	return row;
}

function boundSpin(
	settings: Gio.Settings,
	key: string,
	title: string,
	subtitle: string,
	lower: number,
	upper: number,
	step: number,
): Adw.ActionRow {
	const adjustment = new Gtk.Adjustment({
		lower,
		upper,
		step_increment: step,
		page_increment: step * 5,
	});

	const row = new Adw.SpinRow({ title, subtitle, adjustment, digits: 0 });
	settings.bind(key, adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
	return row;
}
