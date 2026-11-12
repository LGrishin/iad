/* Deterministic compound diagrams. Layout never depends on a playback position. */
(function (root) {
  'use strict';
  function layout(nodes, expanded = new Set(), options = {}) {
    const settings = options.layout || {}, opened = expanded instanceof Set ? expanded : new Set(expanded);
    const order = new Map((options.rootOrder || []).map((id, i) => [id, i]));
    const children = new Map(), sizes = new Map(), plans = new Map(), boxes = [];
    const byId = new Map(nodes.map(node => [node.id, node]));
    for (const node of nodes) {
      const parent = node.parent || null;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(node);
    }
    const roots = [...(children.get(null) || [])].sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
    const cardWidth = Math.max(240, settings.cardWidth ?? 285), cardHeight = 118, headerHeight = 80, padding = 64;
    const columnGap = settings.columnGap ?? 145, rowGap = settings.rowGap ?? 140;
    // The old childGap described a vertical list. Internal diagrams need the
    // same routing corridors as the outer map, including on narrow screens.
    const innerColumnGap = Math.max(80, columnGap), innerRowGap = Math.max(80, rowGap);
    const requestedColumns = Math.max(1, Math.floor(settings.columns || 4));
    const rootColumns = options.viewportWidth < 650 ? Math.min(2, requestedColumns) : requestedColumns;
    // A few independent cards or a path/forest need only one column. Work with
    // the complete static graph, projected onto the siblings of this diagram,
    // so playback and opening a deeper child do not change the chosen topology.
    function compactTopology(items, parent) {
      if (!Array.isArray(options.edges) || items.length > 5) return null;
      const ids = new Set(items.map(node => node.id));
      const adjacent = new Map(items.map(node => [node.id, new Set()])), pairs = new Set();
      const outgoing = new Map(items.map(node => [node.id, new Set()]));
      const sibling = id => {
        const seen = new Set(); let node = byId.get(id);
        while (node && !seen.has(node.id)) {
          if ((node.parent || null) === parent) return ids.has(node.id) ? node.id : null;
          seen.add(node.id); node = byId.get(node.parent);
        }
        return null;
      };
      for (const edge of options.edges) {
        const from = sibling(edge.from), to = sibling(edge.to);
        if (!from || !to || from === to) continue;
        pairs.add([from, to].sort().join('\0'));
        adjacent.get(from).add(to); adjacent.get(to).add(from); outgoing.get(from).add(to);
      }
      if (pairs.size > Math.max(0, items.length - 1) || [...adjacent.values()].some(peers => peers.size > 2)) return null;
      // A cycle in one component can coexist with an isolated card, so checking
      // only the global edge count is insufficient.
      const visited = new Set();
      function cyclic(id, previous) {
        if (visited.has(id)) return true;
        visited.add(id);
        for (const peer of adjacent.get(id)) if (peer !== previous && cyclic(peer, id)) return true;
        return false;
      }
      for (const node of items) if (!visited.has(node.id) && cyclic(node.id, null)) return null;
      const index = new Map(items.map((node, i) => [node.id, i])), result = [], remaining = new Set(ids);
      while (remaining.size) {
        const first = [...remaining][0], component = new Set(), collect = id => {
          if (component.has(id)) return;
          component.add(id); for (const peer of adjacent.get(id)) collect(peer);
        };
        collect(first);
        const ends = [...component].filter(id => adjacent.get(id).size < 2).sort((a,b) =>
          Number(outgoing.get(b).size > 0) - Number(outgoing.get(a).size > 0) || index.get(a) - index.get(b));
        let at = ends[0];
        while (at !== undefined) {
          result.push(byId.get(at)); remaining.delete(at);
          at = [...adjacent.get(at)].find(peer => remaining.has(peer));
        }
      }
      return result;
    }
    function grid(items, columns, horizontalGap, verticalGap) {
      const count = Math.min(columns, items.length), widths = Array(count).fill(0), heights = [];
      items.forEach((node, index) => {
        const size = sizes.get(node.id), column = index % columns, row = Math.floor(index / columns);
        widths[column] = Math.max(widths[column], size.w);
        heights[row] = Math.max(heights[row] || 0, size.h);
      });
      const offsets = (values, gap) => values.map((_, index) => values.slice(0, index).reduce((sum, value) => sum + value + gap, 0));
      return {items, columns, widths, heights, xs: offsets(widths, horizontalGap), ys: offsets(heights, verticalGap),
        w: widths.reduce((sum, value) => sum + value, 0) + Math.max(0, widths.length - 1) * horizontalGap,
        h: heights.reduce((sum, value) => sum + value, 0) + Math.max(0, heights.length - 1) * verticalGap};
    }
    function measure(node, visiting = new Set()) {
      if (visiting.has(node.id)) throw new Error(`Cyclic diagram hierarchy at ${node.id}`);
      const nested = opened.has(node.id) ? children.get(node.id) || [] : [];
      let size = {w: cardWidth, h: cardHeight};
      if (nested.length) {
        const next = new Set([...visiting, node.id]);
        nested.forEach(child => measure(child, next));
        const compact = compactTopology(nested, node.id);
        const columns = compact ? 1 : Math.min(4, Math.max(nested.length > 1 ? 2 : 1, Math.ceil(Math.sqrt(nested.length))));
        const plan = grid(compact || nested, columns, innerColumnGap, compact ? settings.rowGap ?? 76 : innerRowGap);
        plan.padding = compact ? 48 : padding;
        plans.set(node.id, plan);
        size = {w: Math.max(cardWidth, plan.w + 2 * plan.padding), h: headerHeight + plan.h + 2 * plan.padding};
      }
      sizes.set(node.id, size);
      return size;
    }
    roots.forEach(node => measure(node));
    const compactRoots = Object.prototype.hasOwnProperty.call(settings, 'columns') ? null : compactTopology(roots, null);
    const rootItems = compactRoots && !options.rootOrder?.length ? compactRoots : roots;
    const rootPlan = grid(rootItems, compactRoots ? 1 : rootColumns, columnGap, compactRoots ? settings.rowGap ?? 76 : rowGap);
    function place(node, x, y, depth, ancestors) {
      const size = sizes.get(node.id), nested = opened.has(node.id) ? children.get(node.id) || [] : [], group = nested.length > 0;
      const box = {id: node.id, parent: node.parent || null, x, y, ...size, depth, ancestors, group, headerHeight: group ? headerHeight : cardHeight};
      if (group) box.contentBounds = {x: x + 24, y: y + headerHeight + 20, w: size.w - 48, h: size.h - headerHeight - 44};
      boxes.push(box);
      if (group) {
        const plan = plans.get(node.id);
        plan.items.forEach((child, index) => place(child, x + plan.padding + plan.xs[index % plan.columns], y + headerHeight + plan.padding + plan.ys[Math.floor(index / plan.columns)], depth + 1, [...ancestors, node.id]));
      }
    }
    rootPlan.items.forEach((node, index) => place(node, rootPlan.xs[index % rootPlan.columns], rootPlan.ys[Math.floor(index / rootPlan.columns)], 0, []));
    return {boxes, dimensions: {w: Math.max(1, rootPlan.w), h: Math.max(1, rootPlan.h)}};
  }
  root.IADLayout = {layout};
  if (typeof module !== 'undefined') module.exports = root.IADLayout;
})(globalThis);
