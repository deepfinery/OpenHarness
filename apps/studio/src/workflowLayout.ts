export type LayoutNode = { id: string; x: number; y: number };
export type LayoutEdge = { from: string; to: string; label?: string };
export type NodeSize = { width: number; height: number };
type Point = { x: number; y: number };
type Group = NodeSize & { id: string; members: Map<string, Point>; rootHeight: number };

export function forwardFlowRoute(start: Point, end: Point, sourceRight: number, targetLeft: number) {
  if (targetLeft - sourceRight < 64 || Math.abs(start.y - end.y) < 1) return null;
  const lane = (sourceRight + targetLeft) / 2;
  return {
    path: `M ${start.x} ${start.y} L ${lane} ${start.y} L ${lane} ${end.y} L ${end.x} ${end.y}`,
    label: { x: lane, y: (start.y + end.y) / 2 },
  };
}

/** Route connections to later tool rows through a side gutter, leaving earlier
 * tool cards clear. The first row uses the designer's ordinary curved edges. */
export function toolRowRoute(start: Point, end: Point, peers: Array<Point & { width: number }>) {
  if (!peers.length || end.y <= Math.min(...peers.map((peer) => peer.y)) + 1 || end.y <= start.y) return null;
  const rail =
    end.x < start.x
      ? Math.min(...peers.map((peer) => peer.x)) - 24
      : Math.max(...peers.map((peer) => peer.x + peer.width)) + 24;
  return {
    path: `M ${start.x} ${start.y} L ${start.x} ${start.y + 24} L ${rail} ${start.y + 24} L ${rail} ${end.y - 24} L ${end.x} ${end.y - 24} L ${end.x} ${end.y}`,
    label: { x: end.x, y: end.y - 24 },
  };
}

/** Layer the graph using entire agent/tool footprints, not just the agent card.
 * Back edges are excluded only from ranking; the workflow itself is untouched.
 */
