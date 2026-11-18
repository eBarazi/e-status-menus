# Separate Status Menus — GNOME Shell 48 (experimental)

Five separate top-bar popups: Wi-Fi, Bluetooth, Battery, Sound, Brightness.
Original GNOME Quick Settings is not changed or hidden.

## Requirements
- GNOME Shell **48.x**
- NetworkManager / `nmcli` for Wi-Fi
- BlueZ / `bluetoothctl` for Bluetooth
- UPower / `upower` for battery
- PipeWire / `wpctl` for sound
- GNOME Settings Daemon's GNOME 48 Power.Screen brightness D-Bus API
- GNOME Control Center (`gnome-control-center`) for advanced operations

## Install
From directory containing `e-status-menus-gnome48.zip`:

```bash
gnome-extensions install --force e-status-menus-gnome48.zip
```

**Log out and log back in** before enabling a newly installed local extension under Wayland.

```bash
gnome-extensions enable e-status-menus@local
gnome-extensions info e-status-menus@local
```

If upgrading an already loaded extension, log out and back in after installing the new ZIP.

## Removal / rollback

```bash
gnome-extensions disable e-status-menus@local
gnome-extensions uninstall e-status-menus@local
```

If an extension ever breaks GNOME Shell, disable it with another terminal/TTY, or turn off extensions from the Extensions application.


## Debug

```bash
journalctl --user -b | grep -Ei 'e-status-menus|gnome-shell|JS ERROR' | tail -80
```

Run these manually to check the system dependencies:

```bash
command -v nmcli bluetoothctl upower wpctl gnome-control-center
```
