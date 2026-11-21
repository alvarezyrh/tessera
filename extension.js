import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Tree, sameRect} from './tree.js';

const DIRECTIONS = ['left', 'right', 'up', 'down'];

// Tiling is only forced once a tree holds at least this many windows;
// a lone window is left alone.
const MIN_TILED = 2;

// Enforcement: at most MAX_ENFORCE_RETRIES re-placements per window within
// ENFORCE_WINDOW_MS, so apps with a minimum size cannot cause a loop.
const MAX_ENFORCE_RETRIES = 3;
const ENFORCE_WINDOW_MS = 1000;

const isMaximized = win => win.maximized_horizontally || win.maximized_vertically;

export default class TesseraExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._trees = new Map();      // Workspace -> Map(monitor index -> Tree)
        this._treeOf = new Map();     // Meta.Window -> Tree
        this._winSignals = new Map(); // Meta.Window -> signal ids
        this._floating = new Set();   // windows the user excluded from tiling
        this._fresh = new Set();      // windows placed for the first time (no animation)
        this._grab = null;            // active mouse/keyboard grab: {win, moving, resizing}

        this._retries = new Map();    // Meta.Window -> enforce attempts in the current window
        this._idles = new Map();      // Meta.Window -> pending idle source id
        this._timeouts = new Set();   // retry-reset timeout source ids

        this._signals = [];           // [object, signal id]
        this._keys = [];              // registered keybinding names

        this._connectSignals();
        this._trackExistingWindows();
        this._bindKeys();
    }

    disable() {
        this._keys.forEach(name => Main.wm.removeKeybinding(name));
        this._signals.forEach(([obj, id]) => obj.disconnect(id));
        this._winSignals.forEach((ids, win) => ids.forEach(id => win.disconnect(id)));
        this._treeOf.forEach((_tree, win) => this._resetActor(win));
        this._idles.forEach(id => GLib.source_remove(id));
        this._timeouts.forEach(id => GLib.source_remove(id));

        this._settings = null;
        this._trees = this._treeOf = this._winSignals = null;
        this._floating = this._fresh = this._grab = null;
        this._retries = this._idles = this._timeouts = null;
        this._signals = this._keys = null;
    }

    // ───────────────────────── setup ─────────────────────────

    _connectSignals() {
        const {window_manager: wm, display, workspace_manager: wsm} = global;
        this._connect(wm, 'map', (_, actor) => this._track(actor.meta_window, true));
        this._connect(display, 'grab-op-begin', (_, win, op) => this._grabBegin(win, op));
        this._connect(display, 'grab-op-end', () => this._grabEnd());
        this._connect(display, 'workareas-changed', () => this._relayoutAll(false));
        this._connect(Main.layoutManager, 'monitors-changed', () => this._resyncAll());
        this._connect(wsm, 'workspace-removed', (_, ws) => this._trees.delete(ws));
        this._connect(this._settings, 'changed::gap', () => this._relayoutAll(true));
    }

    _trackExistingWindows() {
        for (const actor of global.get_window_actors())
            this._track(actor.meta_window, false);
        this._relayoutAll(false);
    }

    _bindKeys() {
        for (const dir of DIRECTIONS) {
            this._bind(`focus-${dir}`, () => this._focus(dir));
            this._bind(`swap-${dir}`, () => this._swap(dir));
            this._bind(`resize-${dir}`, () => this._resizeDivider(dir), Meta.KeyBindingFlags.NONE);
        }
        this._bind('toggle-float', () => this._toggleFloat());
    }

    _connect(obj, signal, callback) {
        this._signals.push([obj, obj.connect(signal, callback)]);
    }

    _bind(name, callback, flags = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT) {
        Main.wm.addKeybinding(name, this._settings, flags, Shell.ActionMode.NORMAL, callback);
        this._keys.push(name);
    }

    get _gap() { return this._settings.get_int('gap'); }
    get _duration() { return this._settings.get_int('animation-duration'); }

    // ───────────────────────── trees & window tracking ─────────────────────────

    _treeFor(workspace, monitor) {
        let byMonitor = this._trees.get(workspace);
        if (!byMonitor) this._trees.set(workspace, byMonitor = new Map());

        let tree = byMonitor.get(monitor);
        if (!tree) byMonitor.set(monitor, tree = new Tree(workspace, monitor));
        return tree;
    }

    _isTileable(win) {
        return win.get_window_type() === Meta.WindowType.NORMAL &&
            !win.is_skip_taskbar() &&
            !win.get_transient_for() &&
            !win.is_on_all_workspaces() &&
            !win.is_fullscreen() &&
            !win.minimized &&
            win.allows_resize() &&
            !this._floating.has(win);
    }

    _track(win, fresh) {
        if (!win || this._winSignals.has(win) || win.get_window_type() !== Meta.WindowType.NORMAL)
            return;

        const resync = () => { if (!this._grab) this._sync(win); };
        const onMaximize = () => {
            const tree = this._treeOf.get(win);
            if (tree && !this._grab) this._enforce(win, tree);
            else resync();
        };

        this._winSignals.set(win, [
            win.connect('unmanaging', () => this._untrack(win)),
            win.connect('workspace-changed', resync),
            win.connect('position-changed', () => this._onGeometry(win)),
            win.connect('size-changed', () => this._onGeometry(win)),
            win.connect('notify::fullscreen', resync),
            win.connect('notify::minimized', resync),
            win.connect('notify::maximized-horizontally', onMaximize),
        ]);

        if (fresh) this._fresh.add(win);
        this._sync(win);
    }

    _untrack(win) {
        this._winSignals.get(win)?.forEach(id => win.disconnect(id));
        this._winSignals.delete(win);
        this._floating.delete(win);
        this._fresh.delete(win);
        this._retries.delete(win);
        this._cancelIdle(win);
        this._detach(win);
    }

    // Make the tree membership of `win` match reality.
    _sync(win) {
        const workspace = win.get_workspace();
        const wanted = this._isTileable(win) && workspace;
        const target = wanted ? this._treeFor(workspace, win.get_monitor()) : null;
        const current = this._treeOf.get(win);
        if (current === target) return;

        if (current) this._detach(win);
        if (target) this._attach(win, target);
    }

    _attach(win, tree) {
        const focus = global.display.focus_window;
        const near = focus && focus !== win && tree.has(focus) ? focus : null;
        tree.insert(win, near);
        this._treeOf.set(win, tree);

        if (tree.size >= MIN_TILED)
            tree.windows().filter(isMaximized).forEach(w => w.unmaximize());
        this._relayout(tree);
    }

    _detach(win) {
        const tree = this._treeOf.get(win);
        if (!tree) return;

        tree.remove(win);
        this._treeOf.delete(win);
        this._resetActor(win);
        this._relayout(tree);
    }

    _resyncAll() {
        this._trees.clear();
        this._treeOf.clear();
        for (const win of this._winSignals.keys()) this._sync(win);
    }

    _onGeometry(win) {
        if (this._grab) {
            if (this._grab.win === win && this._grab.resizing) this._userResize(win);
            return;
        }

        const tree = this._treeOf.get(win);
        if (!tree) return;

        // Moved to another monitor by other means (e.g. Super+Shift+Arrow).
        if (tree.monitor !== win.get_monitor()) this._sync(win);
        else this._enforce(win, tree);
    }

    // ───────────────────────── enforcement ─────────────────────────

    // Force a tiled window back into its slot if something moved, resized
    // or maximized it.
    _enforce(win, tree) {
        if (tree.size < MIN_TILED) return;

        const maximized = isMaximized(win);
        const slot = tree.frameOf(tree.leafOf(win));
        if (maximized || !sameRect(slot, win.get_frame_rect()))
            this._scheduleEnforce(win, tree, maximized);
    }

    _scheduleEnforce(win, tree, unmaximize) {
        const attempts = this._retries.get(win) ?? 0;
        if (attempts >= MAX_ENFORCE_RETRIES || this._idles.has(win)) return;

        this._retries.set(win, attempts + 1);
        this._after(ENFORCE_WINDOW_MS, () => this._retries.delete(win));

        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idles.delete(win);
            if (this._treeOf.get(win) === tree && !this._grab) {
                if (unmaximize) win.unmaximize();
                this._relayout(tree, {animate: false});
            }
            return GLib.SOURCE_REMOVE;
        });
        this._idles.set(win, id);
    }

    _cancelIdle(win) {
        const id = this._idles.get(win);
        if (id === undefined) return;
        GLib.source_remove(id);
        this._idles.delete(win);
    }

    // One-shot timeout whose source is tracked so disable() can remove it.
    _after(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    // ───────────────────────── layout & animation ─────────────────────────

    _relayoutAll(animate) {
        for (const byMonitor of this._trees.values())
            for (const tree of byMonitor.values())
                this._relayout(tree, {animate});
    }

    _relayout(tree, {animate = true, skip = null} = {}) {
        if (!tree.size) return;

        const area = tree.workspace.get_work_area_for_monitor(tree.monitor);
        if (!area) return;
        tree.layout(area, this._gap);

        if (tree.size < MIN_TILED) {
            tree.windows().forEach(win => this._resetActor(win));
            return;
        }

        const visible = tree.workspace === global.workspace_manager.get_active_workspace();
        for (const {win, frame} of tree.entries()) {
            if (win === skip) continue;
            const isFresh = this._fresh.delete(win);
            this._place(win, frame, animate && visible && !isFresh);
        }
    }

    _place(win, target, animate) {
        const old = win.get_frame_rect();
        if (sameRect(old, target)) return;

        win.move_resize_frame(false, target.x, target.y, target.width, target.height);

        const actor = win.get_compositor_private();
        if (!actor) return;

        actor.remove_all_transitions();
        const canAnimate = animate && this._duration > 0 && actor.visible &&
            old.width > 0 && old.height > 0;
        if (!canAnimate) {
            this._resetActor(win);
            return;
        }
        this._animateFrom(win, actor, old, target);
    }

    // Start visually where the window was, then ease to the new frame.
    // The scale pivot is the actor's origin, so compensate for the shadow offset.
    _animateFrom(win, actor, old, target) {
        const buffer = win.get_buffer_rect();
        const offsetX = old.x - buffer.x, offsetY = old.y - buffer.y;
        const scaleX = old.width / target.width, scaleY = old.height / target.height;

        actor.set_pivot_point(0, 0);
        actor.set_scale(scaleX, scaleY);
        actor.set_translation(
            old.x - target.x + offsetX * (1 - scaleX),
            old.y - target.y + offsetY * (1 - scaleY),
            0);
        actor.ease({
            scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0,
            duration: this._duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _resetActor(win) {
        const actor = win.get_compositor_private?.();
        if (!actor) return;

        actor.remove_all_transitions();
        actor.set_scale(1, 1);
        actor.set_translation(0, 0, 0);
    }

    // ───────────────────────── mouse move / resize ─────────────────────────

    _grabBegin(win, op) {
        if (!win || !this._treeOf.has(win)) return;

        const moving = op === Meta.GrabOp.MOVING || op === Meta.GrabOp.KEYBOARD_MOVING;
        this._grab = {win, moving, resizing: !moving};
        this._resetActor(win);
    }

    _grabEnd() {
        const grab = this._grab;
        this._grab = null;

        const tree = grab && this._treeOf.get(grab.win);
        if (!tree) return;

        if (grab.moving) {
            // Dropped on another monitor: re-home the window.
            if (grab.win.get_monitor() !== tree.monitor) {
                this._sync(grab.win);
                return;
            }
            // Dropped on another tile: swap.
            const [x, y] = global.get_pointer();
            const other = tree.windowAt(x, y, grab.win);
            if (other) tree.swap(grab.win, other);
        }
        this._relayout(tree);
    }

    // Dragging an edge: translate it into divider ratios, neighbours follow live.
    _userResize(win) {
        const tree = this._treeOf.get(win);
        if (!tree?.applyUserResize(win, win.get_frame_rect())) return;
        this._relayout(tree, {animate: false, skip: win});
    }

    // ───────────────────────── keybinding actions ─────────────────────────

    _focused() {
        const win = global.display.focus_window;
        const tree = win && this._treeOf.get(win);
        return tree ? {win, tree} : null;
    }

    _focus(dir) {
        const focused = this._focused();
        const neighbor = focused?.tree.neighbor(focused.win, dir);
        neighbor?.activate(global.get_current_time());
    }

    _swap(dir) {
        const focused = this._focused();
        const neighbor = focused?.tree.neighbor(focused.win, dir);
        if (!neighbor) return;

        focused.tree.swap(focused.win, neighbor);
        this._relayout(focused.tree);
    }

    _resizeDivider(dir) {
        const focused = this._focused();
        if (focused?.tree.moveDivider(focused.win, dir))
            this._relayout(focused.tree);
    }

    _toggleFloat() {
        const win = global.display.focus_window;
        if (!win || win.get_window_type() !== Meta.WindowType.NORMAL) return;

        if (!this._floating.delete(win)) this._floating.add(win);
        this._sync(win);
    }
}
