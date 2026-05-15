// fallow-ignore-file unused-file
// fallow-ignore-file unused-export
// fallow-ignore-file code-duplication
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
const READ_ONLY_TOOLS = 'Read,Glob,Grep,LS';
const DEFAULT_TIMEOUT_MS = 300000;
const HOOK_POLL_MS = 250;
// CLI parsing and prompt construction
const readStdin = async () => {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
};
const firstString = (...values) => values.find((value) => typeof value === 'string' && value.trim() !== '') || null;
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const waitUntil = async ({ deadlineMs, getValue, timeoutMessage }) => {
    while (Date.now() < deadlineMs) {
        const value = await getValue();
        if (value !== null)
            return value;
        await sleep(Math.min(HOOK_POLL_MS, Math.max(1, deadlineMs - Date.now())));
    }
    throw new Error(timeoutMessage);
};
const remainingTimeoutMs = (deadlineMs) => {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0)
        throw new Error('Claude TUI adviser timed out before producing a handoff.');
    return remaining;
};
export const buildClaudePrompt = ({ mode, input, cwd = process.cwd() }) => {
    const trimmedInput = input.trim();
    const taskLabel = mode === 'review' ? 'review' : 'plan';
    const requestedOutput = mode === 'review'
        ? [
            'Return a concise code review with:',
            '- confirmed bugs, regressions, missing tests, or contract drift',
            '- uncertain findings clearly marked',
            '- no implementation edits',
        ].join('\n')
        : [
            'Return a concise implementation plan with:',
            '- recommended sequencing',
            '- relevant files and risks',
            '- validation steps',
            '- no implementation edits',
        ].join('\n');
    return [
        `You are advising Codex on a ${taskLabel}.`,
        '',
        'Codex remains responsible for validating your answer before presenting or acting on it.',
        'Inspect the repository as needed using read-only tools. Do not edit files.',
        '',
        `Repository: ${cwd}`,
        '',
        'Codex request:',
        trimmedInput === '' ? '(No additional prompt was provided.)' : trimmedInput,
        '',
        requestedOutput,
    ].join('\n');
};
export const parseArgs = (argv) => {
    const [mode, ...args] = argv;
    if (!isMode(mode)) {
        throw new Error('Usage: claude-tui-adviser.mjs <plan|review> [--timeout-ms <milliseconds>]');
    }
    return { mode, timeoutMs: parseOptions(args) };
};
const isMode = (value) => value === 'plan' || value === 'review';
const parseOptions = (args) => {
    if (args.length === 0)
        return DEFAULT_TIMEOUT_MS;
    if (args[0] !== '--timeout-ms')
        throw new Error(`Unknown option: ${args[0]}`);
    return parseTimeoutOptionValue(args);
};
const parseTimeoutOptionValue = (args) => {
    if (args[1] === undefined) {
        throw new Error('--timeout-ms requires a value.');
    }
    if (args.length > 2)
        throw new Error(`Unknown option: ${args[2]}`);
    return parseTimeoutMs(args[1]);
};
const parseTimeoutMs = (rawValue) => {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0)
        throw new Error('--timeout-ms must be a positive number.');
    return value;
};
// Command execution and tmux command builders
export const buildClaudeArgs = ({ sessionId, settingsPath }) => [
    '--permission-mode',
    'plan',
    '--tools',
    READ_ONLY_TOOLS,
    '--session-id',
    sessionId,
    '--settings',
    settingsPath,
];
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const shellJoin = (values) => values.map(shellQuote).join(' ');
export const buildTmuxStartInvocation = ({ cwd, sessionId, sessionName, settingsPath }) => ({
    command: 'tmux',
    args: [
        'new-session',
        '-d',
        '-s',
        sessionName,
        '-c',
        cwd,
        shellJoin(['claude', ...buildClaudeArgs({ sessionId, settingsPath })]),
    ],
});
export const buildTmuxPromptSubmissionInvocations = ({ bufferName, prompt, sessionName }) => [
    {
        command: 'tmux',
        args: ['set-buffer', '-b', bufferName, prompt],
    },
    {
        command: 'tmux',
        // Preserve multi-line prompts as one bracketed paste before sending Enter.
        args: ['paste-buffer', '-p', '-b', bufferName, '-t', sessionName],
    },
    {
        command: 'tmux',
        args: ['delete-buffer', '-b', bufferName],
    },
    {
        command: 'tmux',
        args: ['send-keys', '-t', sessionName, 'Enter'],
    },
];
const execCommand = async ({ command, args, cwd, input, timeoutMs = 30000 }) => new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        rejectPromise(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.once('error', (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
    });
    child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (code === 0) {
            resolvePromise({ stdout, stderr });
            return;
        }
        rejectPromise(new Error(`${command} exited with ${signal || code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
    if (input === undefined) {
        child.stdin.end();
    }
    else {
        child.stdin.end(input);
    }
});
const assertRuntimeBinary = async ({ command, args, label, timeoutMs }) => {
    try {
        await execCommand({ command, args, timeoutMs });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/ENOENT/.test(message)) {
            throw new Error(`Claude TUI adviser requires ${label} on PATH.`);
        }
        throw new Error(`Claude TUI adviser could not run ${label}: ${message}`);
    }
};
// Runtime hook/settings file creation
const createRuntimeFiles = async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'codex-claude-tui-'));
    const eventLogPath = join(runtimeDir, 'events.jsonl');
    const hookPath = join(runtimeDir, 'hook.mjs');
    const settingsPath = join(runtimeDir, 'settings.json');
    await writeFile(hookPath, [
        "import { appendFileSync } from 'node:fs'",
        '',
        "const event = process.argv[2] || 'unknown'",
        "const chunks = []",
        "const parsePayload = (raw) => {",
        "  try { return JSON.parse(raw) } catch { return {} }",
        '}',
        "process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)))",
        "process.stdin.on('end', () => {",
        "  const stdin = Buffer.concat(chunks).toString('utf8')",
        "  const payload = parsePayload(stdin)",
        "  const record = {",
        "    event,",
        "    at: new Date().toISOString(),",
        "    transcriptPath: payload.transcript_path,",
        "  }",
        "  if (process.env.CODEX_CLAUDE_DEBUG_HOOK_STDIN === '1') record.stdin = stdin",
        "  appendFileSync(process.env.CODEX_CLAUDE_EVENT_LOG, `${JSON.stringify(record)}\\n`)",
        '})',
        'process.stdin.resume()',
        '',
    ].join('\n'));
    const hookCommand = (event) => `CODEX_CLAUDE_EVENT_LOG=${shellQuote(eventLogPath)} node ${shellQuote(hookPath)} ${shellQuote(event)}`;
    const settings = {
        hooks: {
            SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand('SessionStart') }] }],
            Stop: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand('Stop') }] }],
        },
    };
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    return { eventLogPath, hookPath, settingsPath, runtimeDir };
};
// Hook waiting and transcript reading
const readHookEvents = async (eventLogPath) => {
    try {
        const raw = await readFile(eventLogPath, 'utf8');
        return raw.split('\n').filter(Boolean).map((line) => {
            try {
                return JSON.parse(line);
            }
            catch {
                return { event: 'malformed' };
            }
        });
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT')
            return [];
        throw error;
    }
};
const waitForHookEvent = async ({ deadlineMs, event, eventLogPath }) => waitUntil({
    deadlineMs,
    timeoutMessage: `Claude TUI adviser timed out waiting for ${event}.`,
    getValue: async () => {
        const events = await readHookEvents(eventLogPath);
        return events.find((entry) => entry.event === event) || null;
    },
});
const isNodeError = (error) => error instanceof Error && 'code' in error;
export const projectDirectoryName = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
const fileExists = async (path) => {
    try {
        await access(path);
        return true;
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT')
            return false;
        throw error;
    }
};
const deterministicTranscriptPaths = ({ cwd, sessionId, claudeHome }) => [
    join(claudeHome, 'projects', projectDirectoryName(cwd), `${sessionId}.jsonl`),
    join(claudeHome, 'transcripts', `${sessionId}.jsonl`),
];
const transcriptCandidatePaths = ({ claudeHome, cwd, sessionId, stopEvent }) => [
    firstString(stopEvent.transcriptPath),
    ...deterministicTranscriptPaths({ cwd, sessionId, claudeHome }),
].filter((path) => path !== null);
const firstExistingPath = async (paths) => {
    for (const path of paths) {
        if (await fileExists(path))
            return path;
    }
    return null;
};
const parseJsonLine = (line) => {
    try {
        return JSON.parse(line);
    }
    catch {
        return null;
    }
};
const isRecord = (value) => typeof value === 'object' && value !== null;
const toRecord = (value) => (isRecord(value) ? value : null);
const extractTextFromContent = (content) => {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return null;
    const text = content
        .map((block) => {
        if (!isRecord(block))
            return null;
        return block.type === 'text' ? firstString(block.text) : null;
    })
        .filter((value) => value !== null)
        .join('\n')
        .trim();
    return text === '' ? null : text;
};
const extractAssistantText = (entry) => {
    const record = toRecord(entry);
    return record === null ? null : extractAssistantRecordText(record);
};
const extractAssistantRecordText = (entry) => {
    const message = transcriptMessage(entry);
    if (!isAssistantEntry({ entry, message }))
        return null;
    return extractTextFromContent(assistantContent({ entry, message }));
};
const transcriptMessage = (entry) => (isRecord(entry.message) ? entry.message : null);
const assistantContent = ({ entry, message }) => (message === null ? entry.content : message.content);
const isAssistantEntry = ({ entry, message }) => firstString(message?.role) === 'assistant' || firstString(entry.type) === 'assistant';
export const parseTranscriptAnswer = (raw) => {
    const lines = raw.split('\n').filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const answer = extractAssistantText(parseJsonLine(lines[index]));
        if (answer !== null)
            return answer;
    }
    return null;
};
export const resolveClaudeTranscriptPath = async ({ claudeHome = join(homedir(), '.claude'), cwd, sessionId, stopEvent, }) => firstExistingPath(transcriptCandidatePaths({ claudeHome, cwd, sessionId, stopEvent }));
const waitForTranscriptAnswer = async ({ cwd, deadlineMs, sessionId, stopEvent }) => waitUntil({
    deadlineMs,
    timeoutMessage: 'Claude TUI adviser could not find a final assistant answer in the Claude transcript.',
    getValue: async () => {
        const transcriptPath = await resolveClaudeTranscriptPath({ cwd, sessionId, stopEvent });
        if (transcriptPath === null)
            return null;
        return parseTranscriptAnswer(await readFile(transcriptPath, 'utf8'));
    },
});
// Session orchestration
export const buildHandoff = ({ answer, cwd, mode, sessionId }) => ({
    ok: true,
    schemaVersion: 1,
    mode,
    sessionId,
    cwd,
    createdAt: new Date().toISOString(),
    source: 'claude-tui',
    answer,
});
export const runAdviser = async ({ mode, input, timeoutMs, cwd = process.cwd() }) => {
    const deadlineMs = Date.now() + timeoutMs;
    await assertRuntimeBinary({
        command: 'tmux',
        args: ['-V'],
        label: '`tmux`',
        timeoutMs: remainingTimeoutMs(deadlineMs),
    });
    await assertRuntimeBinary({
        command: 'claude',
        args: ['--version'],
        label: 'Claude Code CLI `claude`',
        timeoutMs: remainingTimeoutMs(deadlineMs),
    });
    const sessionId = randomUUID();
    const sessionName = `codex-claude-${sessionId.slice(0, 8)}`;
    const prompt = buildClaudePrompt({ mode, input, cwd });
    const runtimeFiles = await createRuntimeFiles();
    try {
        return await runAdviserSession({ cwd, deadlineMs, mode, prompt, runtimeFiles, sessionId, sessionName });
    }
    catch (error) {
        throw await appendTmuxPaneToError({ error, sessionName });
    }
    finally {
        await killTmuxSession(sessionName);
        await cleanupRuntimeFiles(runtimeFiles.runtimeDir);
    }
};
const captureTmuxPane = async (sessionName) => {
    try {
        const { stdout } = await execCommand({
            command: 'tmux',
            args: ['capture-pane', '-p', '-t', sessionName],
        });
        return stdout.trim();
    }
    catch {
        return null;
    }
};
const killTmuxSession = async (sessionName) => {
    try {
        await execCommand({ command: 'tmux', args: ['kill-session', '-t', sessionName] });
    }
    catch {
        // The Claude process may have exited and removed the tmux session already.
    }
};
const cleanupRuntimeFiles = async (runtimeDir) => {
    if (process.env.CODEX_CLAUDE_KEEP_RUNTIME_DIR === '1')
        return;
    try {
        await rm(runtimeDir, { force: true, recursive: true });
    }
    catch {
        // Runtime directory cleanup is best-effort and must not mask the adviser result.
    }
};
const runAdviserSession = async ({ cwd, deadlineMs, mode, prompt, runtimeFiles, sessionId, sessionName }) => {
    const { command, args } = buildTmuxStartInvocation({
        cwd,
        sessionId,
        sessionName,
        settingsPath: runtimeFiles.settingsPath,
    });
    await execCommand({ command, args, cwd, timeoutMs: remainingTimeoutMs(deadlineMs) });
    await waitForHookEvent({ deadlineMs, event: 'SessionStart', eventLogPath: runtimeFiles.eventLogPath });
    await submitPromptToClaudeTui({ deadlineMs, prompt, sessionName });
    const stopEvent = await waitForHookEvent({ deadlineMs, event: 'Stop', eventLogPath: runtimeFiles.eventLogPath });
    const answer = await waitForTranscriptAnswer({ cwd, deadlineMs, sessionId, stopEvent });
    return buildHandoff({ answer, cwd, mode, sessionId });
};
const submitPromptToClaudeTui = async ({ deadlineMs, prompt, sessionName }) => {
    const bufferName = `${sessionName}-prompt`;
    for (const { command, args } of buildTmuxPromptSubmissionInvocations({ bufferName, prompt, sessionName })) {
        await execCommand({ command, args, timeoutMs: remainingTimeoutMs(deadlineMs) });
    }
};
const appendTmuxPaneToError = async ({ error, sessionName }) => {
    const capturedPane = await captureTmuxPane(sessionName);
    const message = error instanceof Error ? error.message : String(error);
    return new Error(capturedPane === null ? message : `${message}\n\nLast tmux pane:\n${capturedPane}`);
};
// Error classification and CLI entrypoint
export const classifyLaunchFailure = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    const knownFailure = [
        [/requires tmux on PATH|spawn tmux ENOENT/, 'Claude TUI adviser requires `tmux` on PATH.'],
        [/requires Claude Code CLI on PATH|spawn claude ENOENT/, 'Claude TUI adviser requires `claude` on PATH.'],
        [/timed out waiting for Stop|timed out after/, 'Claude TUI adviser timed out before producing a handoff.'],
        [/could not find a final assistant answer/, 'Claude TUI adviser could not find a final assistant answer in the Claude transcript.'],
    ].find(([pattern]) => pattern.test(message));
    return knownFailure?.[1] || `Claude TUI adviser failed: ${message}`;
};
const main = async () => {
    const { mode, timeoutMs } = parseArgs(process.argv.slice(2));
    const input = await readStdin();
    const handoff = await runAdviser({ mode, input, timeoutMs });
    process.stdout.write(`${JSON.stringify(handoff, null, 2)}\n`);
};
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error) => {
        console.error(classifyLaunchFailure(error));
        process.exitCode = 1;
    });
}
