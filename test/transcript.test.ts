import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	encodeSessionDirName,
	encodeSessionDirNames,
	findSessionFile,
	getSessionRoots,
	parseSelector,
	readActiveBranch,
	readTranscript,
	resolveSessionLocation,
	type SessionInfo,
} from "../transcript.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

interface FixtureEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	[key: string]: unknown;
}

function msgEntry(id: string, parentId: string | null, role: string, text: string, timestamp = "2026-01-01T00:00:00.000Z"): FixtureEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: role === "assistant"
			? { role, content: [{ type: "text", text }], timestamp: 1 }
			: { role, content: text, timestamp: 1 },
	};
}

function writeSessionFile(dir: string, name: string, entries: unknown[]): string {
	const file = join(dir, name);
	writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return file;
}

/**
 * Active branch: root → a1 → a2 → a3 → a4, plus an abandoned side branch at
 * a2 → b1 → b2. The b-branch lines appear EARLIER in the file (they were
 * appended before the user switched back to the a-path): the last line in
 * file order is the live leaf, so the a-branch must come last.
 */
function fixtureEntries(): FixtureEntry[] {
	const entries: FixtureEntry[] = [
		msgEntry("a1", null, "user", "hello"),
		msgEntry("a2", "a1", "assistant", "hi there"),
		msgEntry("b1", "a2", "user", "abandoned question"),
		msgEntry("b2", "b1", "assistant", "abandoned answer"),
		msgEntry("a3", "a2", "user", "how are you"),
		msgEntry("a4", "a3", "assistant", "fine"),
	];
	return entries;
}

// ── readActiveBranch ─────────────────────────────────────────────────────────

test("readActiveBranch follows the leaf (last entry) and excludes side branches", () => {
	const dir = mkdtempSync(join(tmpdir(), "transcript-"));
	const file = writeSessionFile(dir, "s.jsonl", [
		{ type: "session", version: 3, id: "sess-1", timestamp: "t", cwd: "/x" },
		...fixtureEntries(),
	]);
	const branch = readActiveBranch(file);
	assert.deepEqual(branch.entries.map((e) => e.id), ["a1", "a2", "a3", "a4"]);
	assert.equal(branch.totalEntries, 6);
	assert.equal(branch.offBranchEntries === undefined ? branch.totalEntries - branch.entries.length : branch.offBranchEntries, 2);
});

test("readActiveBranch skips corrupt trailing lines (concurrent append)", () => {
	const dir = mkdtempSync(join(tmpdir(), "transcript-"));
	const file = join(dir, "s.jsonl");
	const good = fixtureEntries();
	writeFileSync(
		file,
		good.map((e) => JSON.stringify(e)).join("\n") + '\n{"type":"message","id":"half",\n',
	);
	const branch = readActiveBranch(file);
	assert.deepEqual(branch.entries.map((e) => e.id), ["a1", "a2", "a3", "a4"]);
	assert.equal(branch.skippedLines, 1);
});

test("readActiveBranch guards against parent cycles", () => {
	const dir = mkdtempSync(join(tmpdir(), "transcript-"));
	const entries: FixtureEntry[] = [
		msgEntry("a1", "a2", "user", "cycle a"),
		msgEntry("a2", "a1", "assistant", "cycle b"),
	];
	const file = writeSessionFile(dir, "s.jsonl", entries);
	const branch = readActiveBranch(file);
	assert.ok(branch.entries.length <= 2);
});

// ── Selector parsing ─────────────────────────────────────────────────────────

test("parseSelector tail form", () => {
	assert.deepEqual(parseSelector("-5"), { raw: false, start: -5 });
	assert.deepEqual(parseSelector("raw:-10"), { raw: true, start: -10 });
});

test("parseSelector ranges", () => {
	assert.deepEqual(parseSelector("20-40"), { raw: false, start: 20, end: 40 });
	assert.deepEqual(parseSelector("20-"), { raw: false, start: 20, end: undefined });
	assert.deepEqual(parseSelector("-40"), { raw: false, start: -40 }); // tail, not "up to 40"
	assert.deepEqual(parseSelector("7"), { raw: false, start: 7, end: undefined });
	assert.deepEqual(parseSelector(""), { raw: false });
});

