/**
 * Cross-process transcript reading for pi sessions.
 *
 * Pi session files are append-only JSONL trees: every entry has an id and a
 * parentId, and the live process's "active branch" is defined by its in-memory
 * leaf pointer. Append operations synchronously flush to disk and always move
 * the leaf to the new entry, so the last entry in file order is the active
 * leaf (modulo a tiny window right after /branch where the pointer moved but
 * nothing new has been appended yet). Walking parent links from the last
 * entry reconstructs the active branch without touching the live process.
 *
 * Everything here is read-only and crash-safe: parse errors on trailing
 * (concurrently-written) lines are skipped, and the file is never mutated.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDirPath } from "./broker/paths.ts";
import type { SessionInfo } from "./types.ts";

// ── Session file model ───────────────────────────────────────────────────────

export interface SessionFileHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

export interface MessageEntryInfo {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: {
		role: string;
		content:
			| string
			| Array<{ type: string; text?: string; thinking?: string; name?: string; arguments?: unknown }>;
		[key: string]: unknown;
	};
}

export interface CustomMessageEntryInfo {
	type: "custom_message";
	id: string;
	parentId: string | null;
	timestamp: string;
	customType: string;
	content: string | Array<{ type: string; text?: string }>;
	display: boolean;
}

export type TranscriptEntryInfo = MessageEntryInfo | CustomMessageEntryInfo;

export interface SessionLocation {
	/** Absolute path to the session .jsonl file. */
	file: string;
	/** Session header id, if the file could be read. */
	sessionId?: string;
	/** Human-facing origin: session name when resolved via a live session, else the file path. */
	origin: string;
	/** True when the file was resolved via the intercom session list (live peer). */
	live: boolean;
	/** Live peer metadata, when resolved via the intercom session list. */
	session?: SessionInfo;
}
// ── File resolution ──────────────────────────────────────────────────────────

