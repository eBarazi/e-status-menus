import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

const POWER_BUS = 'org.gnome.SettingsDaemon.Power';
const POWER_PATH = '/org/gnome/SettingsDaemon/Power';
const POWER_IFACE = 'org.gnome.SettingsDaemon.Power.Screen';

// All subprocesses are argument arrays: no shell expansion or interpolation.
function command(argv) {
    return new Promise((resolve, reject) => {
        try {
            const proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, result) => {
                try {
                    const [, out, err] = p.communicate_utf8_finish(result);
                    if (!p.get_successful())
                        reject(new Error((err || out || `Exit ${p.get_exit_status()}`).trim()));
                    else
                        resolve((out || '').trim());
                } catch (e) { reject(e); }
            });
        } catch (e) { reject(e); }
    });
}

function powerProperty(method, variant, outType = null) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(POWER_BUS, POWER_PATH,
            'org.freedesktop.DBus.Properties', method, variant, outType,
            Gio.DBusCallFlags.NONE, 4000, null, (conn, result) => {
                try { resolve(conn.call_finish(result)); }
                catch (e) { reject(e); }
            });
    });
}

async function getBrightness() {
    const answer = await powerProperty('Get',
        new GLib.Variant('(ss)', [POWER_IFACE, 'Brightness']),
        new GLib.VariantType('(v)'));
    return answer.get_child_value(0).get_variant().get_int32();
}

async function setBrightness(value) {
    await powerProperty('Set', new GLib.Variant('(ssv)', [
        POWER_IFACE, 'Brightness', new GLib.Variant('i', value),
    ]));
}

function extractBatteryField(source, field) {
    const line = source.split('\n').find(l => l.trim().startsWith(`${field}:`));
    return line ? line.split(':').slice(1).join(':').trim() : null;
}

// nmcli escapes colons and backslashes in terse output.
function splitNmcli(line) {
    const fields = [];
    let value = '';
    let escape = false;
    for (const char of line) {
        if (escape) { value += char; escape = false; }
        else if (char === '\\') escape = true;
        else if (char === ':') { fields.push(value); value = ''; }
        else value += char;
    }
    fields.push(value);
    return fields;
}

const StatusButton = GObject.registerClass(
class StatusButton extends PanelMenu.Button {
    _init(kind, title, iconName, populate) {
        super._init(0.0, title, false);
        // GNOME's stock panel buttons have generous horizontal padding.
        // Tighten just these five indicators without changing the global panel.
        this.style = '-natural-hpadding: 4px; -minimum-hpadding: 2px;';
        this._alive = true;
        this._kind = kind;
        this._title = title;
        this._populate = populate;
        this._generation = 0;
        this._timer = 0;
        this._statusTimer = 0;
        this._statusBusy = false;

        this.icon = new St.Icon({icon_name: iconName, style_class: 'system-status-icon'});
        this.add_child(this.icon);
        // GNOME's popup manager will not open an empty menu.  Seed each
        // popup with an item BEFORE its first click, then load live content
        // when the menu actually opens.
        this.addLabel(this._title);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.addLabel('Click to load controls…');

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) this.refresh();
            else this._generation++;
        });

        // Icons must reflect the live system state even while menus are closed.
        // Never rebuild popup contents during this background sync.
        if (this._populate.status) {
            this.updateStatus();
            this._statusTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                this.updateStatus();
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    addItem(label, callback) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', () => {
            Promise.resolve().then(callback).catch(e => this.showError(e));
        });
        this.menu.addMenuItem(item);
        return item;
    }

    addLabel(label) {
        const item = new PopupMenu.PopupMenuItem(label, {reactive: false, can_focus: false});
        this.menu.addMenuItem(item);
        return item;
    }

    showError(error) {
        if (!this._alive) return;
        Main.notify('Separate Status Menus', String(error.message || error));
    }

    async run(argv, refresh = true) {
        try {
            await command(argv);
            // Update the panel icon as soon as the command finishes; do not
            // make the user reopen the popup to see the new state.
            await this.updateStatus();
            if (refresh && this._alive && this.menu.isOpen) this.refresh();
        } catch (e) { this.showError(e); }
    }

    async updateStatus() {
        if (!this._alive || !this._populate.status || this._statusBusy) return;
        this._statusBusy = true;
        try {
            const iconName = await this._populate.status();
            if (this._alive && iconName) this.icon.icon_name = iconName;
        } catch (e) {
            // Polling must not generate repeated desktop notifications when a
            // device or command is temporarily unavailable.
            log(`Separate Status Menus (${this._kind}): ${e}`);
        } finally {
            this._statusBusy = false;
        }
    }

    slider(initial, handler, onValueChanged = null) {
        const item = new PopupMenu.PopupBaseMenuItem({activate: false});
        const slider = new Slider.Slider(Math.max(0, Math.min(1, initial)));
        item.add_child(slider);
        slider.connect('notify::value', () => {
            const value = slider.value;
            // Keep the visible percentage in sync with the thumb immediately.
            if (onValueChanged) onValueChanged(value);
            // Collapse rapid pointer movement to avoid flooding D-Bus/processes.
            if (this._timer) GLib.Source.remove(this._timer);
            this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 110, () => {
                this._timer = 0;
                if (this._alive) Promise.resolve(handler(value)).catch(e => this.showError(e));
                return GLib.SOURCE_REMOVE;
            });
        });
        this.menu.addMenuItem(item);
        return item;
    }

    async refresh() {
        const gen = ++this._generation;
        this.menu.removeAll();
        this.addLabel(this._title);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.addLabel('Loading…');
        try {
            const data = await this._populate.load();
            if (!this._alive || gen !== this._generation || !this.menu.isOpen) return;
            this.menu.removeAll();
            this.addLabel(this._title);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._populate.render(this, data);
        } catch (e) {
            if (!this._alive || gen !== this._generation || !this.menu.isOpen) return;
            this.menu.removeAll();
            this.addLabel(this._title);
            this.addLabel(`Unavailable: ${e.message || e}`);
            this.addItem('Open system settings', () => command(['gnome-control-center', this._kind]));
        }
    }

    destroy() {
        this._alive = false;
        this._generation++;
        if (this._timer) { GLib.Source.remove(this._timer); this._timer = 0; }
        if (this._statusTimer) { GLib.Source.remove(this._statusTimer); this._statusTimer = 0; }
        super.destroy();
    }
});