test("parseSelector id form and errors", () => {
	assert.deepEqual(parseSelector("id:abcd1234"), { raw: false, anchorId: "abcd1234" });
	assert.throws(() => parseSelector("id:"));
	assert.throws(() => parseSelector("bogus!"));
	assert.throws(() => parseSelector("-0"));
});

// ── readTranscript end-to-end ────────────────────────────────────────────────

test("readTranscript tail selection returns entries in chronological order", () => {
	const dir = mkdtempSync(join(tmpdir(), "transcript-"));
	const file = writeSessionFile(dir, "s.jsonl", [
		{ type: "session", id: "sess-1", timestamp: "t", cwd: "/x" },
		...fixtureEntries(),
	]);
	const result = readTranscript({
		file,
		selector: parseSelector("-3"),
		includeTools: false,
		origin: "test",
		live: false,
	});
	// Last 3 of the active branch (a2..a4); b-branch not visible.
	assert.deepEqual(result.entries.map((e) => e.id), ["a2", "a3", "a4"]);
	assert.deepEqual(result.entries.map((e) => e.index), [2, 3, 4]);
	assert.deepEqual(result.selection, { start: 2, end: 4 });
	assert.equal(result.stats.offBranchEntries, 2);
});

test("readTranscript default rendering skips toolResult and tool-only assistant messages", () => {
	const dir = mkdtempSync(join(tmpdir(), "transcript-"));
	const entries: FixtureEntry[] = [
		msgEntry("a1", null, "user", "run it"),
		{
			type: "message",
			id: "a2",
			parentId: "a1",
			timestamp: "t",
			message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }], timestamp: 2 },
		},
		{
			type: "message",
			id: "a3",
			parentId: "a2",
			timestamp: "t",
			message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "output here" }], isError: false, timestamp: 3 },
		},
		msgEntry("a4", "a3", "assistant", "done, it worked"),
	];
	const file = writeSessionFile(dir, "s.jsonl", [{ type: "session", id: "s", timestamp: "t", cwd: "/x" }, ...entries]);

	const withoutTools = readTranscript({ file, selector: parseSelector("-20"), includeTools: false, origin: "o", live: false });
	assert.deepEqual(withoutTools.entries.map((e) => e.role), ["user", "assistant"]);
	assert.equal(withoutTools.entries[1]!.text, "done, it worked");

	const withTools = readTranscript({ file, selector: parseSelector("-20"), includeTools: true, origin: "o", live: false });
	assert.deepEqual(withTools.entries.map((e) => e.role), ["user", "assistant", "tool", "assistant"]);
	assert.match(withTools.entries[1]!.text, /\[tool calls: bash\]/);
	assert.match(withTools.entries[2]!.text, /output here/);
});

test("readTranscript id selector truncates upward at the anchor", () => {
	const dir = mkdtempSync(join(tmpdir(), "transcript-"));
	const file = writeSessionFile(dir, "s.jsonl", [
		{ type: "session", id: "s", timestamp: "t", cwd: "/x" },
		...fixtureEntries(),
	]);
	const result = readTranscript({ file, selector: parseSelector("id:a2"), includeTools: false, origin: "o", live: false });
	assert.deepEqual(result.entries.map((e) => e.id), ["a1", "a2"]);
	assert.deepEqual(result.selection, { anchor: "a2" });
});

test("readTranscript raw mode dumps full entries", () => {
	const dir = mkdtempSync(join(tmpdir(), "transcript-"));
	const file = writeSessionFile(dir, "s.jsonl", [
		{ type: "session", id: "s", timestamp: "t", cwd: "/x" },
		...fixtureEntries(),
	]);
	const result = readTranscript({ file, selector: parseSelector("raw:-2"), includeTools: false, origin: "o", live: false });
	assert.ok(result.raw);
	assert.equal(result.raw.length, 2);
	assert.equal(result.raw[1]!.id, "a4");
	assert.deepEqual((result.raw[1]!.entry as { message: { role: string } }).message.role, "assistant");
});

