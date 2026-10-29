import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { displayPath } from "../core/render.ts";
import { cacheRoot, embedderFor, search as semanticSearch, semanticUnavailable, syncIndex } from "../core/semantic.ts";
import { type Layer, Store } from "../core/store.ts";
import {
  activityLine,
  activityRows,
  activityTarget,
  type Line,
  parentKey,
  readActivity,
  renderActivityPage,
  renderPage,
  renderTypePage,
  renderWantedPage,
  rowKey,
  type SearchRow,
  searchLine,
  treeRows,
  truncate,
  typeKey,
  WANTED_KEY,
  wrap as wrapText,
} from "./model.ts";
import { watchStores } from "./watch.ts";

export type View = "browse" | "activity" | "search";

export interface SearchResults {
  query: string;
  status: "running" | "done" | "error";
  message?: string;
  hits: SearchRow[];
}

/** UI state that survives suspending the viewer to run $EDITOR. */
export interface ViewerState {
  current?: string;
  view: View;
  history: string[];
  filter: string;
  /** Expanded headers in the browse list (`type:<name>`, `wanted:`); all start collapsed. */
  open?: string[];
  /** Cursor in the activity or search list, expanded activity batches, and the last search. */
  sideKey?: string;
  batches?: string[];
  results?: SearchResults;
}

