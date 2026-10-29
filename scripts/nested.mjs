import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const uuid = 'vibecheck@selfref.dev';

run('pnpm', ['dev:install']);

// Without the DevKit viewer the shell runs headless and shows nothing.
if (!['/usr/lib/mutter-devkit', '/usr/libexec/mutter-devkit'].some((path) => existsSync(path))) {
	console.error('Mutter DevKit is not installed (Arch: mutter-devkit, Ubuntu: mutter-dev-bin)');
	process.exit(1);
}

// A private dconf database keeps the nested session from enabling the
// extension, or changing its settings, in the desktop you are working in.
// It persists between runs; `pnpm clean` resets it.
const config = resolve(root, 'build/nested');
await mkdir(config, { recursive: true });
const shell = spawnSync(
	'dbus-run-session',
	[
		'--',
		'sh',
		'-c',
		`gsettings set org.gnome.shell enabled-extensions "['${uuid}']" && exec gnome-shell --devkit --wayland`,
	],
	{
		cwd: root,
		// GTK's default Vulkan renderer never presents a frame on the nested
		// compositor, so the preferences window would stay invisible. Apps the
		// session bus starts, such as the preferences, inherit this.
		env: { ...process.env, XDG_CONFIG_HOME: config, GSK_RENDERER: 'gl' },
		stdio: 'inherit',
	},
);
process.exit(shell.status ?? 1);

function run(command, args) {
	const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}