test("readTranscript custom_message entries render under their customType", () => {
	const dir = mkdtempSync(join(tmpdir(), "transcript-"));
	const entries: FixtureEntry[] = [
		msgEntry("a1", null, "user", "go"),
		{
			type: "custom_message",
			id: "c1",
			parentId: "a1",
			timestamp: "t",
			customType: "intercom_message",
			content: "hello from afar",
			display: true,
		},
	];
	const file = writeSessionFile(dir, "s.jsonl", [{ type: "session", id: "s", timestamp: "t", cwd: "/x" }, ...entries]);
	const result = readTranscript({ file, selector: parseSelector("-20"), includeTools: false, origin: "o", live: false });
	assert.deepEqual(result.entries.map((e) => e.role), ["user", "intercom_message"]);
	assert.equal(result.entries[1]!.text, "hello from afar");
});

test("readTranscript clamps oversized entries to the budget", () => {
	const dir = mkdtempSync(join(tmpdir(), "transcript-"));
	const big = "x".repeat(5000);
	const entries: FixtureEntry[] = [msgEntry("a1", null, "user", big), msgEntry("a2", "a1", "assistant", big)];
	const file = writeSessionFile(dir, "s.jsonl", [{ type: "session", id: "s", timestamp: "t", cwd: "/x" }, ...entries]);
	const result = readTranscript({ file, selector: parseSelector("-20"), includeTools: false, origin: "o", live: false, maxChars: 6000 });
	const total = result.entries.reduce((sum, e) => sum + e.text.length, 0);
	assert.ok(total <= 6000 + result.entries.length * 50, `total ${total} over budget`);
	assert.match(result.entries[0]!.text, /truncated \d+ chars/);
});

// ── Session file resolution ──────────────────────────────────────────────────

test("encodeSessionDirName mirrors SessionManager encoding", () => {
	assert.equal(encodeSessionDirName("/home/u/proj"), "--home-u-proj--");
	assert.equal(encodeSessionDirName("/a/b:c"), "--a-b-c--");
});

test("findSessionFile prefers cwd dir, falls back to global scan", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "agent-"));
	const cwdDir = join(agentDir, "sessions", encodeSessionDirName("/home/u/proj"));
	const otherDir = join(agentDir, "sessions", encodeSessionDirName("/elsewhere"));
	mkdirSync(cwdDir, { recursive: true });
	mkdirSync(otherDir, { recursive: true });
	writeFileSync(join(cwdDir, "2026-01-01T00-00-00.000Z_id-1.jsonl"), "{}\n");
	writeFileSync(join(otherDir, "2026-02-01T00-00-00.000Z_id-1.jsonl"), "{}\n");

	const env = { PI_CODING_AGENT_DIR: agentDir };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const inCwd = findSessionFile("id-1", "/home/u/proj");
		assert.ok(inCwd);
		assert.match(inCwd!, /--home-u-proj--/);

		// Unknown cwd: newest duplicate wins.
		const global = findSessionFile("id-1");
		assert.ok(global);
		assert.match(global!, /--elsewhere/);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
	}
});

