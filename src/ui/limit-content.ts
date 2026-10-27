import Clutter from 'gi://Clutter';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import {
	formatMessage,
	formatPercent,
	formatTimeRemaining,
	localizedLimitLabel,
	type UsageLimit,
} from '../domain/usage.js';

/** One limit as label, remaining or used value, meter, and reset time. */
export function createLimitContent(limit: UsageLimit, used: boolean): St.BoxLayout {
	const percent = used ? limit.consumedPercent : limit.remainingPercent;
	const content = new St.BoxLayout({
		x_expand: true,
		orientation: Clutter.Orientation.VERTICAL,
		style_class: 'vibecheck-limit-content',
	});
	const header = new St.BoxLayout({ x_expand: true });
	header.add_child(
		new St.Label({
			text: localizedLimitLabel(limit, _),
			x_expand: true,
			style_class: 'vibecheck-limit-label',
		}),
	);
	const value = new St.Label({
		text: formatMessage(used ? _('%s used') : _('%s remaining'), formatPercent(percent)),
		style_class: `vibecheck-limit-value vibecheck-${limit.severity}`,
	});
	header.add_child(value);
	content.add_child(header);

	const track = new St.BoxLayout({ style_class: 'vibecheck-progress-track' });
	const fill = new St.Widget({
		style_class: `vibecheck-progress-fill vibecheck-${limit.severity}`,
	});
	track.add_child(fill);
	const fraction = Math.min(100, Math.max(0, percent)) / 100;
	const updateFillWidth = () => {
		fill.width = Math.max(2, Math.round(track.width * fraction));
	};
	// A vertical BoxLayout stretches the track across the row. Derive the fill
	// from that allocated width instead of assuming the track stayed at its CSS
	// preferred width. This signal disappears with the track actor itself.
	track.connectObject('notify::width', updateFillWidth, fill);
	updateFillWidth();
	content.add_child(track);
	content.add_child(
		new St.Label({
			text: formatTimeRemaining(limit.resetsAt, new Date(), _),
			style_class: 'vibecheck-reset-label',
			// Dimmed rather than recolored, so it follows a light or dark menu.
			opacity: 180,
		}),
	);

	return content;
}
