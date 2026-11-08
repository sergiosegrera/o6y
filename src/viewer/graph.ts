/** The viewer's local graph: an object and its neighbourhood, drawn on a grid of characters. */
import type { Store } from "../core/store.ts";
import { type Line, type Seg, truncate } from "./model.ts";

export interface LocalNode {
  id: string;
  hop: number;
  parent?: string;
}

const COLORS = ["cyan", "green", "yellow", "magenta", "blue", "red"];
const LIST_MAX = 80;

/** The most connected node, for when nothing is selected yet. */
export function busiest(adj: Map<string, Set<string>>): string | undefined {
  let best: string | undefined;
  for (const [id, near] of adj) if (!best || near.size > adj.get(best)!.size || (near.size === adj.get(best)!.size && id < best)) best = id;
  return best;
}

/** Breadth-first from `center`, the best-connected neighbours first. */
export function localGraph(adj: Map<string, Set<string>>, center: string, depth: number): LocalNode[] {
  if (!adj.has(center)) return [];
  const out: LocalNode[] = [{ id: center, hop: 0 }];
  const seen = new Set([center]);
  let edge = [center];
  for (let hop = 1; hop <= depth && out.length < LIST_MAX; hop++) {
    const next: string[] = [];
    for (const from of edge) {
      const near = [...(adj.get(from) ?? [])].filter((id) => !seen.has(id)).sort((a, b) => adj.get(b)!.size - adj.get(a)!.size || a.localeCompare(b));
      for (const id of near) {
        if (out.length >= LIST_MAX) break;
        seen.add(id);
        out.push({ id, hop, parent: from });
        next.push(id);
      }
    }
    edge = next;
  }
  return out;
}

const typeColor = (store: Store) => {
  const types = [...store.types.keys()].sort();
  return (id: string) => (store.objects.has(id) ? COLORS[types.indexOf(id.split("/")[0]!) % COLORS.length] : "red");
};

/** One row of the list beside the graph. */
export function graphLine(store: Store, node: LocalNode, adj: Map<string, Set<string>>, width: number, selected: boolean): Line {
  const color = typeColor(store)(node.id);
  const lead = node.hop === 0 ? "◉ " : `${"  ".repeat(node.hop - 1)}· `;
  const count = ` ${adj.get(node.id)?.size ?? 0}`;
  const name = truncate(node.id, Math.max(4, width - lead.length - count.length));
  return [
    { text: lead, color },
    { text: name, bold: selected || node.hop === 0, inverse: selected, color: selected ? "cyan" : undefined },
    { text: count.padStart(width - lead.length - name.length), dim: true },
  ];
}

interface Cell {
  ch: string;
  style: Omit<Seg, "text">;
  label: boolean;
}