test("resolveSessionLocation resolves live sessions by name/id/prefix and file: paths", async () => {
	// Back "story" with a real session file so live-session resolution can locate it.
	const agentDir = mkdtempSync(join(tmpdir(), "agent-"));
	const storyDir = join(agentDir, "sessions", encodeSessionDirName("/w"));
	mkdirSync(storyDir, { recursive: true });
	const storyFile = join(storyDir, "2026-01-01T00-00-00.000Z_aaaaaaaa-1111.jsonl");
	writeFileSync(storyFile, JSON.stringify({ type: "session", id: "aaaaaaaa-1111", timestamp: "t", cwd: "/w" }) + "\n");
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const sessions: SessionInfo[] = [
		{ id: "aaaaaaaa-1111", name: "story", cwd: "/w", model: "m", pid: 1, startedAt: 1, lastActivity: 1 },
		{ id: "aaaaaaaa-2222", name: "hero", cwd: "/w", model: "m", pid: 2, startedAt: 1, lastActivity: 1 },
		{ id: "bbbbbbbb-3333", name: "hero", cwd: "/v", model: "m", pid: 3, startedAt: 1, lastActivity: 1 },
	];
	const listSessions = () => Promise.resolve(sessions);

	try {
		const byName = await resolveSessionLocation("story", listSessions);
		assert.equal(byName.session?.id, "aaaaaaaa-1111");
		assert.equal(byName.file, storyFile);

		// A live session without a session file on disk errors instead of
		// silently resolving (only "story" got a file).
		await assert.rejects(() => resolveSessionLocation("aaaaaaaa-2222", listSessions), /could not be located/);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
	}

	// Unknown target with a slash → file path resolution.
	await assert.rejects(() => resolveSessionLocation("file:/no/such/file.jsonl", listSessions), /not found/);
});

test("encodeSessionDirNames emits omp home-relative and pi absolute forms", () => {
	const home = homedir();
	const cwd = join(home, "projects", "demo");
	const names = encodeSessionDirNames(cwd);
	// omp encodes relative to $HOME; pi encodes the absolute path.
	assert.equal(names[0], "-projects-demo");
	assert.ok(names.includes(encodeSessionDirName(cwd)), `missing absolute form: ${names.join(", ")}`);
});

test("findSessionFile resolves omp-style session dirs via the caller's own dir", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-sessions-"));
	const cwd = join(homedir(), "projects", "demo");
	const sessionDir = join(root, "-projects-demo");
	mkdirSync(sessionDir, { recursive: true });
	const file = join(sessionDir, "2026-01-01T00-00-00.000Z_id-omp.jsonl");
	writeFileSync(file, JSON.stringify({ type: "session", id: "id-omp", timestamp: "t", cwd }) + "\n");

	// The caller's session dir pins the omp root even though getAgentDirPath()
	// would only ever hand back ~/.pi/agent.
	assert.equal(findSessionFile("id-omp", cwd, sessionDir), file);
	assert.equal(findSessionFile("id-omp", undefined, sessionDir), file);
	// Without the pin, the cwd-derived dir under the omp root is still found
	// because the default ~/.omp root is searched.
	assert.ok(getSessionRoots(sessionDir)[0] === resolve(root));
});

test("resolveSessionLocation resolves omp peers with a pinned session dir", async () => {
	const root = mkdtempSync(join(tmpdir(), "omp-sessions-"));
	const cwd = join(homedir(), "projects", "demo");
	const sessionDir = join(root, "-projects-demo");
	mkdirSync(sessionDir, { recursive: true });
	const file = join(sessionDir, "2026-01-01T00-00-00.000Z_cccccccc-4444.jsonl");
	writeFileSync(file, JSON.stringify({ type: "session", id: "cccccccc-4444", timestamp: "t", cwd }) + "\n");

	const sessions: SessionInfo[] = [
		{ id: "cccccccc-4444", name: "peer", cwd, model: "m", pid: 1, startedAt: 1, lastActivity: 1 },
	];
	const located = await resolveSessionLocation("peer", () => Promise.resolve(sessions), { sessionDir });
	assert.equal(located.file, file);
	assert.equal(located.live, true);

	// The failure message names the roots it searched, so a miss is diagnosable.
	await assert.rejects(
		() => resolveSessionLocation("dddddddd-5555", () => Promise.resolve([
			{ id: "dddddddd-5555", name: "ghost", cwd, model: "m", pid: 2, startedAt: 1, lastActivity: 1 },
		]), { sessionDir }),
		(err: Error) => err.message.includes("could not be located") && err.message.includes(resolve(root)),
	);
});
