# Tessera

Dynamic tiling for GNOME Shell 49–50 (Wayland and X11).

- Binary-split layout: a new window splits the focused tile.
- Tiling is forced as soon as 2 or more windows share a workspace and monitor;
  a lone window is left alone. Tiled windows that get moved, resized or
  maximized are pushed back into their slot.
- 8px gaps between windows and at screen edges (configurable).
- Drag any edge or corner to resize; neighbours follow live.
- Drag a window onto another tile to swap them.
- Animated transitions (configurable).

## Keybindings

| Keys                   | Action                    |
|------------------------|---------------------------|
| Super+Alt+Arrows       | Focus neighbour           |
| Super+Alt+Shift+Arrows | Swap with neighbour       |
| Super+Ctrl+Arrows      | Move divider              |
| Super+T                | Toggle floating           |

## Install

Requirements: GNOME Shell 49–50, `gnome-extensions` CLI (ships with GNOME Shell), and
`glib-compile-schemas` (package `glib2` on Fedora/Arch, `libglib2.0-bin` on Debian/Ubuntu)
plus `make`.

**From a release zip** (no build tools needed):

```sh
gnome-extensions install --force tessera@tessera.local.shell-extension.zip
```

**From source:**

```sh
git clone <repo-url> && cd tessera
make install      # compiles schemas, symlinks into ~/.local/share/gnome-shell/extensions
make enable       # after the shell has seen the extension
```

On Wayland, log out and back in the first time so the shell discovers the
extension. On X11 you can reload with `Alt+F2`, `r`, `Enter`.

Other targets: `make schemas`, `make pack` (build the zip), `make uninstall`, `make disable`.

Settings (gap, animation duration): `gnome-extensions prefs tessera@tessera.local`.
After editing `extension.js` or `tree.js`, reload the shell session to apply
changes. After editing the schema XML, run `make schemas`.

## Architecture

```
extension.js   Shell integration: signals, window tracking, animation, keybindings
tree.js        Pure layout logic (no Shell imports): the BSP tree
prefs.js       Preferences window (libadwaita)
schemas/       GSettings schema: gap, animation-duration, keybindings
```

**`tree.js`** — one `Tree` per (workspace, monitor). Leaves hold windows;
inner nodes are splits (`h` side-by-side, `v` stacked) with a `ratio`.
`layout(area, gap)` computes every node's rectangle, and `frameOf(leaf)` insets
it by half a gap to get the final window frame. It also translates user edge
drags into ratio changes (`applyUserResize`), and answers neighbour and
hit-test queries. It has no GNOME dependencies.

**`extension.js`** — `TesseraExtension` glues the tree to the compositor:

1. *Tracking*: each normal window is connected to signals; `_sync` keeps its
   tree membership equal to `_isTileable` (not floating, fullscreen, minimized,
   transient, etc.).
2. *Layout*: `_relayout` runs `tree.layout` and moves windows with
   `move_resize_frame`. It only places windows when the tree has at least
   `MIN_TILED` (2) windows. `_place` animates by scaling the actor from its old
   frame to the new one.
3. *Enforcement*: on geometry or maximize changes, `_enforce` re-places a window
   that left its slot, at most 3 times per second per window so apps with a
   minimum size cannot loop.
4. *Input*: grabs map mouse resize to divider ratios and drop-on-tile to swap;
   keybindings drive focus, swap, divider moves and floating.

## Development

- Constants worth knowing: `MIN_TILED` (windows needed before tiling is forced)
  and `MAX_ENFORCE_RETRIES` / `ENFORCE_WINDOW_MS` at the top of `extension.js`.
- Watch logs with `journalctl -f -o cat /usr/bin/gnome-shell`.
- Nested session for testing: `dbus-run-session gnome-shell --devkit` (GNOME 49+).