/** Results listed by a `?` search, threshold or not; the threshold is drawn as a line. */
const SEARCH_LIMIT = 20;

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
  /** Activity and search views: the list cursor, expanded batches, the `?` prompt and its results. */
  const [sideKey, setSideKey] = useState<string | undefined>(initial.sideKey);
  const [batches, setBatches] = useState<Set<string>>(() => new Set(initial.batches ?? []));
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState(initial.results?.query ?? "");
  const [results, setResults] = useState<SearchResults | undefined>(initial.results?.status === "done" ? initial.results : undefined);
  const searchRun = useRef(0);
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
  const leftWidth = narrow ? columns - 2 : view === "activity" ? clamp(Math.floor(columns * 0.4), 30, 56) : clamp(Math.floor(columns * 0.3), 24, 44);
  const rightWidth = narrow ? Math.max(10, columns - 4) : Math.max(10, columns - leftWidth - 6);

  // ── selection ──
  // `current` is a row key: an object or wanted id, `type:<name>` or `wanted:`.
  const tree = useMemo(() => treeRows(store, filter, open), [store, filter, open]);
  const keys = useMemo(() => tree.map(rowKey), [tree]);
  let cursor = current ? keys.indexOf(current) : -1;
  const exists = (key: string) =>
    key.startsWith("type:") ? store.types.has(key.slice(5)) : key === WANTED_KEY ? store.wanted.size > 0 : store.objects.has(key) || store.wanted.has(key);
  const selected = current && exists(current) && cursor >= 0 ? current : undefined;
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

  // ── activity and search lists ──
  const activity = useMemo(() => readActivity(layers), [layers, loadedAt]);
  const actRows = useMemo(() => activityRows(activity, batches), [activity, batches]);
  const hits = results?.hits ?? [];
  /** Selectable keys of the side list (day headers are not). */
  const sideKeys = useMemo(
    () => (view === "activity" ? actRows.filter((r) => r.kind !== "day").map((r) => r.key) : view === "search" ? hits.map((h) => h.key) : []),
    [view, actRows, hits],
  );
  const sideIndex = sideKey && sideKeys.includes(sideKey) ? sideKeys.indexOf(sideKey) : sideKeys.length ? 0 : -1;
  const sideSelected = sideIndex >= 0 ? sideKeys[sideIndex] : undefined;
  const actRow = view === "activity" ? actRows.find((r) => r.key === sideSelected) : undefined;
  const hit = view === "search" ? hits.find((h) => h.key === sideSelected) : undefined;
  /** The object the page shows, for `e` (edit) and `o` (open in browse). */
  const pageObject = view === "browse" ? id : view === "activity" ? (actRow ? activityTarget(store, actRow).object : undefined) : hit?.id;
  const threshold = store.semantic.threshold;

  const page = useMemo(() => {
    if (view === "activity") return actRow ? renderActivityPage(store, actRow, rightWidth, changedIds) : undefined;
    if (view === "search") return hit && store.objects.has(hit.id) ? renderPage(store, hit.id, rightWidth, changedIds) : undefined;
    if (!selectedKey) return undefined;
    if (selectedKey.startsWith("type:")) return renderTypePage(store, selectedKey.slice(5), rightWidth);
    if (selectedKey === WANTED_KEY) return renderWantedPage(store, rightWidth);
    return renderPage(store, selectedKey, rightWidth, changedIds);
  }, [store, view, actRow, hit, selectedKey, rightWidth, changedIds]);

  const go = (target: string, push = true) => {
    if (target === selectedKey) return;
    if (push && selectedKey) setHistory((h) => [...h.slice(-49), selectedKey]);
    setCurrent(target);
    setLinkIdx(0);
    setScroll(0);
    // Following a link to something hidden by the filter clears the filter.
    if (filter && !treeRows(store, filter).some((r) => rowKey(r) === target)) setFilter("");
  };
  /** Opens an object in browse, from any view. */
  const follow = (target: string) => {
    if (view !== "browse") {
      setView("browse");
      setFocus(narrow ? "page" : "list");
    }
    go(target);
  };
  const moveSide = (delta: number) => {
    if (!sideKeys.length) return;
    const next = sideKeys[clamp(sideIndex + delta, 0, sideKeys.length - 1)]!;
    if (next !== sideSelected) {
      setSideKey(next);
      setLinkIdx(0);
      setScroll(0);
    }
  };
  const runSearch = async (q: string) => {
    const run = ++searchRun.current;
    setView("search");
    setFocus("list");
    setSideKey(undefined);
    setScroll(0);
    const why = semanticUnavailable(store, process.env);
    if (why) return setResults({ query: q, status: "error", message: why, hits: [] });
    setResults({ query: q, status: "running", hits: [] });
    try {
      const embedder = embedderFor(store, process.env)!;
      const cache = cacheRoot(process.env);
      await syncIndex(store, embedder, cache);
      const found = await semanticSearch(store, embedder, cache, q, { limit: SEARCH_LIMIT, minScore: 0 });
      if (run !== searchRun.current) return;
      setResults({ query: q, status: "done", hits: found.map((h) => ({ key: h.obj.id, id: h.obj.id, score: h.score, similarity: h.similarity })) });
    } catch (err) {
      if (run !== searchRun.current) return;
      setResults({ query: q, status: "error", message: err instanceof Error ? err.message : String(err), hits: [] });
    }
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
  const onScreen = (line: number) => line >= scroll && line < scroll + innerHeight;
  /** The link enter follows in page focus: the chosen one while visible, else the first visible. */
  const activeLink = (() => {
    if (!page?.links.length) return undefined;
    if (page.linkLines[linkIdx] !== undefined && onScreen(page.linkLines[linkIdx]!)) return linkIdx;
    const first = page.linkLines.findIndex(onScreen);
    return first >= 0 ? first : undefined;
  })();
  const edit = () => {
    const obj = pageObject ? store.objects.get(pageObject) : undefined;
    if (!obj) return;
    onEdit(obj.path, { current, view, history, filter, open: [...open], sideKey: sideSelected, batches: [...batches], results });
    exit();
  };

  useInput((input, key) => {
    if (asking) {
      if (key.escape) setAsking(false);
      else if (key.return) {
        setAsking(false);
        if (question.trim()) void runSearch(question.trim());
      } else if (key.backspace || key.delete) setQuestion((q) => q.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setQuestion((q) => q + input);
      return;
    }
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
      if (input.startsWith("?")) {
        setAsking(true);
        setQuestion(input.slice(1));
        return;
      }
      if (/^[jk]+$/.test(input) && focus === "list") {
        const delta = [...input].reduce((n, ch) => n + (ch === "j" ? 1 : -1), 0);
        return view === "browse" ? moveList(delta) : moveSide(delta);
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
    if (input === "?") {
      setAsking(true);
      setQuestion("");
      return;
    }
    const switchTo = (v: View) => {
      if (v === view) return;
      setView(v);
      setFocus("list");
      setScroll(0);
      setLinkIdx(0);
    };
    if (input === "1") return switchTo("browse");
    if (input === "2" || input === "a") return switchTo("activity");
    if (input === "3" && results) return switchTo("search");
    if (input === "e") return edit();
    if (input === "r") return reload();
    if (input === "b" || key.backspace || key.delete) return back();

    if (input === "o" && pageObject && view !== "browse") return follow(pageObject);
    if (key.tab) return setFocus(focus === "list" ? "page" : "list");

    // Jump to the top or bottom: of the list, or of the page.
    if (input === "g" || input === "G" || key.home || key.end) {
      const end = input === "G" || key.end;
      if (focus === "page") return setScroll(end ? maxScroll : 0);
      if (view !== "browse") return moveSide(end ? sideKeys.length : -sideKeys.length);
      return moveList(end ? keys.length : -keys.length);
    }
    // Activity: previous / next day.
    if (view === "activity" && focus === "list" && (input === "[" || input === "]")) {
      const starts = actRows.flatMap((r, i) => (r.kind === "day" && actRows[i + 1] ? [sideKeys.indexOf(actRows[i + 1]!.key)] : []));
      const target = input === "]" ? starts.find((i) => i > sideIndex) : [...starts].reverse().find((i) => i < sideIndex);
      if (target !== undefined) moveSide(target - sideIndex);
      return;
    }

    // Activity and search lists: move, expand batches, open the page.
    if (view !== "browse" && focus === "list") {
      if (key.downArrow || input === "j") moveSide(1);
      else if (key.upArrow || input === "k") moveSide(-1);
      else if (key.pageDown || input === " " || (key.ctrl && input === "d")) moveSide(innerHeight - 2);
      else if (key.pageUp || (key.ctrl && input === "u")) moveSide(-(innerHeight - 2));
      else if (actRow?.kind === "batch" && (key.return || key.rightArrow || input === "l" || ((key.leftArrow || input === "h") && actRow.open))) {
        setBatches((prev) => {
          const next = new Set(prev);
          if (next.has(actRow.key)) next.delete(actRow.key);
          else next.add(actRow.key);
          return next;
        });
      } else if (key.return || key.rightArrow || input === "l") setFocus("page");
      else if (key.escape) switchTo("browse");
      return;
    }



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
      else if (key.return || key.rightArrow || input === "l") setFocus("page");
      else if (key.escape && filter) setFilter("");
      return;
    }

    // page focus: j/k scroll like a pager; the highlighted link is the chosen one if it's on
    // screen, else the first one on screen; n/N jump between links; enter follows.
    const n = page?.links.length ?? 0;
    if (key.escape || key.leftArrow || input === "h") setFocus("list");
    else if (key.downArrow || input === "j" || input === "J") setScroll((s) => Math.min(maxScroll, s + 1));
    else if (key.upArrow || input === "k" || input === "K") setScroll((s) => Math.max(0, s - 1));
    else if ((input === "n" || input === "N") && n) {
      const from = activeLink ?? (input === "n" ? -1 : 0);
      const i = (from + (input === "n" ? 1 : -1) + n) % n;
      setLinkIdx(i);
      ensureVisible(page!.linkLines[i]!);
    } else if (key.return && activeLink !== undefined) follow(page!.links[activeLink]!);
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
          <Text inverse={view === "activity"} bold={view === "activity"}>{narrow ? " 2 " : " 2 activity "}</Text>
          {results ? <Text inverse={view === "search"} bold={view === "search"}>{narrow ? " 3 " : " 3 search "}</Text> : null}
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
      ? view === "browse"
        ? focus === "list"
          ? "↑↓ g/G · ⏎→ open · ← close · x/X all · [ ] · 2 activity · / ?"
          : "↑↓␣ g/G scroll · n/N link · ⏎ go · ← list · e"
        : focus === "list"
          ? `↑↓ g/G${view === "activity" ? " · [ ] day" : ""} · ⏎→ page · o open · 1 browse · ?`
          : "↑↓␣ g/G scroll · n/N link · ⏎ go · ← list · o · e"
      : view === "browse"
        ? focus === "list"
          ? "↑↓ move  g/G top/bottom  ⏎/→ open  ← close  x/X collapse/expand all  [ ] prev/next type  tab page  2 activity  / filter  ? search  b back  e edit  q"
          : "↑↓/j/k/space scroll  g/G top/bottom  n/N next/prev link  enter follow  ←/esc list  2 activity  ? search  b back  e edit  q quit"
        : focus === "list"
          ? `↑↓ move  g/G top/bottom  ${view === "activity" ? "[ ] prev/next day  ⏎/→ expand batch / page" : "⏎/→ page"}  o open in browse  tab page  1 browse  ${view === "activity" ? "" : "2 activity  "}? search  e edit  q`
          : "↑↓/j/k/space scroll  g/G top/bottom  n/N next/prev link  enter follow  ←/esc list  o open in browse  e edit  q quit";
  const footer = asking ? (
    <Text wrap="truncate">
      <Text color="cyan">? </Text>
      <Text>{question}</Text>
      <Text inverse> </Text>
      <Text dimColor>{narrow ? "" : "  search by meaning · enter run · esc cancel"}</Text>
    </Text>
  ) : searching ? (
    <Text wrap="truncate">
      <Text color="yellow">/</Text>
      <Text>{filter}</Text>
      <Text inverse> </Text>
      <Text dimColor>  {tree.filter((r) => r.kind === "object" || r.kind === "wanted").length} matches{narrow ? "" : " · enter keep · esc clear"}</Text>
    </Text>
  ) : (
    <Text dimColor wrap="truncate">
      {filter && view === "browse" ? <Text color="yellow">{narrow ? `/${filter} ` : `filter: ${filter} (esc clears)  `}</Text> : null}
      {footerText}
    </Text>
  );

  const visibleLines = page?.lines.slice(scroll, scroll + innerHeight) ?? [];
  const activeLinkLine = focus === "page" && activeLink !== undefined ? page!.linkLines[activeLink] : undefined;
  const pagePane = narrow && focus === "list" ? null : (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={focus === "page" ? "cyan" : "gray"} paddingX={1}>
      {visibleLines.map((line, i) => {
        const n = scroll + i;
        return n === activeLinkLine ? <LineView key={n} line={line.map((s) => ({ ...s, inverse: true }))} /> : <LineView key={n} line={line} />;
      })}
    </Box>
  );

  // ── activity and search ──
  if (view !== "browse") {
    const w = leftWidth;
    const selectedOnList = focus === "list";
    let lines: { key: string; line: Line }[];
    let selectedLine = 0;
    if (view === "activity") {
      lines = actRows.map((r) => ({ key: r.key, line: activityLine(store, r, w, selectedOnList && r.key === sideSelected, changedIds) }));
      selectedLine = Math.max(0, actRows.findIndex((r) => r.key === sideSelected));
      if (!actRows.length) lines = [{ key: "empty", line: [{ text: " no activity logged yet", dim: true }] }];
    } else {
      const head: Line = [{ text: truncate(`? ${results?.query ?? ""}`, w), color: "cyan", bold: true }];
      lines = [{ key: "query", line: head }];
      if (results?.status === "running") lines.push({ key: "status", line: [{ text: " searching…", dim: true }] });
      else if (results?.status === "error") {
        lines.push(...wrapText(results.message ?? "search failed", w).map((t, i) => ({ key: `err${i}`, line: [{ text: t, color: "red" }] as Line })));
      } else if (!hits.length) lines.push({ key: "status", line: [{ text: " no results", dim: true }] });
      let drewThreshold = false;
      hits.forEach((h, i) => {
        if (!drewThreshold && h.score < threshold) {
          drewThreshold = true;
          const label = ` threshold ${threshold.toFixed(2)} `;
          const side = Math.max(0, w - label.length);
          lines.push({ key: "threshold", line: [{ text: `${"─".repeat(Math.floor(side / 2))}${label}${"─".repeat(Math.ceil(side / 2))}`, color: "yellow", dim: true }] });
        }
        if (h.key === sideSelected) selectedLine = lines.length;
        lines.push({ key: h.key, line: searchLine(store, h, w, selectedOnList && h.key === sideSelected, threshold) });
        if (i === hits.length - 1 && !drewThreshold && hits.length) lines.push({ key: "all-above", line: [{ text: ` all above threshold ${threshold.toFixed(2)}`, dim: true }] });
      });
    }
    const start = clamp(selectedLine - Math.floor(innerHeight / 2), 0, Math.max(0, lines.length - innerHeight));
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        {header}
        <Box height={bodyHeight}>
          {narrow && focus === "page" ? null : (
            <Box flexDirection="column" width={leftWidth + 2} flexShrink={0} borderStyle="round" borderColor={focus === "list" ? "cyan" : "gray"} paddingX={0}>
              {lines.slice(start, start + innerHeight).map((l) => (
                <LineView key={l.key} line={l.line} />
              ))}
            </Box>
          )}
          {pagePane}
        </Box>
        {footer}
      </Box>
    );
  }

  // ── browse ──
  const listStart = clamp(cursor - Math.floor(innerHeight / 2), 0, Math.max(0, tree.length - innerHeight));
  const visibleRows = tree.slice(listStart, listStart + innerHeight);
  const multiLayer = layers.length > 1;
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
        {pagePane}
      </Box>
      {footer}
    </Box>
  );
}
