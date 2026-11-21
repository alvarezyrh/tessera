// Pure layout logic (no Shell imports): a binary-space-partition tree.
// Every split has a ratio, so dividers can be moved freely.

export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const sameRect = (a, b) =>
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const inset = (r, d) => ({
    x: r.x + d, y: r.y + d,
    width: Math.max(1, r.width - 2 * d), height: Math.max(1, r.height - 2 * d),
});

class Node {
    constructor() {
        this.parent = null;
        this.win = null;        // leaf only
        this.dir = 'h';         // split only: 'h' = side by side, 'v' = stacked
        this.ratio = 0.5;
        this.a = null;
        this.b = null;
        this.rect = {x: 0, y: 0, width: 0, height: 0};
    }
    get isLeaf() { return this.win !== null; }
}

export class Tree {
    constructor(workspace, monitor) {
        this.workspace = workspace;
        this.monitor = monitor;
        this.root = null;
        this._leaves = new Map(); // win -> leaf
    }

    get size() { return this._leaves.size; }
    has(win) { return this._leaves.has(win); }
    leafOf(win) { return this._leaves.get(win) ?? null; }
    windows() { return [...this._leaves.keys()]; }

    insert(win, nearWin = null) {
        const leaf = new Node();
        leaf.win = win;
        this._leaves.set(win, leaf);
        if (!this.root) {
            this.root = leaf;
            return;
        }
        let target = nearWin ? this._leaves.get(nearWin) : null;
        if (!target) { // fall back to the biggest tile
            for (const l of this._leaves.values()) {
                if (l === leaf) continue;
                if (!target || l.rect.width * l.rect.height > target.rect.width * target.rect.height)
                    target = l;
            }
        }
        const split = new Node();
        split.dir = target.rect.width >= target.rect.height ? 'h' : 'v';
        split.rect = {...target.rect};
        split.parent = target.parent;
        this._replace(target, split);
        split.a = target;
        split.b = leaf;
        target.parent = split;
        leaf.parent = split;
    }

    remove(win) {
        const leaf = this._leaves.get(win);
        if (!leaf) return;
        this._leaves.delete(win);
        const p = leaf.parent;
        if (!p) { this.root = null; return; }
        const sibling = p.a === leaf ? p.b : p.a;
        sibling.parent = p.parent;
        this._replace(p, sibling);
    }

    swap(w1, w2) {
        const l1 = this._leaves.get(w1), l2 = this._leaves.get(w2);
        if (!l1 || !l2) return;
        l1.win = w2; l2.win = w1;
        this._leaves.set(w1, l2);
        this._leaves.set(w2, l1);
    }

    _replace(oldNode, newNode) {
        const p = oldNode.parent === newNode ? newNode.parent : oldNode.parent;
        if (!p) this.root = newNode;
        else if (p.a === oldNode) p.a = newNode;
        else p.b = newNode;
    }

    // Compute rects. `gap` is the space between tiles AND around the screen edge.
    layout(area, gap) {
        if (!this.root) return;
        this.gap = gap;
        this._layout(this.root, inset(area, gap / 2));
    }

    _layout(n, rect) {
        n.rect = rect;
        if (n.isLeaf) return;
        const {x, y, width, height} = rect;
        if (n.dir === 'h') {
            const aw = Math.round(width * n.ratio);
            this._layout(n.a, {x, y, width: aw, height});
            this._layout(n.b, {x: x + aw, y, width: width - aw, height});
        } else {
            const ah = Math.round(height * n.ratio);
            this._layout(n.a, {x, y, width, height: ah});
            this._layout(n.b, {x, y: y + ah, width, height: height - ah});
        }
    }

    // Final frame (with gap applied) for a leaf.
    frameOf(leaf) {
        const r = inset(leaf.rect, (this.gap ?? 0) / 2);
        return {x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height)};
    }

    entries() {
        return [...this._leaves.entries()].map(([win, leaf]) => ({win, frame: this.frameOf(leaf)}));
    }

    // The user dragged window edges: translate that into divider ratios.
    applyUserResize(win, fr) {
        const leaf = this._leaves.get(win);
        if (!leaf) return false;
        const t = this.frameOf(leaf);
        const dl = fr.x - t.x, dr = fr.x + fr.width - (t.x + t.width);
        const dt = fr.y - t.y, db = fr.y + fr.height - (t.y + t.height);
        const half = (this.gap ?? 0) / 2;
        const eq = (a, b) => Math.abs(a - b) <= 1;
        const L = leaf.rect;
        let changed = false;

        for (let n = leaf; n.parent; n = n.parent) {
            const p = n.parent, inA = p.a === n;
            let boundary = null;
            if (p.dir === 'h') {
                if (inA && Math.abs(dr) > 1 && eq(L.x + L.width, n.rect.x + n.rect.width))
                    boundary = fr.x + fr.width + half - p.rect.x;
                else if (!inA && Math.abs(dl) > 1 && eq(L.x, n.rect.x))
                    boundary = fr.x - half - p.rect.x;
                if (boundary !== null) p.ratio = clamp(boundary / p.rect.width, MIN_RATIO, MAX_RATIO);
            } else {
                if (inA && Math.abs(db) > 1 && eq(L.y + L.height, n.rect.y + n.rect.height))
                    boundary = fr.y + fr.height + half - p.rect.y;
                else if (!inA && Math.abs(dt) > 1 && eq(L.y, n.rect.y))
                    boundary = fr.y - half - p.rect.y;
                if (boundary !== null) p.ratio = clamp(boundary / p.rect.height, MIN_RATIO, MAX_RATIO);
            }
            if (boundary !== null) changed = true;
        }
        return changed;
    }

    // Keyboard: move the nearest divider on the given axis next to `win`.
    moveDivider(win, direction, step = 0.04) {
        const leaf = this._leaves.get(win);
        if (!leaf) return false;
        const axis = direction === 'left' || direction === 'right' ? 'h' : 'v';
        const sign = direction === 'right' || direction === 'down' ? 1 : -1;
        for (let n = leaf; n.parent; n = n.parent) {
            if (n.parent.dir === axis) {
                n.parent.ratio = clamp(n.parent.ratio + sign * step, MIN_RATIO, MAX_RATIO);
                return true;
            }
        }
        return false;
    }

    neighbor(win, direction) {
        const leaf = this._leaves.get(win);
        if (!leaf) return null;
        const r = leaf.rect, e = 2;
        let best = null, bestScore = Infinity;
        for (const [w, l] of this._leaves) {
            if (l === leaf) continue;
            const c = l.rect;
            const vOverlap = Math.min(r.y + r.height, c.y + c.height) - Math.max(r.y, c.y);
            const hOverlap = Math.min(r.x + r.width, c.x + c.width) - Math.max(r.x, c.x);
            let dist, overlap;
            switch (direction) {
            case 'left': dist = r.x - (c.x + c.width); overlap = vOverlap; break;
            case 'right': dist = c.x - (r.x + r.width); overlap = vOverlap; break;
            case 'up': dist = r.y - (c.y + c.height); overlap = hOverlap; break;
            default: dist = c.y - (r.y + r.height); overlap = hOverlap;
            }
            if (dist < -e || overlap <= 0) continue;
            const score = dist * 10000 - overlap;
            if (score < bestScore) { bestScore = score; best = w; }
        }
        return best;
    }

    windowAt(x, y, except = null) {
        for (const [w, l] of this._leaves) {
            if (w === except) continue;
            const r = l.rect;
            if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) return w;
        }
        return null;
    }
}