/** Encode a cwd into a session directory name (mirrors Pi's SessionManager). */
export function encodeSessionDirName(cwd: string): string {
	const resolved = resolve(cwd);
	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Candidate session directory names for a cwd, in preference order.
 *
 * Pi keys session dirs by absolute path (`--home-u-proj--`); omp keys them by
 * path relative to $HOME (`-projects-proj`), falling back to $TMPDIR-relative
 * and finally the absolute form. Emit every form so either harness resolves.
 */
export function encodeSessionDirNames(cwd: string): string[] {
	const resolved = resolve(cwd);
	const names: string[] = [];

	const relativeName = (prefix: string, value: string): string => {
		const encoded = value.replace(/[/\\:]/g, "-");
		if (!encoded) return prefix;
		return prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`;
	};
	const inside = (base: string): string | undefined => {
		const rel = relative(resolve(base), resolved);
		if (rel === "") return "";
		return rel.startsWith("..") || isAbsolute(rel) ? undefined : rel;
	};

	const fromHome = inside(homedir());
	if (fromHome !== undefined) names.push(relativeName("-", fromHome));
	const fromTmp = inside(tmpdir());
	if (fromTmp !== undefined) names.push(relativeName("-tmp", fromTmp));
	names.push(encodeSessionDirName(resolved));

	return [...new Set(names)];
}

/**
 * Session storage roots to search, most-preferred first.
 *
 * Pi stores sessions under `~/.pi/agent/sessions`; omp stores them under
 * `~/.omp/agent/sessions` and — critically — does not export
 * `PI_CODING_AGENT_DIR`, so `getAgentDirPath()` alone can never see them. The
 * caller's own session directory (when known) comes first: its parent is the
 * live sessions root, which also covers omp profiles and custom `--session`
 * directories. The two harness defaults follow as fallbacks so offline session
 * ids resolve from either side.
 */
export function getSessionRoots(preferredSessionDir?: string): string[] {
	const roots: string[] = [];
	const add = (dir: string | undefined): void => {
		if (!dir) return;
		const resolved = resolve(dir);
		if (!roots.includes(resolved)) roots.push(resolved);
	};

	add(preferredSessionDir ? dirname(preferredSessionDir) : undefined);

	// Pi root: honors PI_CODING_AGENT_DIR, else ~/.pi/agent.
	add(join(getAgentDirPath(), "sessions"));

	// omp root. `PI_CONFIG_DIR` is normally relative to $HOME (`.omp`), and a
	// named profile nests one level deeper. `PI_PROFILE`/`OMP_PROFILE` selects it.
	const ompConfig = (process.env.PI_CONFIG_DIR?.trim() || ".omp");
	const ompBase = isAbsolute(ompConfig) ? ompConfig : join(homedir(), ompConfig);
	const profile = process.env.OMP_PROFILE?.trim() || process.env.PI_PROFILE?.trim();
	if (profile) add(join(ompBase, "profiles", profile, "agent", "sessions"));
	add(join(ompBase, "agent", "sessions"));

	return roots;
}

/**
 * Find the session file for a session id, scoped to a cwd when available.
 * Session ids are UUIDv7, so newest file wins when duplicates exist.
 *
 * `sessionDir` is the calling session's own session directory (from
 * `ctx.sessionManager.getSessionDir()`), which pins the correct harness root.
 */
export function findSessionFile(sessionId: string, cwd?: string, sessionDir?: string): string | null {
	const roots = getSessionRoots(sessionDir);
	const candidates: string[] = [];

	if (cwd) {
		for (const root of roots) {
			for (const name of encodeSessionDirNames(cwd)) {
				candidates.push(join(root, name));
			}
		}
	}
	// Fall back to scanning all session dirs: custom --session paths, unusual
	// cwds, or files written before the cwd was known.
	const dirs = [...candidates, ...roots];
	const seen = new Set<string>();
	let best: { path: string; mtime: number } | null = null;
	for (const dir of dirs) {
		if (seen.has(dir) || !existsSync(dir)) continue;
		seen.add(dir);
		if (roots.includes(dir)) {
			// Flat fallback: scan every per-cwd directory one level deep.
			for (const name of readdirSync(dir)) {
				const sub = join(dir, name);
				try {
					if (!statSync(sub).isDirectory()) continue;
				} catch {
					continue;
				}
				collectSessionFileMatches(sub, sessionId, (p, m) => {
					if (!best || m > best.mtime) best = { path: p, mtime: m };
				});
			}
		} else {
			collectSessionFileMatches(dir, sessionId, (p, m) => {
				if (!best || m > best.mtime) best = { path: p, mtime: m };
			});
		}
	}
	return best ? (best as { path: string; mtime: number }).path : null;
}

function collectSessionFileMatches(
	dir: string,
	sessionId: string,
	onMatch: (path: string, mtime: number) => void,
): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.endsWith(".jsonl") || !name.includes(sessionId)) continue;
		const p = join(dir, name);
		try {
			onMatch(p, statSync(p).mtimeMs);
		} catch {
			// vanished between readdir and stat — ignore
		}
	}
}

/** Options for {@link resolveSessionLocation}. */
export interface ResolveSessionOptions {
	/** Calling session's own session directory (`ctx.sessionManager.getSessionDir()`). */
	sessionDir?: string;
}

/** Resolve a target session to a readable file, via live sessions or a raw path. */
export async function resolveSessionLocation(
	target: string,
	listSessions: () => Promise<SessionInfo[]>,
	options: ResolveSessionOptions = {},
): Promise<SessionLocation> {
	const { sessionDir } = options;
	if (target.startsWith("file:")) {
		const raw = target.slice("file:".length);
		const file = resolve(raw.startsWith("~") ? raw.replace(/^~(?=\/|$)/, homedir()) : raw);
		if (!existsSync(file)) {
			throw new Error(`Session file not found: ${file}`);
		}
		return { file, origin: file, live: false };
	}

	const sessions = await listSessions();
	const lowered = target.toLowerCase();
	const byId = sessions.find((s) => s.id === target);
	const byName = sessions.filter((s) => s.name?.toLowerCase() === lowered);
	const byPrefix = byId ? [] : sessions.filter((s) => s.id.startsWith(target) && target.length >= 4);

	let session: SessionInfo | undefined;
	if (byId) session = byId;
	else if (byName.length === 1) session = byName[0];
	else if (byName.length > 1) {
		throw new Error(
			`Multiple sessions named "${target}" are connected. Address one by the id shown by read_transcript({ action: "list" }) (${byName
				.map((s) => s.id.slice(0, 8))
				.join(", ")}).`,
		);
	} else if (byPrefix.length === 1) session = byPrefix[0];
	else if (byPrefix.length > 1) {
		throw new Error(`Multiple sessions match ID prefix "${target}". Use a longer session ID prefix.`);
	}

	if (session) {
		const file = findSessionFile(session.id, session.cwd, sessionDir);
		if (file) {
			return { file, sessionId: session.id, origin: session.name || session.id.slice(0, 8), live: true, session };
		}
		// Live session whose file can't be located (custom session dir, never
		// persisted, etc.) — fall through to a global search before giving up.
		const fallback = findSessionFile(session.id, undefined, sessionDir);
		if (fallback) {
			return { file: fallback, sessionId: session.id, origin: session.name || session.id.slice(0, 8), live: true, session };
		}
		throw new Error(
			`Session "${session.name || session.id.slice(0, 8)}" is live but its session file could not be located on disk (searched ${getSessionRoots(sessionDir).join(", ")}).`,
		);
	}

	// Not a live session: treat the target as a session id or file path.
	if (target.includes("/") || target.includes("~")) {
		return resolveSessionLocation(`file:${target}`, listSessions, options);
	}
	const file = findSessionFile(target, undefined, sessionDir);
	if (file) {
		return { file, origin: target.slice(0, 8), live: false };
	}
	throw new Error(
		`No live session or session file matches "${target}". Use a live session name/id (see action "list"), a session id, or file:<path>.`,
	);
}

// ── Parsing ──────────────────────────────────────────────────────────────────

interface ParsedFile {
	header: SessionFileHeader | null;
	/** All non-header entries, in file order. */
	entries: Array<(TranscriptEntryInfo | { type: string; id: string; parentId: string | null; timestamp: string }) & Record<string, unknown>>;
	/** Lines skipped due to parse errors (concurrent writes). */
	skippedLines: number;
}

function parseJsonlFile(filePath: string): ParsedFile {
	const content = readFileSync(filePath, "utf-8");
	const lines = content.split("\n");
	const entries: ParsedFile["entries"] = [];
	let header: SessionFileHeader | null = null;
	let skippedLines = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let value: Record<string, unknown>;
		try {
			value = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			// Concurrently appended line or corruption: skip, count, keep going.
			skippedLines++;
			continue;
		}
		if (value.type === "session" && !header) {
			header = value as unknown as SessionFileHeader;
			continue;
		}
		if (typeof value.id !== "string" || typeof value.type !== "string") {
			skippedLines++;
			continue;
		}
		entries.push(value as ParsedFile["entries"][number]);
	}
	return { header, entries, skippedLines };
}

export interface ActiveBranch {
	/** Entries on the active branch, oldest first. Includes messages and structural entries. */
	entries: Array<{ id: string; parentId: string | null; timestamp: string; type: string; raw: unknown }>;
	/** Number of entries NOT on the active branch (abandoned side branches). */
	totalEntries: number;
	skippedLines: number;
}

/**
 * Reconstruct the active branch of a session file: walk parent links from the
 * last entry in file order (the live process's leaf) back to the root.
 */
export function readActiveBranch(filePath: string): ActiveBranch {
	const { header, entries, skippedLines } = parseJsonlFile(filePath);
	const byId = new Map<string, (typeof entries)[number]>();
	for (const entry of entries) {
		byId.set(entry.id, entry);
	}

	// Leaf = last entry in file order; walk to root via parentId.
	const branch: Array<{ id: string; parentId: string | null; timestamp: string; type: string; raw: unknown }> = [];
	let current: (typeof entries)[number] | undefined = entries.length > 0 ? entries[entries.length - 1] : undefined;
	const visited = new Set<string>();
	while (current && !visited.has(current.id)) {
		visited.add(current.id);
		branch.push({ id: current.id, parentId: current.parentId, timestamp: current.timestamp, type: current.type, raw: current });
		const parentId: string | null | undefined = current.parentId;
		current = typeof parentId === "string" ? byId.get(parentId) : undefined;
	}
	branch.reverse();

	return {
		entries: branch,
		totalEntries: entries.length,
		skippedLines,
	};
}

// ── Selector parsing ─────────────────────────────────────────────────────────

export interface TranscriptSelector {
	/** Entry id to anchor at ("id:abcd1234"); disables tail selection. */
	anchorId?: string;
	/** Numeric selection: entries between these branch indexes (1-based, inclusive). */
	start?: number;
	end?: number;
	/** Show raw JSON instead of rendered text. */
	raw: boolean;
}

export function parseSelector(spec: string): TranscriptSelector {
	const selector: TranscriptSelector = { raw: false };
	let rest = spec.trim();
	if (rest.startsWith("raw:")) {
		selector.raw = true;
		rest = rest.slice(4).trim();
	}
	if (!rest) return selector;

	if (rest.startsWith("id:")) {
		const id = rest.slice(3).trim();
		if (!id) throw new Error(`Selector "id:" requires an entry id (e.g. id:9709e4bd).`);
		selector.anchorId = id;
		return selector;
	}

	// Numeric range: "20", "20-", "-50", "20-40". Try the tail form first:
	// the generic regex would otherwise read "-50" as "up to entry 50".
	const tailMatch = /^-(\d+)$/.exec(rest);
	if (tailMatch) {
		const count = Number.parseInt(tailMatch[1]!, 10);
		if (count <= 0) throw new Error(`Invalid tail count in selector "${spec}".`);
		selector.start = -count;
		return selector;
	}
	const rangeMatch = /^(-?\d+)?\s*-{0,1}\s*(-?\d+)?$/.exec(rest);
	if (!rangeMatch) {
		throw new Error(
			`Invalid selector "${spec}". Supported: "-50" (last 50), "20-40" (range), "20-" (from 20 on), "id:<entry-id>", optional "raw:" prefix.`,
		);
	}
	const [, startStr, endStr] = rangeMatch;
	if (startStr === undefined && endStr === undefined) {
		throw new Error(`Selector "${spec}" selects nothing. Use e.g. "-50", "20-40", "20-", or "id:<entry-id>".`);
	}
	const start = startStr !== undefined && startStr !== "" ? Number.parseInt(startStr, 10) : undefined;
	const end = endStr !== undefined && endStr !== "" ? Number.parseInt(endStr, 10) : undefined;
	if (start !== undefined && !Number.isFinite(start)) throw new Error(`Invalid range start in selector "${spec}".`);
	if (end !== undefined && !Number.isFinite(end)) throw new Error(`Invalid range end in selector "${spec}".`);
	selector.start = start;
	selector.end = end;
	return selector;
}


// ── Branch selection & rendering ────────────────────────────────────────────

/** Index of an entry within the active branch, 1-based (matches selector syntax). */
export interface IndexedEntry {
	index: number;
	id: string;
	parentId: string | null;
	timestamp: string;
	type: string;
	raw: unknown;
}

function applySelector(
	branch: ActiveBranch,
	selector: TranscriptSelector,
): { selected: IndexedEntry[]; anchorIndex?: number } {
	const indexed: IndexedEntry[] = branch.entries.map((e, i) => ({ index: i + 1, ...e }));
	if (selector.anchorId !== undefined) {
		const anchor = indexed.find((e) => e.id === selector.anchorId || e.id.startsWith(selector.anchorId!));
		if (!anchor) {
			throw new Error(
				`Entry id "${selector.anchorId}" not found on the active branch. Full ids are shown by raw mode or the "list" output prefix.`,
			);
		}
		// Anchor semantics: that entry plus its context going backwards (upward truncation).
		const selected = indexed.slice(0, anchor.index);
		return { selected, anchorIndex: anchor.index };
	}

	const total = indexed.length;
	let start = selector.start ?? 1;
	let end = selector.end ?? total;
	// Negative values count back from the end (tail form). "-50" parses to start=-50, end=50.
	if (start < 0) start = Math.max(1, total + start + 1);
	if (end < 0) end = total + end + 1;
	start = Math.max(1, start);
	end = Math.min(total, end);
	if (start > end) {
		return { selected: [] };
	}
	return { selected: indexed.slice(start - 1, end) };
}

function textFromContent(
	content: string | Array<{ type: string; text?: string; thinking?: string }>,
): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

const ROLE_LABELS: Record<string, string> = {
	user: "user",
	assistant: "assistant",
	toolResult: "tool",
	custom: "custom",
};

interface RenderOptions {
	/** Include toolResult and toolCall-heavy assistant messages. Default: skip them. */
	includeTools: boolean;
}

function renderEntry(
	entry: IndexedEntry,
	options: RenderOptions,
): { role: string; text: string; type: string } | null {
	const data = entry.raw as TranscriptEntryInfo;
	if (data.type === "message") {
		const message = data.message;
		const role = ROLE_LABELS[message.role] ?? message.role;
		if (message.role === "toolResult") {
			if (!options.includeTools) return null;
			const text = textFromContent(message.content as string | Array<{ type: string; text?: string }>);
			return { role, text: truncateOneLine(text, 400), type: "message" };
		}
		if (message.role === "assistant") {
			const blocks = Array.isArray(message.content) ? message.content : [];
			const textBlocks = blocks.filter((b) => b.type === "text" && typeof b.text === "string");
			const toolCalls = blocks.filter((b) => b.type === "toolCall");
			const text = textBlocks.map((b) => (b as { text: string }).text).join("\n");
			if (toolCalls.length > 0) {
				if (!options.includeTools) return null;
				const names = toolCalls.map((b) => (b as { name?: string }).name ?? "?").join(", ");
				return {
					role,
					text: text ? `${text}\n[tool calls: ${names}]` : `[tool calls: ${names}]`,
					type: "message",
				};
			}
			if (!text) return null;
			return { role, text, type: "message" };
		}
		// user and anything else
		const text = textFromContent(message.content as string | Array<{ type: string; text?: string }>);
		if (!text.trim()) return null;
		return { role, text, type: "message" };
	}
	if (data.type === "custom_message") {
		const text = textFromContent(data.content);
		if (!text.trim()) return null;
		return { role: data.customType, text, type: "custom_message" };
	}
	return null;
}

function truncateOneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const CONTENT_MAX_CHARS = 1200;

function clampEntryText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}… [truncated ${text.length - maxChars} chars]`;
}

export interface TranscriptReadResult {
	header: {
		sessionId?: string;
		file: string;
		origin: string;
		live: boolean;
		sessionName?: string;
	};
	stats: {
		activeBranchEntries: number;
		totalEntries: number;
		offBranchEntries: number;
		skippedLines: number;
		selected: number;
		rendered: number;
	};
	selection: { start: number; end: number } | { anchor: string } | null;
	entries: Array<{ index: number; id: string; timestamp: string; role: string; type: string; text: string }>;
	raw?: Array<{ index: number; id: string; parentId: string | null; timestamp: string; type: string; entry: unknown }>;
}

export function readTranscript(options: {
	file: string;
	selector: TranscriptSelector;
	includeTools: boolean;
	maxChars?: number;
	origin: string;
	live: boolean;
	session?: SessionInfo;
}): TranscriptReadResult {
	const branch = readActiveBranch(options.file);
	const { selected } = applySelector(branch, options.selector);
	const maxChars = options.maxChars ?? 40000;
	const header = parseJsonlFile(options.file);

	const result: TranscriptReadResult = {
		header: {
			sessionId: header.header?.id,
			file: options.file,
			origin: options.origin,
			live: options.live,
			sessionName: options.session?.name,
		},
		stats: {
			activeBranchEntries: branch.entries.length,
			totalEntries: branch.totalEntries,
			offBranchEntries: branch.totalEntries - branch.entries.length,
			skippedLines: branch.skippedLines,
			selected: selected.length,
			rendered: 0,
		},
		selection: options.selector.anchorId !== undefined
			? { anchor: options.selector.anchorId }
			: selected.length > 0
				? { start: selected[0]!.index, end: selected[selected.length - 1]!.index }
				: null,
		entries: [],
	};

	if (options.selector.raw) {
		result.raw = selected.map((e) => ({
			index: e.index,
			id: e.id,
			parentId: e.parentId,
			timestamp: e.timestamp,
			type: e.type,
			entry: e.raw,
		}));
		result.stats.rendered = result.raw.length;
		return result;
	}

	let budget = maxChars;
	for (const entry of selected) {
		const rendered = renderEntry(entry, { includeTools: options.includeTools });
		if (!rendered) continue;
		const text = clampEntryText(rendered.text, Math.min(CONTENT_MAX_CHARS, budget));
		if (budget <= 0) break;
		budget -= text.length;
		result.entries.push({
			index: entry.index,
			id: entry.id,
			timestamp: entry.timestamp,
			role: rendered.role,
			type: rendered.type,
			text,
		});
		result.stats.rendered++;
	}
	return result;
}