export function layoutWorkflow<T extends LayoutNode>(
  nodes: T[],
  edges: LayoutEdge[],
  sizeOf: (node: T) => NodeSize,
  startAt?: string,
): T[] {
  if (!nodes.length) return nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sizes = new Map(nodes.map((node) => [node.id, sizeOf(node)]));
  const incoming = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  const outgoing = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  const validEdges = edges.filter((edge) => byId.has(edge.from) && byId.has(edge.to));
  validEdges.forEach((edge) => {
    incoming.get(edge.to)!.add(edge.from);
    outgoing.get(edge.from)!.add(edge.to);
  });

  // Only private leaf tools belong below an agent. Shared tools and tools that
  // participate in execution remain graph nodes, so they are positioned once.
  const owner = new Map<string, string>();
  validEdges.forEach((edge) => {
    if (
      edge.label === 'tool' &&
      edge.to !== startAt &&
      edge.from !== edge.to &&
      incoming.get(edge.to)!.size === 1 &&
      outgoing.get(edge.to)!.size === 0 &&
      !validEdges.some((other) => other.to === edge.to && other.label !== 'tool')
    ) {
      owner.set(edge.to, edge.from);
    }
  });
  const groups = new Map<string, Group>();
  nodes
    .filter((node) => !owner.has(node.id))
    .forEach((node) => {
      const root = sizes.get(node.id)!;
      const tools = nodes.filter((tool) => owner.get(tool.id) === node.id);
      const rows: T[][] = [];
      for (let i = 0; i < tools.length; i += 3) rows.push(tools.slice(i, i + 3));
      const rowWidths = rows.map(
        (row) => row.reduce((sum, tool) => sum + sizes.get(tool.id)!.width, 0) + (row.length - 1) * 48,
      );
      const width = Math.max(root.width, ...rowWidths);
      const members = new Map<string, Point>([[node.id, { x: (width - root.width) / 2, y: 0 }]]);
      let bottom = root.height;
      rows.forEach((row, index) => {
        const top = bottom + (index === 0 ? 72 : 48);
        let left = (width - rowWidths[index]) / 2;
        row.forEach((tool) => {
          members.set(tool.id, { x: left, y: top });
          left += sizes.get(tool.id)!.width + 48;
        });
        bottom = top + Math.max(...row.map((tool) => sizes.get(tool.id)!.height));
      });
      groups.set(node.id, { id: node.id, width, height: bottom, rootHeight: root.height, members });
    });

  const next = new Map([...groups.keys()].map((id) => [id, new Set<string>()]));
  const adjacent = new Map([...groups.keys()].map((id) => [id, new Set<string>()]));
  validEdges.forEach((edge) => {
    const from = owner.get(edge.from) ?? edge.from;
    const to = owner.get(edge.to) ?? edge.to;
    if (from === to) return;
    next.get(from)!.add(to);
    adjacent.get(from)!.add(to);
    adjacent.get(to)!.add(from);
  });
  const roots = [...groups.keys()];
  if (startAt && groups.has(startAt)) {
    roots.splice(roots.indexOf(startAt), 1);
    roots.unshift(startAt);
  }
  const seen = new Set<string>();
  const positions = new Map<string, Point>();
  let componentTop = 80;

  roots.forEach((root) => {
    if (seen.has(root)) return;
    const component = [root];
    seen.add(root);
    for (let i = 0; i < component.length; i++) {
      adjacent.get(component[i])!.forEach((id) => {
        if (!seen.has(id)) {
          seen.add(id);
          component.push(id);
        }
      });
    }

    // DFS marks feedback edges in cyclic workflows. Topological longest-path
    // ranks then keep every remaining transition moving left to right.
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const forward = new Map(component.map((id) => [id, new Set<string>()]));
    const parents = new Map(component.map((id) => [id, new Set<string>()]));
    const postorder: string[] = [];
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visiting.add(id);
      next.get(id)!.forEach((child) => {
        if (visiting.has(child)) return;
        forward.get(id)!.add(child);
        parents.get(child)!.add(id);
        visit(child);
      });
      visiting.delete(id);
      visited.add(id);
      postorder.push(id);
    };
    component.forEach(visit);
    const rank = new Map(component.map((id) => [id, 0]));
    postorder.reverse().forEach((id) =>
      forward.get(id)!.forEach((child) => {
        rank.set(child, Math.max(rank.get(child)!, rank.get(id)! + 1));
      }),
    );
    const layers: string[][] = [];
    component.forEach((id) => (layers[rank.get(id)!] ??= []).push(id));

    // Alternating barycenter sweeps reduce crossings at both splits and joins.
    const order = new Map<string, number>();
    const rememberOrder = (layer: string[]) =>
      layer.forEach((id, i) => order.set(id, (i + 0.5) / layer.length));
    layers.forEach(rememberOrder);
    for (let pass = 0; pass < 8; pass++) {
      const neighbors = pass % 2 === 0 ? parents : forward;
      const sweep = pass % 2 === 0 ? layers : [...layers].reverse();
      sweep.forEach((layer) => {
        const barycenter = (id: string) => {
          const linked = [...neighbors.get(id)!];
          return linked.length
            ? linked.reduce((sum, neighbor) => sum + order.get(neighbor)!, 0) / linked.length
            : order.get(id)!;
        };
        layer.sort((a, b) => barycenter(a) - barycenter(b) || order.get(a)! - order.get(b)!);
        rememberOrder(layer);
      });
    }

    const local = new Map<string, Point>();
    let left = 80;
    layers.forEach((layer) => {
      let top = 0;
      layer.forEach((id) => {
        local.set(id, { x: left, y: top });
        top += groups.get(id)!.height + 96;
      });
      left += Math.max(...layer.map((id) => groups.get(id)!.width)) + 160;
    });
    // Align connected cards while projecting each layer back to non-overlapping
    // group rectangles. Translation of a whole layer preserves its clearances.
    for (let pass = 0; pass < 6; pass++) {
      const neighbors = pass % 2 === 0 ? parents : forward;
      const sweep = pass % 2 === 0 ? layers : [...layers].reverse();
      sweep.forEach((layer) => {
        const desired = layer.map((id) => {
          const linked = [...neighbors.get(id)!];
          return linked.length
            ? linked.reduce(
                (sum, other) => sum + local.get(other)!.y + groups.get(other)!.rootHeight / 2,
                0,
              ) /
                linked.length -
                groups.get(id)!.rootHeight / 2
            : local.get(id)!.y;
        });
        let bottom = -Infinity;
        layer.forEach((id, i) => {
          local.get(id)!.y = Math.max(desired[i], bottom);
          bottom = local.get(id)!.y + groups.get(id)!.height + 96;
        });
        const shift = layer.reduce((sum, id, i) => sum + desired[i] - local.get(id)!.y, 0) / layer.length;
        layer.forEach((id) => {
          local.get(id)!.y += shift;
        });
      });
    }
    const minY = Math.min(...component.map((id) => local.get(id)!.y));
    let componentBottom = componentTop;
    component.forEach((id) => {
      const group = groups.get(id)!;
      const point = local.get(id)!;
      const y = point.y - minY + componentTop;
      group.members.forEach((offset, memberId) =>
        positions.set(memberId, { x: point.x + offset.x, y: y + offset.y }),
      );
      componentBottom = Math.max(componentBottom, y + group.height);
    });
    componentTop = componentBottom + 160;
  });
  return nodes.map((node) => ({ ...node, ...positions.get(node.id)! }));
}

/** Preserve hand-placed cards when an AI edit adds nodes, finding clear space
 * for new cards instead of mixing two layouts that can overlap each other. */
export function placeNewWorkflowNodes<T extends LayoutNode>(
  nodes: T[],
  existing: LayoutNode[],
  sizeOf: (node: T) => NodeSize,
): T[] {
  const saved = new Map(existing.map((node) => [node.id, node]));
  const positioned = nodes
    .filter((node) => saved.has(node.id))
    .map((node) => ({ ...node, x: saved.get(node.id)!.x, y: saved.get(node.id)!.y }));
  nodes
    .filter((node) => !saved.has(node.id))
    .forEach((node) => {
      const point = { ...node };
      const size = sizeOf(node);
      let collision: T | undefined;
      do {
        collision = positioned.find((other) => {
          const otherSize = sizeOf(other);
          return (
            point.x < other.x + otherSize.width + 48 &&
            point.x + size.width + 48 > other.x &&
            point.y < other.y + otherSize.height + 48 &&
            point.y + size.height + 48 > other.y
          );
        });
        if (collision) point.y = collision.y + sizeOf(collision).height + 48;
      } while (collision);
      positioned.push(point);
    });
  const positions = new Map(positioned.map((node) => [node.id, node]));
  return nodes.map((node) => positions.get(node.id)!);
}