/** Draws the neighbourhood: centre in the middle, each hop on a wider ring. Lines fit `width`×`height`. */
export function renderLocalGraph(store: Store, nodes: LocalNode[], adj: Map<string, Set<string>>, selected: string | undefined, width: number, height: number): Line[] {
  const rows = Math.max(3, height - 1);
  const grid: (Cell | undefined)[][] = Array.from({ length: rows }, () => Array<Cell | undefined>(width).fill(undefined));
  const color = typeColor(store);
  const room = Math.max(4, Math.floor(rows * 0.8));
  const picked = selected && nodes.findIndex((n) => n.id === selected) >= room ? [...nodes.slice(0, room - 1), nodes.find((n) => n.id === selected)!] : nodes.slice(0, room);
  const depth = Math.max(...picked.map((n) => n.hop), 1);
  const rings = depth === 1 ? [0, 0.4] : [0, 0.24, 0.38, 0.47];
  const cx = (width - 1) / 2;
  const cy = (rows - 1) / 2;
  const angle = new Map<string, number>();
  const place = new Map<string, { x: number; y: number }>();
  const put = (id: string, a: number, ring: number) => {
    angle.set(id, a);
    place.set(id, { x: Math.round(cx + Math.cos(a) * ring * (width - 2)), y: Math.round(cy + Math.sin(a) * ring * (rows - 1)) });
  };
  put(picked[0]!.id, 0, 0);
  const first = picked.filter((n) => n.hop === 1);
  first.forEach((n, i) => put(n.id, (i / first.length) * Math.PI * 2 - Math.PI / 2, rings[1]!));
  for (const hop of [2, 3]) {
    const level = picked.filter((n) => n.hop === hop);
    const groups = new Map<string, LocalNode[]>();
    for (const n of level) groups.set(n.parent!, [...(groups.get(n.parent!) ?? []), n]);
    for (const [parent, kids] of groups) {
      const spread = Math.min(0.45, (Math.PI * 2) / Math.max(1, first.length) / Math.max(1, kids.length));
      kids.forEach((n, k) => put(n.id, (angle.get(parent) ?? 0) + spread * (k - (kids.length - 1) / 2), rings[hop]!));
    }
  }

  const drawn = new Set(place.keys());
  const line = (a: { x: number; y: number }, b: { x: number; y: number }, on: boolean) => {
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
    for (let i = 1; i < steps; i++) {
      const x = Math.round(a.x + ((b.x - a.x) * i) / steps);
      const y = Math.round(a.y + ((b.y - a.y) * i) / steps);
      const cell = grid[y]?.[x];
      if (y < 0 || y >= rows || x < 0 || x >= width || (cell && !on)) continue;
      grid[y]![x] = { ch: on ? "•" : "·", style: on ? { color: "cyan" } : { dim: true }, label: false };
    }
  };
  for (const id of drawn) for (const other of adj.get(id) ?? []) if (drawn.has(other) && id < other && id !== selected && other !== selected) line(place.get(id)!, place.get(other)!, false);
  if (selected && drawn.has(selected)) for (const other of adj.get(selected) ?? []) if (drawn.has(other)) line(place.get(selected)!, place.get(other)!, true);

  const fits = (x: number, y: number, len: number) => {
    if (y < 0 || y >= rows || x < 0 || x + len > width) return false;
    for (let i = Math.max(0, x - 1); i < Math.min(width, x + len + 1); i++) if (grid[y]![i]?.label) return false;
    return true;
  };
  const label = (id: string, center: boolean, isSelected: boolean) => {
    const p = place.get(id)!;
    const text = truncate(center ? id : id.slice(id.indexOf("/") + 1), center ? 34 : 20);
    const style: Cell["style"] = isSelected ? { inverse: true, bold: true, color: "cyan" } : center ? { bold: true, color: color(id) } : { color: color(id) };
    const decorated = isSelected || center ? ` ${text} ` : text;
    for (const dy of [0, -1, 1, -2, 2]) {
      for (const dx of [0, -6, 6, -12, 12]) {
        const x = Math.min(width - decorated.length, Math.max(0, p.x + dx - Math.floor(decorated.length / 2)));
        if (!fits(x, p.y + dy, decorated.length)) continue;
        [...decorated].forEach((ch, i) => (grid[p.y + dy]![x + i] = { ch, style, label: true }));
        return;
      }
    }
    if (p.y >= 0 && p.y < rows && p.x >= 0 && p.x < width && !grid[p.y]![p.x]?.label) grid[p.y]![p.x] = { ch: "●", style, label: true };
  };
  label(picked[0]!.id, true, picked[0]!.id === selected);
  if (selected && selected !== picked[0]!.id && drawn.has(selected)) label(selected, false, true);
  for (const n of picked.slice(1)) if (n.id !== selected) label(n.id, false, false);

  const lines: Line[] = grid.map((row) => {
    const segs: Line = [];
    let current: Seg | undefined;
    let key = "";
    for (const cell of row) {
      const k = JSON.stringify(cell?.style ?? null);
      if (!current || k !== key) {
        current = { text: "", ...(cell?.style ?? {}) };
        key = k;
        segs.push(current);
      }
      current.text += cell?.ch ?? " ";
    }
    return segs;
  });
  const hidden = nodes.length - picked.length;
  const note = `${nodes.length - 1} linked${hidden > 0 ? ` · ${hidden} only in the list` : ""}`;
  lines.push([{ text: truncate(note, width), dim: true }]);
  return lines;
}
