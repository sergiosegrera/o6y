import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { displayPath } from "../core/render.ts";
import { type Layer, Store } from "../core/store.ts";
import {
  type Line,
  linkTree,
  parentKey,
  renderPage,
  renderTypePage,
  renderWantedPage,
  rowKey,
  treeLine,
  treeRows,
  truncate,
  typeKey,
  WANTED_KEY,
} from "./model.ts";
import { watchStores } from "./watch.ts";

export type View = "browse" | "tree";

/** UI state that survives suspending the viewer to run $EDITOR. */
export interface ViewerState {
  current?: string;
  view: View;
  history: string[];
  filter: string;
  /** Expanded headers in the browse list (`type:<name>`, `wanted:`); all start collapsed. */
  open?: string[];
}

interface Props {
  layers: Layer[];
  initial: ViewerState;
  onEdit: (path: string, state: ViewerState) => void;
}

const CHANGED_MS = 6000;

function LineView({ line }: { line: Line }) {
  return (
    <Text wrap="truncate">
      {line.length ? line.map((s, i) => (
        <Text key={i} color={s.color} bold={s.bold} italic={s.italic} dimColor={s.dim} inverse={s.inverse} underline={s.underline}>
          {s.text}
        </Text>
      )) : " "}
    </Text>
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function App({ layers, initial, onEdit }: Props) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [store, setStore] = useState(() => Store.load(layers));
  const [loadedAt, setLoadedAt] = useState(() => new Date());
  const [changed, setChanged] = useState<Map<string, number>>(new Map());
  const [view, setView] = useState<View>(initial.view);
  const [current, setCurrent] = useState<string | undefined>(initial.current);
  const [history, setHistory] = useState<string[]>(initial.history);
  const [focus, setFocus] = useState<"list" | "page">("list");
  const [linkIdx, setLinkIdx] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [filter, setFilter] = useState(initial.filter);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set(initial.open ?? []));
  /** Tree view: expanded node keys and the cursor key; reset when the root changes. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [treeCursor, setTreeCursor] = useState<string | undefined>();
  /** Tree state per root, so going back restores what was expanded. */
  const treeMemory = useRef(new Map<string, { expanded: Set<string>; cursor?: string }>());
  const lastIndex = useRef(0);

  // ── hot reload ──
  const reload = useCallback(() => {
    setStore((prev) => {
      const next = Store.load(layers);
      const now = Date.now();
      const fresh: string[] = [];
      for (const [id, obj] of next.objects) {
        const before = prev.objects.get(id);
        if (!before || before.mtimeMs !== obj.mtimeMs) fresh.push(id);
      }
      if (fresh.length) {
        setChanged((m) => {
          const copy = new Map([...m].filter(([, t]) => now - t < CHANGED_MS));
          for (const id of fresh) copy.set(id, now);
          return copy;
        });
      }
      return next;
    });
    setLoadedAt(new Date());
  }, [layers]);

  useEffect(() => watchStores(layers, reload), [layers, reload]);
  useEffect(() => {
    if (!changed.size) return;
    const t = setTimeout(() => setChanged((m) => new Map([...m].filter(([, at]) => Date.now() - at < CHANGED_MS))), 1000);
    return () => clearTimeout(t);
  }, [changed]);
  const changedIds = useMemo(() => new Set(changed.keys()), [changed]);

  // ── layout ──
  const bodyHeight = Math.max(3, rows - 2);
  const innerHeight = bodyHeight - 2;
  /** One pane at a time (list or page) below this width, e.g. in a side pane. */
  const narrow = columns < 80;
  const leftWidth = narrow ? columns - 2 : clamp(Math.floor(columns * 0.3), 24, 44);
  const rightWidth = narrow ? Math.max(10, columns - 4) : Math.max(10, columns - leftWidth - 6);

  // ── selection ──
  // `current` is a row key: an object or wanted id, `type:<name>` or `wanted:`.
  const tree = useMemo(() => treeRows(store, filter, open), [store, filter, open]);
  const keys = useMemo(() => tree.map(rowKey), [tree]);
  let cursor = current ? keys.indexOf(current) : -1;
  const exists = (key: string) =>
    key.startsWith("type:") ? store.types.has(key.slice(5)) : key === WANTED_KEY ? store.wanted.size > 0 : store.objects.has(key) || store.wanted.has(key);
  // In tree view the root may be hidden in the list; elsewhere fall back to a nearby row.
  const selected = current && exists(current) && (cursor >= 0 || view === "tree") ? current : undefined;
  if (!selected) cursor = keys.length ? clamp(lastIndex.current, 0, keys.length - 1) : -1;
  const selectedKey = selected ?? (cursor >= 0 ? keys[cursor] : undefined);
  const row = cursor >= 0 ? tree[cursor] : undefined;
  const isHeader = (key: string | undefined) => !!key && (key.startsWith("type:") || key === WANTED_KEY);
  /** The selected object or wanted page (undefined on a header). */
  const id = isHeader(selectedKey) ? undefined : selectedKey;
  if (cursor >= 0) lastIndex.current = cursor;

  // Selecting an object (following a link, going back) opens its group in the list.
  useEffect(() => {
    const parent = current ? parentKey(store, current) : undefined;
    if (parent && !open.has(parent)) setOpen((prev) => new Set(prev).add(parent));
  }, [current, store]);

  const toggle = (key: string, on: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const page = useMemo(() => {
    if (!selectedKey) return undefined;
    if (selectedKey.startsWith("type:")) return renderTypePage(store, selectedKey.slice(5), rightWidth);
    if (selectedKey === WANTED_KEY) return renderWantedPage(store, rightWidth);
    return renderPage(store, selectedKey, rightWidth, changedIds);
  }, [store, selectedKey, rightWidth, changedIds]);
  // The tree is rooted at the current object; the root starts expanded.
  const openKeys = useMemo(() => (id && !expanded.size ? new Set([id]) : expanded), [id, expanded]);
  const nodes = useMemo(() => (id && view === "tree" ? linkTree(store, id, openKeys) : []), [store, id, openKeys, view]);
  const nodeIndex = Math.max(0, nodes.findIndex((n) => n.key === treeCursor));
  const node = nodes[nodeIndex];

  const go = (target: string, push = true) => {
    if (target === selectedKey) return;
    if (push && selectedKey) setHistory((h) => [...h.slice(-49), selectedKey]);
    setCurrent(target);
    setLinkIdx(0);
    setScroll(0);
    if (id) treeMemory.current.set(id, { expanded, cursor: treeCursor });
    const saved = treeMemory.current.get(target);
    setExpanded(saved?.expanded ?? new Set());
    setTreeCursor(saved?.cursor);
    // Following a link to something hidden by the filter clears the filter.
    if (filter && !treeRows(store, filter).some((r) => rowKey(r) === target)) setFilter("");
  };
  const back = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    go(prev, false);
  };
  const moveList = (delta: number) => {
    if (!keys.length) return;
    const next = keys[clamp(cursor + delta, 0, keys.length - 1)]!;
    if (next !== selectedKey) {
      setCurrent(next);
      setLinkIdx(0);
      setScroll(0);
    }
  };
  const ensureVisible = (line: number) => {
    if (line < scroll) setScroll(line);
    else if (line >= scroll + innerHeight) setScroll(line - innerHeight + 1);
  };
  const maxScroll = Math.max(0, (page?.lines.length ?? 0) - innerHeight);
  const edit = () => {
    const obj = id ? store.objects.get(id) : undefined;
    if (!obj) return;
    onEdit(obj.path, { current: id, view, history, filter, open: [...open] });
    exit();
  };

  useInput((input, key) => {
    if (searching) {
      if (key.escape) {
        setSearching(false);
        setFilter("");
      } else if (key.return) setSearching(false);
      else if (key.backspace || key.delete) setFilter((f) => f.slice(0, -1));
      else if (key.downArrow) moveList(1);
      else if (key.upArrow) moveList(-1);
      else if (input && !key.ctrl && !key.meta) setFilter((f) => f + input);
      return;
    }
    // Several keys can arrive in one chunk (key repeat, paste).
    if (input.length > 1 && !key.ctrl && !key.meta) {
      if (input.startsWith("/")) {
        setSearching(true);
        setView("browse");
        setFocus("list");
        setFilter(input.slice(1));
        return;
      }
      if (/^[jk]+$/.test(input) && view === "browse" && focus === "list") {
        return moveList([...input].reduce((n, ch) => n + (ch === "j" ? 1 : -1), 0));
      }
      input = input[input.length - 1]!;
    }
    if (input === "q") return exit();
    if (input === "/") {
      setSearching(true);
      setView("browse");
      setFocus("list");
      return;
    }
    if (input === "t" || input === "g" || input === "2") {
      if (view !== "tree" && !id) return; // the tree starts from an object
      return setView(view === "tree" && input !== "2" ? "browse" : "tree");
    }
    if (input === "1") return setView("browse");
    if (input === "e") return edit();
    if (input === "r") return reload();
    if (input === "b" || key.backspace || key.delete) return back();

    if (view === "tree") {
      const toggle = (key: string, open: boolean) =>
        setExpanded((prev) => {
          const next = new Set(prev.size || !id ? prev : [id]);
          if (open) next.add(key);
          else next.delete(key);
          return next;
        });
      if (!node) return key.escape ? setView("browse") : undefined;
      if (key.downArrow || input === "j") setTreeCursor(nodes[Math.min(nodes.length - 1, nodeIndex + 1)]!.key);
      else if (key.upArrow || input === "k") setTreeCursor(nodes[Math.max(0, nodeIndex - 1)]!.key);
      else if (key.rightArrow || input === "l") {
        if (node.expandable && !node.expanded) toggle(node.key, true);
        else if (node.expanded) setTreeCursor(nodes[nodeIndex + 1]?.key);
      } else if (key.leftArrow || input === "h") {
        if (node.expanded) toggle(node.key, false);
        else if (node.depth > 0) setTreeCursor(node.key.slice(0, node.key.lastIndexOf(">")));
      } else if (input === " ") {
        if (node.expandable) toggle(node.key, !node.expanded);
      } else if (key.return) {
        if (node.depth > 0) go(node.id);
      } else if (input === "o" || key.tab) {
        if (node.id !== id) go(node.id);
        setView("browse");
        if (narrow) setFocus("page");
      } else if (input === "x") {
        setExpanded(new Set());
        setTreeCursor(undefined);
      } else if (key.escape) setView("browse");
      return;
    }

    if (key.tab) return setFocus(focus === "list" ? "page" : "list");

    // List headers: expand/collapse types (all start collapsed), jump between them.
    if (focus === "list" && !filter) {
      const header = row && (row.kind === "type" || row.kind === "wanted-header") ? row : undefined;
      const headerKey = header ? rowKey(header) : undefined;
      if (header && headerKey && (key.return || key.rightArrow || input === "l" || input === " ")) {
        if (!header.open) return toggle(headerKey, true);
        if (key.rightArrow || input === "l") return moveList(1);
        return toggle(headerKey, false);
      }
      if (key.leftArrow || input === "h") {
        if (header && headerKey && header.open) return toggle(headerKey, false);
        const parent = selectedKey ? parentKey(store, selectedKey) : undefined;
        if (parent) return setCurrent(parent);
        return;
      }
      if (input === "x") {
        const parent = selectedKey ? (parentKey(store, selectedKey) ?? selectedKey) : undefined;
        setOpen(new Set());
        if (parent) setCurrent(parent);
        return;
      }
      if (input === "X") return setOpen(new Set([...[...store.types.keys()].map(typeKey), WANTED_KEY]));
      if (input === "[" || input === "]") {
        const headers = tree.map((r, i) => [r, i] as const).filter(([r]) => r.kind === "type" || r.kind === "wanted-header");
        const target = input === "]" ? headers.find(([, i]) => i > cursor) : [...headers].reverse().find(([, i]) => i < cursor);
        if (target) setCurrent(rowKey(target[0]));
        return;
      }
    }

    if (key.pageDown || input === " " || (key.ctrl && input === "d")) return setScroll((s) => Math.min(maxScroll, s + innerHeight - 2));
    if (key.pageUp || (key.ctrl && input === "u")) return setScroll((s) => Math.max(0, s - innerHeight + 2));

    if (focus === "list") {
      if (key.downArrow || input === "j") moveList(1);
      else if (key.upArrow || input === "k") moveList(-1);
      else if (input === "J") setScroll((s) => Math.min(maxScroll, s + 1));
      else if (input === "K") setScroll((s) => Math.max(0, s - 1));
      else if (key.return || key.rightArrow || input === "l") {
        if (narrow) setFocus("page");
        else if (page?.links.length) {
          setFocus("page");
          ensureVisible(page.linkLines[linkIdx] ?? 0);
        }
      } else if (key.escape && filter) setFilter("");
      return;
    }

    // page focus: cycle links, follow with enter
    const n = page?.links.length ?? 0;
    if (key.escape || key.leftArrow || input === "h") setFocus("list");
    else if (input === "J" || ((key.downArrow || input === "j") && !n)) setScroll((s) => Math.min(maxScroll, s + 1));
    else if (input === "K" || ((key.upArrow || input === "k") && !n)) setScroll((s) => Math.max(0, s - 1));
    else if ((key.downArrow || input === "j") && n) {
      const i = (linkIdx + 1) % n;
      setLinkIdx(i);
      ensureVisible(page!.linkLines[i]!);
    } else if ((key.upArrow || input === "k") && n) {
      const i = (linkIdx - 1 + n) % n;
      setLinkIdx(i);
      ensureVisible(page!.linkLines[i]!);
    } else if (key.return && n) go(page!.links[linkIdx]!);
  });

  // ── header ──
  const errors = store.errors().length;
  const warnings = store.issues.filter((i) => i.severity === "warning").length;
  const stores = layers.map((l) => `${l.name} ${displayPath(l.root)}`).join("  ");
  const time = loadedAt.toLocaleTimeString([], { hour12: false });
  const header = (
    <Box width={columns}>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate">
          <Text inverse bold color="cyan"> o6y </Text>
          <Text> </Text>
          <Text inverse={view === "browse"} bold={view === "browse"}>{narrow ? " 1 " : " 1 browse "}</Text>
          <Text inverse={view === "tree"} bold={view === "tree"}>{narrow ? " 2 " : " 2 tree "}</Text>
          {narrow ? null : <Text dimColor>  {stores}</Text>}
        </Text>
      </Box>
      <Box flexShrink={0}>
        {narrow ? (
          <Text>
            <Text> {store.objects.size} · </Text>
            <Text color={errors ? "red" : "green"}>{errors}e</Text>
            <Text> </Text>
            <Text color={warnings ? "yellow" : undefined}>{warnings}w</Text>
            <Text dimColor> ⟳{time.slice(0, 5)}</Text>
            {changed.size ? <Text color="green"> •{changed.size}</Text> : null}
          </Text>
        ) : (
          <Text>
            <Text>  {store.objects.size} objects · {store.types.size} types · </Text>
            <Text color={errors ? "red" : "green"}>{errors} err</Text>
            <Text> · </Text>
            <Text color={warnings ? "yellow" : undefined}>{warnings} warn</Text>
            <Text dimColor> · ⟳ {time}</Text>
            {changed.size ? <Text color="green"> ({changed.size} changed)</Text> : null}
          </Text>
        )}
      </Box>
    </Box>
  );

  // ── footer ──
  const footerText = searching
    ? null
    : narrow
      ? view === "tree"
        ? "↑↓ · →← open/close · ⏎ root · o page · b"
        : focus === "list"
          ? "↑↓ · ⏎→ open · ← close · x/X all · [ ] · t · /"
          : "↑↓ link · ⏎ go · J/K␣ scroll · ← list · e edit"
      : view === "tree"
        ? "↑↓ move  →/l expand  ←/h collapse  space toggle  enter make root  o open page  x collapse all  b back  q quit"
        : focus === "list"
          ? "↑↓ move  ⏎/→ open  ← close  x/X collapse/expand all  [ ] prev/next type  tab page  t tree  b back  / search  e edit  q"
          : "↑↓ link  enter follow  ←/esc list  space/J/K scroll  t tree  b back  e edit  q quit";
  const footer = searching ? (
    <Text wrap="truncate">
      <Text color="yellow">/</Text>
      <Text>{filter}</Text>
      <Text inverse> </Text>
      <Text dimColor>  {tree.filter((r) => r.kind === "object" || r.kind === "wanted").length} matches{narrow ? "" : " · enter keep · esc clear"}</Text>
    </Text>
  ) : (
    <Text dimColor wrap="truncate">
      {filter ? <Text color="yellow">{narrow ? `/${filter} ` : `filter: ${filter} (esc clears)  `}</Text> : null}
      {footerText}
    </Text>
  );

  if (view === "tree") {
    const detailLines = rows >= 22 ? 3 : rows >= 14 ? 2 : 0;
    const treeHeight = Math.max(1, innerHeight - (detailLines ? detailLines + 1 : 0));
    const start = clamp(nodeIndex - Math.floor(treeHeight / 2), 0, Math.max(0, nodes.length - treeHeight));
    const detail = node ? store.objects.get(node.id) : undefined;
    const parentId = node && node.depth > 0 ? nodes.find((n) => n.key === node.key.slice(0, node.key.lastIndexOf(">")))?.id : undefined;
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        {header}
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" height={bodyHeight} paddingX={1}>
          <Box flexDirection="column" height={treeHeight}>
            {nodes.slice(start, start + treeHeight).map((n, i) => (
              <LineView key={n.key} line={treeLine(store, n, columns - 4, start + i === nodeIndex, changedIds)} />
            ))}
            {!nodes.length ? <Text dimColor>Empty store.</Text> : null}
          </Box>
          {detailLines && node ? (
            <>
              <Text dimColor>{"─".repeat(Math.max(0, columns - 4))}</Text>
              <Text wrap="truncate">
                <Text bold color={detail ? "cyan" : "red"}>{node.id}</Text>
                {parentId ? <Text dimColor> {{ out: "← linked from", in: "→ links to", both: "↔ linked with", root: "" }[node.dir]} {parentId} via {node.via.join(", ")}</Text> : null}
              </Text>
              <Text wrap="truncate" italic>{detail ? detail.summary : "wanted page: linked but not written yet"}</Text>
              {detailLines > 2 ? <Text dimColor wrap="truncate">{detail ? detail.body.replace(/\s+/g, " ").trim() : ""}</Text> : null}
            </>
          ) : null}
        </Box>
        {footer}
      </Box>
    );
  }

  // ── browse ──
  const listStart = clamp(cursor - Math.floor(innerHeight / 2), 0, Math.max(0, tree.length - innerHeight));
  const visibleRows = tree.slice(listStart, listStart + innerHeight);
  const multiLayer = layers.length > 1;
  const visibleLines = page?.lines.slice(scroll, scroll + innerHeight) ?? [];
  const activeLinkLine = focus === "page" && page?.links.length ? page.linkLines[linkIdx] : undefined;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {header}
      <Box height={bodyHeight}>
        {narrow && focus === "page" ? null : <Box flexDirection="column" width={leftWidth + 2} flexShrink={0} borderStyle="round" borderColor={focus === "list" ? "cyan" : "gray"} paddingX={0}>
          {!tree.length ? <Text dimColor>{filter ? " no matches" : " empty store"}</Text> : null}
          {visibleRows.map((row, i) => {
            const index = listStart + i;
            const w = leftWidth;
            const isCursor = index === cursor;
            if (row.kind === "type" || row.kind === "wanted-header") {
              const name = row.kind === "type" ? row.name : "wanted";
              const extra = row.kind === "type" && multiLayer && row.layer === "project" ? " project" : "";
              const label = `${row.open ? "▾" : "▸"} ${name}`;
              const count = ` ${row.count}${extra}`;
              return (
                <Text key={rowKey(row)} wrap="truncate">
                  <Text bold color={row.kind === "type" ? "magenta" : "red"} inverse={isCursor && focus === "list"}>
                    {label}
                  </Text>
                  <Text>{" ".repeat(Math.max(1, w - label.length - count.length))}</Text>
                  <Text dimColor>{count}</Text>
                </Text>
              );
            }
            const label = row.kind === "object" ? row.id.slice(row.id.indexOf("/") + 1) : row.id;
            const marks: { t: string; c: string }[] = [];
            if (row.kind === "object") {
              if (changedIds.has(row.id)) marks.push({ t: "•", c: "green" });
              if (row.obj.pinned) marks.push({ t: "★", c: "yellow" });
              if (store.issuesFor(row.obj.path).some((x) => x.severity === "error")) marks.push({ t: "!", c: "red" });
            }
            const count = row.kind === "object" ? (store.backlinks.get(row.id)?.size ?? 0) : row.sources;
            const right = count ? ` ←${count}` : "";
            const marksWidth = marks.length ? marks.length + 1 : 0;
            const name = truncate(label, w - 3 - right.length - marksWidth);
            const gap = " ".repeat(Math.max(0, w - 2 - name.length - right.length - marksWidth));
            return (
              <Text key={`o:${row.id}`} wrap="truncate">
                <Text> </Text>
                <Text
                  inverse={isCursor && focus === "list"}
                  bold={isCursor}
                  color={row.kind === "wanted" ? "red" : isCursor ? "cyan" : undefined}
                >
                  {" "}{name}{gap}
                </Text>
                {marks.length ? <Text> </Text> : null}
                {marks.map((m, j) => <Text key={j} color={m.c}>{m.t}</Text>)}
                <Text dimColor>{right}</Text>
              </Text>
            );
          })}
        </Box>}
        {narrow && focus === "list" ? null : <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={focus === "page" ? "cyan" : "gray"} paddingX={1}>
          {visibleLines.map((line, i) => {
            const n = scroll + i;
            return n === activeLinkLine ? <LineView key={n} line={line.map((s) => ({ ...s, inverse: true }))} /> : <LineView key={n} line={line} />;
          })}
        </Box>}
      </Box>
      {footer}
    </Box>
  );
}