const wifi = {
    status: async () => (await command(['nmcli', 'radio', 'wifi'])) === 'enabled'
        ? 'network-wireless-symbolic' : 'network-wireless-disabled-symbolic',
    load: async () => {
        const [radio, scan] = await Promise.all([
            command(['nmcli', 'radio', 'wifi']),
            command(['nmcli', '-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'no']),
        ]);
        return {enabled: radio === 'enabled', networks: scan.split('\n').filter(Boolean).map(splitNmcli)};
    },
    render: (button, data) => {
        button.icon.icon_name = data.enabled ? 'network-wireless-symbolic' : 'network-wireless-disabled-symbolic';
        button.addItem(data.enabled ? 'Turn Wi-Fi Off' : 'Turn Wi-Fi On',
            () => button.run(['nmcli', 'radio', 'wifi', data.enabled ? 'off' : 'on']));
        if (data.enabled) {
            button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const seen = new Set();
            for (const [active, ssid, signal, security] of data.networks) {
                if (!ssid || seen.has(ssid)) continue;
                seen.add(ssid);
                if (seen.size > 12) break;
                const secure = security && security !== '--';
                const label = `${active === '*' ? '✓ ' : ''}${ssid}  (${signal}%${secure ? ', secured' : ''})`;
                if (active === '*') button.addLabel(label);
                else button.addItem(label, async () => {
                    // Saved networks only: no password prompts inside Shell.
                    try {
                        await command(['nmcli', 'connection', 'up', 'id', ssid]);
                    } catch (e) {
                        if (!secure) await command(['nmcli', 'device', 'wifi', 'connect', ssid]);
                        else throw new Error(`Use Wi-Fi Settings to connect to ${ssid} (password or new profile required).`);
                    }
                    if (button._alive && button.menu.isOpen) button.refresh();
                });
            }
        }
        button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        button.addItem('Wi-Fi Settings…', () => command(['gnome-control-center', 'wifi']));
    },
};

const bluetooth = {
    status: async () => /^\s*Powered:\s*yes\s*$/m.test(await command(['bluetoothctl', 'show']))
        ? 'bluetooth-active-symbolic' : 'bluetooth-disabled-symbolic',
    load: async () => {
        const [info, paired] = await Promise.all([
            command(['bluetoothctl', 'show']),
            command(['bluetoothctl', 'devices', 'Paired']).catch(() => ''),
        ]);
        const enabled = /^\s*Powered:\s*yes\s*$/m.test(info);
        const devices = paired.split('\n').map(line => /^Device\s+([0-9a-fA-F:]{17})\s+(.+)$/.exec(line))
            .filter(Boolean).slice(0, 12).map(match => ({mac: match[1], name: match[2]}));
        return {enabled, devices};
    },
    render: (button, data) => {
        button.icon.icon_name = data.enabled ? 'bluetooth-active-symbolic' : 'bluetooth-disabled-symbolic';
        button.addItem(data.enabled ? 'Turn Bluetooth Off' : 'Turn Bluetooth On',
            () => button.run(['bluetoothctl', 'power', data.enabled ? 'off' : 'on']));
        if (data.enabled) {
            button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            if (!data.devices.length) button.addLabel('No paired devices');
            for (const device of data.devices)
                button.addItem(`Connect: ${device.name}`, () => button.run(['bluetoothctl', 'connect', device.mac]));
        }
        button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        button.addItem('Bluetooth Settings…', () => command(['gnome-control-center', 'bluetooth']));
    },
};

const battery = {
    load: () => command(['upower', '-i', '/org/freedesktop/UPower/devices/DisplayDevice']),
    render: (button, output) => {
        const pct = extractBatteryField(output, 'percentage') || 'Unknown';
        const state = extractBatteryField(output, 'state') || 'Unknown';
        const time = extractBatteryField(output, state === 'charging' ? 'time to full' : 'time to empty');
        button.icon.icon_name = state === 'charging' ? 'battery-good-charging-symbolic' : 'battery-good-symbolic';
        button.addLabel(`Charge: ${pct}`);
        button.addLabel(`State: ${state}`);
        if (time && time !== '0.0 seconds') button.addLabel(`Remaining: ${time}`);
        button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        button.addItem('Power Settings…', () => command(['gnome-control-center', 'power']));
    },
};

const sound = {
    status: async () => (await command(['wpctl', 'get-volume', '@DEFAULT_AUDIO_SINK@'])).includes('[MUTED]')
        ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic',
    load: async () => {
        const out = await command(['wpctl', 'get-volume', '@DEFAULT_AUDIO_SINK@']);
        const match = /Volume:\s*([\d.]+)/.exec(out);
        if (!match) throw new Error('Cannot read PipeWire output volume');
        return {volume: Number(match[1]), muted: out.includes('[MUTED]')};
    },
    render: (button, data) => {
        button.icon.icon_name = data.muted ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic';
        const volumeLabel = button.addLabel(`Output volume: ${Math.round(data.volume * 100)}%`);
        button.slider(data.volume, value => button.run(['wpctl', 'set-volume', '@DEFAULT_AUDIO_SINK@',
            `${Math.round(value * 100)}%`], false),
        value => { volumeLabel.label.text = `Output volume: ${Math.round(value * 100)}%`; });
        button.addItem(data.muted ? 'Unmute' : 'Mute',
            () => button.run(['wpctl', 'set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle']));
        button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        button.addItem('Sound Settings…', () => command(['gnome-control-center', 'sound']));
    },
};

const brightness = {
    load: getBrightness,
    render: (button, value) => {
        if (value < 0) {
            button.addLabel('No adjustable screen backlight detected');
        } else {
            const brightnessLabel = button.addLabel(`Brightness: ${value}%`);
            button.slider(value / 100, level => setBrightness(Math.round(level * 100)),
                level => { brightnessLabel.label.text = `Brightness: ${Math.round(level * 100)}%`; });
        }
        button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        button.addItem('Display Settings…', () => command(['gnome-control-center', 'display']));
    },
};

export default class MacStatusMenusExtension extends Extension {
    enable() {
        this._buttons = [];
        const definitions = [
            ['wifi', 'Wi-Fi', 'network-wireless-symbolic', wifi],
            ['bluetooth', 'Bluetooth', 'bluetooth-active-symbolic', bluetooth],
            ['battery', 'Battery', 'battery-good-symbolic', battery],
            ['sound', 'Sound', 'audio-volume-high-symbolic', sound],
            ['display', 'Brightness', 'display-brightness-symbolic', brightness],
        ];
        try {
            definitions.forEach(([kind, title, icon, populate], position) => {
                const button = new StatusButton(kind, title, icon, populate);
                Main.panel.addToStatusArea(`mac-status-${kind}`, button, position, 'right');
                this._buttons.push(button);
            });
        } catch (e) {
            this.disable();
            throw e;
        }
    }

    disable() {
        for (const button of this._buttons ?? []) button.destroy();
        this._buttons = null;
    }
}
