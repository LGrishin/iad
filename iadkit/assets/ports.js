/* Semantic boundary connectors. Planning uses the complete model, never playback. */
(function (root) {
  'use strict';
  const STUB = 20, MARGIN = 25, SPACING = 24;
  function plan(model, boxes, visibleAncestor = id => id) {
    const byBox = new Map(boxes.map(box => [box.id, box]));
    const nodes = new Map((model.nodes || []).map(node => [node.id, node]));
    const contracts = new Map((model.contracts || []).map(contract => [contract.id, contract]));
    const portById = new Map();
    function within(id, ancestor) {
      const seen = new Set();
      while (nodes.has(id) && !seen.has(id)) {
        if (id === ancestor) return true;
        seen.add(id); id = nodes.get(id).parent;
      }
      return false;
    }
    function endpointContract(edge, end) {
      const explicit = edge[end === 'from' ? 'sourceContract' : 'targetContract'];
      if (explicit) return contracts.get(explicit) || null;
      const original = edge[end === 'from' ? 'originalFrom' : 'originalTo'] || edge[end];
      const other = edge[end === 'from' ? 'originalTo' : 'originalFrom'] || edge[end === 'from' ? 'to' : 'from'];
      // A shared enclosing contract describes context, not which endpoint
      // provides this interaction. Requiring an exclusive owner prevents both
      // siblings from being collapsed onto their common parent's API.
      const candidates = (edge.contracts || []).map(id => contracts.get(id)).filter(contract => contract && within(original, contract.node) && !within(other, contract.node));
      return candidates.length === 1 ? candidates[0] : null;
    }
    function describe(edge, end) {
      const original = edge[end === 'from' ? 'originalFrom' : 'originalTo'] || edge[end];
      const otherOriginal = edge[end === 'from' ? 'originalTo' : 'originalFrom'] || edge[end === 'from' ? 'to' : 'from'];
      const ownContract = endpointContract(edge, end), peerContract = endpointContract(edge, end === 'from' ? 'to' : 'from');
      const node = visibleAncestor(ownContract?.node || original), peer = visibleAncestor(peerContract?.node || otherOriginal), box = byBox.get(node);
      if (!box || !byBox.has(peer) || node === peer) return null;
      const contract = ownContract || peerContract;
      const kind = ownContract ? 'provided' : peerContract ? 'required' : 'connection';
      const internal = !!box.group && within(peer, node);
      const identity = contract ? contract.id : [edge.originalFrom || edge.from, edge.originalTo || edge.to].join('>');
      const id = JSON.stringify([node, kind, identity, internal ? 'internal' : 'boundary']);
      return {id, node, owner: ownContract?.node || original, contractOwner: contract?.node || null, kind, contract: contract?.id || null,
        label: contract?.name || 'Связь · API не указан', internal, peer, original};
    }
    function register(description, edge) {
      if (!description) return;
      let port = portById.get(description.id);
      if (!port) {
        port = {...description, peers: [], edgeIds: [], owners: [], connections: []};
        delete port.peer; delete port.original;
        portById.set(port.id, port);
      }
      if (!port.peers.includes(description.peer)) port.peers.push(description.peer);
      if (!port.owners.includes(description.original)) port.owners.push(description.original);
      if (port.kind === 'required' && port.owners.length > 1) port.owner = port.node;
      if (!port.edgeIds.includes(edge.id)) port.edgeIds.push(edge.id);
      const connection = {from: edge.originalFrom || edge.from, to: edge.originalTo || edge.to,
        label: edge.label || edge.title || '', sources: edge.sources || []};
      const existing = port.connections.find(item => item.from === connection.from && item.to === connection.to && item.label === connection.label);
      if (existing) existing.sources = [...new Set([...existing.sources, ...connection.sources])];
      else port.connections.push(connection);
    }
    const relationships = [...(model.edges || []), ...(model.scenarios || []).flatMap(scenario => scenario.steps || [])];
    for (const edge of relationships) for (const end of ['from', 'to']) register(describe(edge, end), edge);
    // Show a declared API even before it participates in a visible journey.
    // Hidden implementation contracts are projected only when actually used.
    for (const contract of contracts.values()) if (byBox.has(contract.node)) {
      const id = JSON.stringify([contract.node, 'provided', contract.id, 'boundary']);
      if (!portById.has(id)) portById.set(id, {id, node: contract.node, owner: contract.node, contractOwner: contract.node,
        kind: 'provided', contract: contract.id, label: contract.name, internal: false,
        peers: [], edgeIds: [], owners: [contract.node], connections: []});
    }
    const ports = [...portById.values()].sort((a, b) => a.id.localeCompare(b.id));
    const groups = new Map();
    for (const port of ports) {
      const box = byBox.get(port.node), center = {x: box.x + box.w / 2, y: box.y + box.h / 2};
      const peers = port.peers.map(id => byBox.get(id)).filter(Boolean);
      const dx = peers.reduce((sum, peer) => sum + peer.x + peer.w / 2 - center.x, 0);
      const dy = peers.reduce((sum, peer) => sum + peer.y + peer.h / 2 - center.y, 0);
      const preferred = port.internal ? 'bottom' : !peers.length ? 'right' : Math.abs(dy) >= Math.abs(dx) ? (dy >= 0 ? 'bottom' : 'top') : (dx >= 0 ? 'right' : 'left');
      const candidates = port.internal ? ['bottom'] : [preferred, ...['right', 'left', 'bottom', 'top'].filter(side => side !== preferred)];
      let side = candidates[0];
      for (const candidate of candidates) {
        const vertical = candidate === 'left' || candidate === 'right';
        const length = vertical ? box.h : box.w;
        const count = groups.get(`${port.node}:${port.internal}:${candidate}`)?.length || 0;
        if (count < Math.max(1, Math.floor((length - MARGIN * 2) / SPACING) + 1)) {side = candidate; break;}
      }
      port.side = side;
      const key = `${port.node}:${port.internal}:${side}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(port);
    }
    for (const group of groups.values()) group.forEach((port, index) => {
      const box = byBox.get(port.node), vertical = port.side === 'left' || port.side === 'right';
      const length = vertical ? box.h : box.w;
      const span = Math.min(Math.max(0, length - MARGIN * 2), (group.length - 1) * SPACING);
      const at = length / 2 + (group.length === 1 ? 0 : (index / (group.length - 1) - .5) * span);
      const x = vertical ? (port.side === 'left' ? box.x : box.x + box.w) : box.x + at;
      const y = vertical ? box.y + at : port.side === 'top' ? box.y : box.y + (port.internal ? box.headerHeight : box.h);
      const nx = port.side === 'left' ? -1 : port.side === 'right' ? 1 : 0;
      const ny = port.side === 'top' ? -1 : port.side === 'bottom' ? 1 : 0;
      Object.assign(port, {border: {x, y}, point: {x: x + nx * 3, y: y + ny * 3}, gate: {x: x + nx * STUB, y: y + ny * STUB},
        mark: vertical ? {x1: x, y1: y - 8, x2: x, y2: y + 8} : {x1: x - 8, y1: y, x2: x + 8, y2: y}, score: 0});
    });
    return {ports, attach(edges) {return edges.map(edge => {
      const originalFrom = edge.originalFrom || edge.from, originalTo = edge.originalTo || edge.to;
      return {...edge, originalFrom, originalTo,
        from: visibleAncestor(endpointContract(edge, 'from')?.node || originalFrom),
        to: visibleAncestor(endpointContract(edge, 'to')?.node || originalTo),
        sourceApiPort: portById.get(describe(edge, 'from')?.id) || null,
        targetApiPort: portById.get(describe(edge, 'to')?.id) || null};
    });}};
  }
  root.IADPorts = {plan};
  if (typeof module !== 'undefined') module.exports = root.IADPorts;
})(globalThis);
