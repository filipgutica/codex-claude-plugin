// fallow-ignore-file unused-file
// fallow-ignore-file unused-export
// fallow-ignore-file code-duplication
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
const READ_ONLY_TOOLS = 'Read,Glob,Grep,LS';
const REVIEW_MODEL = 'sonnet';
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_IDLE_TIMEOUT_MS = 120000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const HOOK_POLL_MS = 250;
const PANE_STREAM_POLL_MS = 1000;
const PANE_STREAM_HEARTBEAT_MS = 30000;
const PANE_STREAM_MAX_LINES = 60;
const PROMPT_SUBMIT_CONFIRM_DELAY_MS = 250;
const STREAM_PANE_ENV = 'CODEX_CLAUDE_STREAM_PANE';
const IDLE_TIMEOUT_ENV = 'CODEX_CLAUDE_IDLE_TIMEOUT_MS';
const HARD_TIMEOUT_ENV = 'CODEX_CLAUDE_HARD_TIMEOUT_MS';
const CLAUDE_HOME_ENV = 'CODEX_CLAUDE_HOME';
const QUESTION_PREFIX = 'QUESTION_FOR_CODEX:';
const CLAUDE_PROGRESS_LINE_PATTERN = /^\s*[✻✢✳✽✶·]\s+.{1,80}(?:…|\.{3})(?:\s+\([^)]*\))?\s*$/u;
// CLI parsing and prompt construction
const readStdin = async () => {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
};
const readInput = async ({ prompt, promptFile }) => {
    assertSingleTextInput({ left: prompt, leftLabel: '--prompt', right: promptFile, rightLabel: '--prompt-file' });
    return await readProvidedPrompt({ prompt, promptFile }) ?? await readStdin();
};
const readAnswer = async ({ answer, answerFile }) => {
    assertSingleTextInput({ left: answer, leftLabel: '--answer', right: answerFile, rightLabel: '--answer-file' });
    return await readProvidedPrompt({ prompt: answer, promptFile: answerFile }) ?? await readStdin();
};
const readProvidedPrompt = async ({ prompt, promptFile }) => {
    if (prompt !== undefined)
        return prompt;
    if (promptFile !== undefined)
        return readFile(promptFile, 'utf8');
    return null;
};
const firstString = (...values) => values.find((value) => typeof value === 'string' && value.trim() !== '') || null;
const claudeHomePath = () => process.env[CLAUDE_HOME_ENV] || join(homedir(), '.claude');
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const waitUntil = async ({ getValue, watchdog }) => {
    while (true) {
        const value = await getValue();
        if (value !== null)
            return value;
        await watchdog.check();
        await sleep(watchdog.pollDelayMs());
    }
};
export const isPaneStreamingEnabled = () => {
    const value = process.env[STREAM_PANE_ENV]?.toLowerCase();
    return value === undefined || !['0', 'false', 'off', 'no'].includes(value);
};
const commandTimeoutMs = (hardTimeoutAtMs) => {
    if (hardTimeoutAtMs === undefined)
        return DEFAULT_COMMAND_TIMEOUT_MS;
    const remaining = hardTimeoutAtMs - Date.now();
    if (remaining <= 0)
        throw new Error('Claude TUI adviser reached the configured hard timeout before producing a handoff.');
    return Math.min(DEFAULT_COMMAND_TIMEOUT_MS, remaining);
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
        'Work interactively with Codex. If you are blocked by missing requirements, ask exactly one clarification question.',
        `Start that question with ${QUESTION_PREFIX} and then wait for Codex to answer before continuing.`,
        'Do not use that prefix in your final answer.',
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
        throw new Error('Usage: claude-tui-adviser.mjs <plan|review> [--timeout-ms <milliseconds>] [--idle-timeout-ms <milliseconds>] [--hard-timeout-ms <milliseconds>] [--prompt <text> | --prompt-file <path> | --resume <state-path> (--answer <text> | --answer-file <path>)]');
    }
    return { mode, ...parseOptions(args) };
};
const isMode = (value) => value === 'plan' || value === 'review';
const parseOptions = (args) => {
    const hardTimeoutMs = parseOptionalTimeoutMs(process.env[HARD_TIMEOUT_ENV], HARD_TIMEOUT_ENV);
    const parsed = {
        timeoutMs: DEFAULT_TIMEOUT_MS,
        idleTimeoutMs: parseOptionalTimeoutMs(process.env[IDLE_TIMEOUT_ENV], IDLE_TIMEOUT_ENV) ?? DEFAULT_IDLE_TIMEOUT_MS,
    };
    if (hardTimeoutMs !== null)
        parsed.hardTimeoutMs = hardTimeoutMs;
    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        const value = optionValue({ args, index, option });
        applyOption({ parsed, option, value });
        index += 1;
    }
    assertInputMode(parsed);
    return parsed;
};
const optionValue = ({ args, index, option }) => {
    const value = args[index + 1];
    if (value === undefined)
        throw new Error(`${option} requires a value.`);
    return value;
};
const applyOption = ({ parsed, option, value }) => {
    const optionHandlers = {
        '--timeout-ms': () => {
            parsed.timeoutMs = parseTimeoutMs(value, '--timeout-ms');
        },
        '--idle-timeout-ms': () => {
            parsed.idleTimeoutMs = parseTimeoutMs(value, '--idle-timeout-ms');
        },
        '--hard-timeout-ms': () => {
            parsed.hardTimeoutMs = parseTimeoutMs(value, '--hard-timeout-ms');
        },
        '--resume': () => {
            parsed.resumeFile = value;
        },
        '--answer': () => {
            parsed.answer = value;
        },
        '--answer-file': () => {
            parsed.answerFile = value;
        },
        '--prompt': () => {
            parsed.prompt = value;
        },
        '--prompt-file': () => {
            parsed.promptFile = value;
        },
    };
    const handler = optionHandlers[option];
    if (handler === undefined)
        throw new Error(`Unknown option: ${option}`);
    handler();
};
const assertInputMode = (options) => {
    const { answer, answerFile, prompt, promptFile } = options;
    assertSingleTextInput({ left: prompt, leftLabel: '--prompt', right: promptFile, rightLabel: '--prompt-file' });
    assertSingleTextInput({ left: answer, leftLabel: '--answer', right: answerFile, rightLabel: '--answer-file' });
    assertAnswerRequiresResume(options);
    assertResumeExcludesPrompt(options);
};
const assertAnswerRequiresResume = ({ answer, answerFile, resumeFile }) => {
    if (resumeFile === undefined && (answer !== undefined || answerFile !== undefined)) {
        throw new Error('Use --answer or --answer-file only with --resume.');
    }
};
const assertResumeExcludesPrompt = ({ prompt, promptFile, resumeFile }) => {
    if (resumeFile !== undefined && (prompt !== undefined || promptFile !== undefined)) {
        throw new Error('Use --resume with --answer or --answer-file, not --prompt or --prompt-file.');
    }
};
const assertSingleTextInput = ({ left, leftLabel, right, rightLabel }) => {
    if (left !== undefined && right !== undefined)
        throw new Error(`Use only one of ${leftLabel} or ${rightLabel}.`);
};
const parseTimeoutMs = (rawValue, label) => {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0)
        throw new Error(`${label} must be a positive number.`);
    return value;
};
const parseOptionalTimeoutMs = (rawValue, label) => rawValue === undefined || rawValue.trim() === '' ? null : parseTimeoutMs(rawValue, label);
// Command execution and tmux command builders
export const buildClaudeArgs = ({ mode, sessionId, settingsPath }) => [
    ...(mode === 'plan' ? ['--permission-mode', 'plan'] : ['--model', REVIEW_MODEL]),
    '--tools',
    READ_ONLY_TOOLS,
    '--session-id',
    sessionId,
    '--settings',
    settingsPath,
];
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const shellJoin = (values) => values.map(shellQuote).join(' ');
export const buildTmuxStartInvocation = ({ cwd, mode, sessionId, sessionName, settingsPath }) => ({
    command: 'tmux',
    args: [
        'new-session',
        '-d',
        '-s',
        sessionName,
        '-c',
        cwd,
        shellJoin(['claude', ...buildClaudeArgs({ mode, sessionId, settingsPath })]),
    ],
});
export const buildTmuxPromptSubmissionInvocations = ({ bufferName, promptPath, sessionName }) => [
    {
        command: 'tmux',
        args: ['load-buffer', '-b', bufferName, promptPath],
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
    const promptPath = join(runtimeDir, 'prompt.txt');
    const settingsPath = join(runtimeDir, 'settings.json');
    const statePath = join(runtimeDir, 'session.json');
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
    return { eventLogPath, hookPath, promptPath, settingsPath, statePath, runtimeDir };
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
const waitForHookEvent = async ({ event, eventLogPath, watchdog }) => {
    let seenEventCount = 0;
    return waitUntil({
        watchdog,
        getValue: async () => {
            const events = await readHookEvents(eventLogPath);
            if (events.length > seenEventCount) {
                seenEventCount = events.length;
                watchdog.markActivity();
            }
            return events.find((entry) => entry.event === event) || null;
        },
    });
};
const waitForStopOrQuestion = async ({ cwd, eventLogPath, ignoredQuestion = '', sessionId, watchdog }) => {
    const state = { seenEventCount: 0, lastQuestion: ignoredQuestion };
    return waitUntil({
        watchdog,
        getValue: () => readStopOrQuestion({ cwd, eventLogPath, onActivity: watchdog.markActivity, sessionId, state }),
    });
};
const readStopOrQuestion = async ({ cwd, eventLogPath, onActivity, sessionId, state }) => {
    const events = await readHookEvents(eventLogPath);
    recordHookActivity({ eventCount: events.length, onActivity, state });
    const stopEvent = events.find((entry) => entry.event === 'Stop');
    const question = await readNewQuestion({ cwd, onActivity, sessionId, state });
    if (question !== null)
        return question;
    if (stopEvent !== undefined)
        return { kind: 'stop', stopEvent };
    return null;
};
const recordHookActivity = ({ eventCount, onActivity, state }) => {
    if (eventCount <= state.seenEventCount)
        return;
    state.seenEventCount = eventCount;
    onActivity();
};
const readNewQuestion = async ({ cwd, onActivity, sessionId, state }) => {
    const question = await readTranscriptQuestionIfAvailable({ cwd, sessionId });
    if (question === null || question === state.lastQuestion)
        return null;
    state.lastQuestion = question;
    onActivity();
    return { kind: 'question', question };
};
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
export const extractCodexQuestion = (text) => {
    const prefixIndex = text.lastIndexOf(QUESTION_PREFIX);
    if (prefixIndex === -1)
        return null;
    const question = text.slice(prefixIndex + QUESTION_PREFIX.length).trim();
    return question === '' ? null : question;
};
export const resolveClaudeTranscriptPath = async ({ claudeHome = claudeHomePath(), cwd, sessionId, stopEvent, }) => firstExistingPath(transcriptCandidatePaths({ claudeHome, cwd, sessionId, stopEvent }));
const waitForTranscriptAnswer = async ({ cwd, sessionId, stopEvent, watchdog }) => {
    let lastTranscriptSignature = '';
    return waitUntil({
        watchdog,
        getValue: async () => {
            const result = await readTranscriptAnswerIfAvailable({ cwd, sessionId, stopEvent });
            if (result === null)
                return null;
            if (result.signature !== lastTranscriptSignature) {
                lastTranscriptSignature = result.signature;
                watchdog.markActivity();
            }
            return result.answer;
        },
    });
};
const readTranscriptAnswerIfAvailable = async ({ cwd, sessionId, stopEvent }) => {
    const transcriptPath = await resolveClaudeTranscriptPath({ cwd, sessionId, stopEvent });
    if (transcriptPath === null)
        return null;
    const signature = await fileActivitySignature(transcriptPath);
    if (signature === null)
        return null;
    const answer = parseTranscriptAnswer(await readFile(transcriptPath, 'utf8'));
    return answer === null ? null : { answer, signature };
};
const readTranscriptQuestionIfAvailable = async ({ cwd, sessionId }) => {
    const transcriptPath = await resolveClaudeTranscriptPath({ cwd, sessionId, stopEvent: { event: 'Stop' } });
    if (transcriptPath === null)
        return null;
    const answer = parseTranscriptAnswer(await readFile(transcriptPath, 'utf8'));
    return answer === null ? null : extractCodexQuestion(answer);
};
// Session orchestration
export const buildHandoff = ({ answer, cwd, mode, sessionId }) => ({
    ok: true,
    schemaVersion: 1,
    status: 'complete',
    mode,
    sessionId,
    cwd,
    createdAt: new Date().toISOString(),
    source: 'claude-tui',
    answer,
});
const buildQuestionHandoff = ({ cwd, mode, question, sessionId, sessionName, statePath }) => ({
    ok: true,
    schemaVersion: 1,
    status: 'needs_input',
    mode,
    sessionId,
    cwd,
    createdAt: new Date().toISOString(),
    source: 'claude-tui',
    question,
    tmuxSession: sessionName,
    statePath,
    attachCommand: `tmux attach -t ${shellQuote(sessionName)}`,
    resumeCommand: `codex-claude-${mode} --resume ${shellQuote(statePath)} --answer ${shellQuote('<answer>')}`,
});
const sessionState = ({ cwd, mode, question, runtimeFiles, sessionId, sessionName }) => ({
    schemaVersion: 1,
    cwd,
    mode,
    sessionId,
    sessionName,
    runtimeFiles,
    lastQuestion: question,
    createdAt: new Date().toISOString(),
});
const writeSessionState = async (state) => {
    await writeFile(state.runtimeFiles.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
};
const readSessionState = async (statePath) => {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (state.schemaVersion !== 1)
        throw new Error(`Unsupported Claude TUI adviser session state at ${statePath}.`);
    return state;
};
export const runAdviser = async ({ cwd = process.cwd(), hardTimeoutMs, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, input, mode, timeoutMs, }) => {
    const hardTimeoutAtMs = hardTimeoutMs === undefined ? undefined : Date.now() + hardTimeoutMs;
    let keepSession = false;
    await assertRuntimeBinary({
        command: 'tmux',
        args: ['-V'],
        label: '`tmux`',
        timeoutMs: commandTimeoutMs(hardTimeoutAtMs),
    });
    await assertRuntimeBinary({
        command: 'claude',
        args: ['--version'],
        label: 'Claude Code CLI `claude`',
        timeoutMs: commandTimeoutMs(hardTimeoutAtMs),
    });
    const sessionId = randomUUID();
    const sessionName = `codex-claude-${sessionId.slice(0, 8)}`;
    const prompt = buildClaudePrompt({ mode, input, cwd });
    const runtimeFiles = await createRuntimeFiles();
    await writeFile(runtimeFiles.promptPath, prompt, 'utf8');
    try {
        const result = await runAdviserSession({
            cwd,
            hardTimeoutMs,
            healthCheckIntervalMs: timeoutMs,
            idleTimeoutMs,
            mode,
            runtimeFiles,
            sessionId,
            sessionName,
        });
        keepSession = result.status === 'needs_input';
        return result;
    }
    catch (error) {
        throw await appendTmuxPaneToError({ error, sessionName });
    }
    finally {
        if (!keepSession) {
            await killTmuxSession(sessionName);
            await cleanupRuntimeFiles(runtimeFiles.runtimeDir);
        }
    }
};
const runAdviserResume = async ({ answer, hardTimeoutMs, idleTimeoutMs, mode, resumeFile, timeoutMs, }) => {
    const state = await readSessionState(resumeFile);
    if (state.mode !== mode)
        throw new Error(`Claude TUI adviser session state is for ${state.mode}, not ${mode}.`);
    let keepSession = false;
    try {
        const result = await resumeAdviserSession({
            answer,
            hardTimeoutMs,
            healthCheckIntervalMs: timeoutMs,
            idleTimeoutMs,
            state,
        });
        keepSession = result.status === 'needs_input';
        return result;
    }
    catch (error) {
        throw await appendTmuxPaneToError({ error, sessionName: state.sessionName });
    }
    finally {
        if (!keepSession) {
            await killTmuxSession(state.sessionName);
            await cleanupRuntimeFiles(state.runtimeFiles.runtimeDir);
        }
    }
};
const captureTmuxPane = async (sessionName, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) => {
    try {
        const { stdout } = await execCommand({
            command: 'tmux',
            args: ['capture-pane', '-p', '-t', sessionName],
            timeoutMs,
        });
        return stdout.trim();
    }
    catch {
        return null;
    }
};
const createPaneStreamer = ({ onActivity, sessionName }) => {
    if (!isPaneStreamingEnabled())
        return { stop: () => undefined };
    let lastFingerprint = '';
    let lastStreamedAt = 0;
    const streamPane = async () => {
        const snapshot = await capturePaneStreamSnapshot(sessionName);
        if (snapshot === null)
            return;
        const now = Date.now();
        const fingerprint = paneStreamFingerprint(snapshot);
        recordPaneStreamActivity({ fingerprint, lastFingerprint, onActivity });
        if (!shouldStreamPane({ fingerprint, lastFingerprint, lastStreamedAt, now }))
            return;
        lastFingerprint = fingerprint;
        lastStreamedAt = now;
        process.stderr.write(`\n[${sessionName} pane]\n${snapshot}\n`);
    };
    const interval = setInterval(() => {
        void streamPane();
    }, PANE_STREAM_POLL_MS);
    void streamPane();
    return {
        stop: () => clearInterval(interval),
    };
};
const capturePaneStreamSnapshot = async (sessionName) => {
    const pane = await captureTmuxPane(sessionName);
    return pane === null ? null : paneStreamSnapshot(pane);
};
const recordPaneStreamActivity = ({ fingerprint, lastFingerprint, onActivity }) => {
    if (isNewPaneActivity({ fingerprint, lastFingerprint })) {
        onActivity?.();
    }
};
const isNewPaneActivity = ({ fingerprint, lastFingerprint }) => fingerprint !== '' && fingerprint !== lastFingerprint;
const shouldStreamPane = ({ fingerprint, lastFingerprint, lastStreamedAt, now }) => fingerprint !== lastFingerprint || now - lastStreamedAt >= PANE_STREAM_HEARTBEAT_MS;
const inspectTmuxPaneState = async ({ sessionName, timeoutMs }) => {
    await assertTmuxSessionExists({ sessionName, timeoutMs });
    assertTmuxPaneIsAlive(await readTmuxPaneState({ sessionName, timeoutMs }));
};
const assertTmuxSessionExists = async ({ sessionName, timeoutMs }) => {
    try {
        await execCommand({ command: 'tmux', args: ['has-session', '-t', sessionName], timeoutMs });
    }
    catch {
        throw new Error('Claude TUI adviser tmux session disappeared before producing a handoff.');
    }
};
const readTmuxPaneState = async ({ sessionName, timeoutMs }) => {
    const { stdout } = await execCommand({
        command: 'tmux',
        args: ['display-message', '-p', '-t', sessionName, '#{pane_dead} #{pane_current_command}'],
        timeoutMs,
    });
    const [paneDead, currentCommand = ''] = stdout.trim().split(/\s+/);
    return { currentCommand, paneDead };
};
const assertTmuxPaneIsAlive = ({ paneDead }) => {
    if (paneDead === '1')
        throw new Error('Claude TUI adviser Claude process exited before producing a handoff.');
};
const fileActivitySignature = async (path) => {
    try {
        const entry = await stat(path);
        return `${entry.size}:${entry.mtimeMs}`;
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT')
            return null;
        throw error;
    }
};
const createSessionWatchdog = ({ cwd, hardTimeoutMs, healthCheckIntervalMs, sessionId, sessionName }) => {
    const startedAtMs = Date.now();
    const hardTimeoutAtMs = hardTimeoutMs === undefined ? undefined : startedAtMs + hardTimeoutMs;
    const activityCheckIntervalMs = Math.min(PANE_STREAM_POLL_MS, healthCheckIntervalMs);
    const transcriptStates = new Map();
    let lastActivityAtMs = startedAtMs;
    let lastPaneFingerprint = '';
    let nextActivityCheckAtMs = startedAtMs;
    let nextHealthCheckAtMs = startedAtMs + healthCheckIntervalMs;
    const markActivity = () => {
        lastActivityAtMs = Date.now();
    };
    const commandTimeout = () => commandTimeoutMs(hardTimeoutAtMs);
    const recordPaneActivity = async () => {
        const pane = await captureTmuxPane(sessionName, commandTimeout());
        if (pane === null)
            return;
        const fingerprint = paneStreamFingerprint(paneStreamSnapshot(pane));
        if (fingerprint !== '' && fingerprint !== lastPaneFingerprint)
            markActivity();
        lastPaneFingerprint = fingerprint;
    };
    const recordTranscriptActivity = async () => {
        const paths = deterministicTranscriptPaths({ cwd, sessionId, claudeHome: claudeHomePath() });
        for (const path of paths) {
            const signature = await fileActivitySignature(path);
            if (signature === null)
                continue;
            const previousSignature = transcriptStates.get(path);
            if (previousSignature !== signature)
                markActivity();
            transcriptStates.set(path, signature);
        }
    };
    const inspectActivity = async () => {
        await inspectTmuxPaneState({ sessionName, timeoutMs: commandTimeout() });
        await recordPaneActivity();
        await recordTranscriptActivity();
    };
    const check = async () => {
        const now = Date.now();
        assertHardTimeout({ hardTimeoutAtMs, now });
        if (isDue({ nextAtMs: nextActivityCheckAtMs, now })) {
            await inspectActivity();
            nextActivityCheckAtMs = now + activityCheckIntervalMs;
        }
        if (isDue({ nextAtMs: nextHealthCheckAtMs, now })) {
            process.stderr.write('Claude is still running; continuing to wait for the handoff\n');
            nextHealthCheckAtMs = now + healthCheckIntervalMs;
        }
    };
    const pollDelayMs = () => {
        const now = Date.now();
        return Math.max(1, Math.min(HOOK_POLL_MS, nextActivityCheckAtMs - now, nextHealthCheckAtMs - now, hardTimeoutAtMs === undefined ? HOOK_POLL_MS : hardTimeoutAtMs - now));
    };
    return { check, commandTimeoutMs: commandTimeout, markActivity, pollDelayMs };
};
const isDue = ({ nextAtMs, now }) => now >= nextAtMs;
const assertHardTimeout = ({ hardTimeoutAtMs, now }) => {
    if (hardTimeoutAtMs !== undefined && now >= hardTimeoutAtMs) {
        throw new Error('Claude TUI adviser reached the configured hard timeout before producing a handoff.');
    }
};
export const paneStreamSnapshot = (pane) => pane
    .split('\n')
    .slice(-PANE_STREAM_MAX_LINES)
    .join('\n')
    .trim();
export const paneStreamFingerprint = (pane) => pane
    .split('\n')
    .map(normalizePaneLineForStreaming)
    .filter((line) => line.trim() !== '')
    .join('\n')
    .trim();
const normalizePaneLineForStreaming = (line) => {
    if (CLAUDE_PROGRESS_LINE_PATTERN.test(line)) {
        return '<claude-progress>';
    }
    return line
        .replace(/\d+(?:\.\d+)?k tokens|\d+ tokens/g, '<tokens>')
        .replace(/(?:\d+m\s+)?\d+s(?=\s*(?:·|\)|$))/g, '<elapsed>');
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
const runAdviserSession = async ({ cwd, hardTimeoutMs, healthCheckIntervalMs, idleTimeoutMs, mode, runtimeFiles, sessionId, sessionName, }) => {
    const watchdog = createSessionWatchdog({
        cwd,
        hardTimeoutMs,
        healthCheckIntervalMs,
        sessionId,
        sessionName,
    });
    const { command, args } = buildTmuxStartInvocation({
        cwd,
        mode,
        sessionId,
        sessionName,
        settingsPath: runtimeFiles.settingsPath,
    });
    await execCommand({ command, args, cwd, timeoutMs: watchdog.commandTimeoutMs() });
    const paneStreamer = createPaneStreamer({ onActivity: watchdog.markActivity, sessionName });
    try {
        await waitForHookEvent({ event: 'SessionStart', eventLogPath: runtimeFiles.eventLogPath, watchdog });
        await submitPromptToClaudeTui({ promptPath: runtimeFiles.promptPath, sessionName, watchdog });
        const result = await waitForStopOrQuestion({ cwd, eventLogPath: runtimeFiles.eventLogPath, sessionId, watchdog });
        if (result.kind === 'question') {
            await writeSessionState(sessionState({
                cwd,
                mode,
                question: result.question,
                runtimeFiles,
                sessionId,
                sessionName,
            }));
            return buildQuestionHandoff({
                cwd,
                mode,
                question: result.question,
                sessionId,
                sessionName,
                statePath: runtimeFiles.statePath,
            });
        }
        const answer = await waitForTranscriptAnswer({ cwd, sessionId, stopEvent: result.stopEvent, watchdog });
        const question = extractCodexQuestion(answer);
        if (question !== null) {
            await writeSessionState(sessionState({
                cwd,
                mode,
                question,
                runtimeFiles,
                sessionId,
                sessionName,
            }));
            return buildQuestionHandoff({
                cwd,
                mode,
                question,
                sessionId,
                sessionName,
                statePath: runtimeFiles.statePath,
            });
        }
        return buildHandoff({ answer, cwd, mode, sessionId });
    }
    finally {
        paneStreamer.stop();
    }
};
const resumeAdviserSession = async ({ answer, hardTimeoutMs, healthCheckIntervalMs, idleTimeoutMs, state }) => {
    const watchdog = createSessionWatchdog({
        cwd: state.cwd,
        hardTimeoutMs,
        healthCheckIntervalMs,
        sessionId: state.sessionId,
        sessionName: state.sessionName,
    });
    const paneStreamer = createPaneStreamer({ onActivity: watchdog.markActivity, sessionName: state.sessionName });
    try {
        await inspectTmuxPaneState({ sessionName: state.sessionName, timeoutMs: watchdog.commandTimeoutMs() });
        await writeFile(state.runtimeFiles.promptPath, buildClaudeAnswer(answer), 'utf8');
        await submitPromptToClaudeTui({
            promptPath: state.runtimeFiles.promptPath,
            sessionName: state.sessionName,
            watchdog,
        });
        const result = await waitForStopOrQuestion({
            cwd: state.cwd,
            eventLogPath: state.runtimeFiles.eventLogPath,
            ignoredQuestion: state.lastQuestion,
            sessionId: state.sessionId,
            watchdog,
        });
        if (result.kind === 'question') {
            await writeSessionState({ ...state, lastQuestion: result.question });
            return buildQuestionHandoff({
                cwd: state.cwd,
                mode: state.mode,
                question: result.question,
                sessionId: state.sessionId,
                sessionName: state.sessionName,
                statePath: state.runtimeFiles.statePath,
            });
        }
        const finalAnswer = await waitForTranscriptAnswer({
            cwd: state.cwd,
            sessionId: state.sessionId,
            stopEvent: result.stopEvent,
            watchdog,
        });
        const question = extractCodexQuestion(finalAnswer);
        if (question !== null && question !== state.lastQuestion) {
            await writeSessionState({ ...state, lastQuestion: question });
            return buildQuestionHandoff({
                cwd: state.cwd,
                mode: state.mode,
                question,
                sessionId: state.sessionId,
                sessionName: state.sessionName,
                statePath: state.runtimeFiles.statePath,
            });
        }
        return buildHandoff({ answer: finalAnswer, cwd: state.cwd, mode: state.mode, sessionId: state.sessionId });
    }
    finally {
        paneStreamer.stop();
    }
};
const buildClaudeAnswer = (answer) => [
    'Codex answer to your clarification question:',
    '',
    answer.trim() === '' ? '(No additional answer was provided.)' : answer.trim(),
].join('\n');
const submitPromptToClaudeTui = async ({ promptPath, sessionName, watchdog }) => {
    const bufferName = `${sessionName}-prompt`;
    for (const { command, args } of buildTmuxPromptSubmissionInvocations({ bufferName, promptPath, sessionName })) {
        await execCommand({ command, args, timeoutMs: watchdog.commandTimeoutMs() });
    }
    await retryPromptSubmitIfStillVisible({ promptPath, sessionName, watchdog });
};
const retryPromptSubmitIfStillVisible = async ({ promptPath, sessionName, watchdog }) => {
    const prompt = await readFile(promptPath, 'utf8');
    const snippet = promptVisibleSnippet(prompt);
    if (snippet === null)
        return;
    await sleep(PROMPT_SUBMIT_CONFIRM_DELAY_MS);
    await watchdog.check();
    const pane = await captureTmuxPane(sessionName, watchdog.commandTimeoutMs());
    if (pane === null || !paneTailContainsSnippet({ pane, snippet }))
        return;
    await execCommand({
        command: 'tmux',
        args: ['send-keys', '-t', sessionName, 'Enter'],
        timeoutMs: watchdog.commandTimeoutMs(),
    });
};
const promptVisibleSnippet = (prompt) => {
    const candidate = prompt
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .reverse()
        .find((line) => normalizedPromptText(line).length >= 8);
    if (candidate === undefined)
        return null;
    const normalized = normalizedPromptText(candidate);
    return normalized.length > 40 ? normalized.slice(-40) : normalized;
};
const paneTailContainsSnippet = ({ pane, snippet }) => {
    const lastLine = pane
        .split('\n')
        .map(normalizedPromptText)
        .filter(Boolean)
        .at(-1);
    return lastLine?.includes(snippet) ?? false;
};
const normalizedPromptText = (value) => value.replace(/\s+/g, ' ').trim();
const appendTmuxPaneToError = async ({ error, sessionName }) => {
    const capturedPane = await captureTmuxPane(sessionName);
    const message = error instanceof Error ? error.message : String(error);
    return new Error(capturedPane === null ? message : `${message}\n\nLast tmux pane:\n${capturedPane}`);
};
// Error classification and CLI entrypoint
export const classifyLaunchFailure = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    const knownFailure = [
        [/requires `?tmux`? on PATH|spawn tmux ENOENT/, 'Claude TUI adviser requires `tmux` on PATH.'],
        [/requires Claude Code CLI(?: `?claude`?)? on PATH|spawn claude ENOENT/, 'Claude TUI adviser requires `claude` on PATH.'],
        [/Please run \/login|Invalid authentication credentials/, 'Claude TUI adviser requires Claude authentication. Run `claude /login`.'],
        [/timed out waiting for (?:SessionStart|Stop)|timed out after|was idle|hard timeout|tmux session disappeared|Claude process exited/, 'Claude TUI adviser timed out before producing a handoff.'],
        [/could not find a final assistant answer/, 'Claude TUI adviser could not find a final assistant answer in the Claude transcript.'],
    ].find(([pattern]) => pattern.test(message));
    return knownFailure?.[1] || `Claude TUI adviser failed: ${message}`;
};
const main = async () => {
    const { answer, answerFile, hardTimeoutMs, idleTimeoutMs, mode, prompt, promptFile, resumeFile, timeoutMs } = parseArgs(process.argv.slice(2));
    const handoff = resumeFile === undefined
        ? await runAdviser({
            hardTimeoutMs,
            idleTimeoutMs,
            mode,
            input: await readInput({ prompt, promptFile }),
            timeoutMs,
        })
        : await runAdviserResume({
            answer: await readAnswer({ answer, answerFile }),
            hardTimeoutMs,
            idleTimeoutMs,
            mode,
            resumeFile,
            timeoutMs,
        });
    process.stdout.write(`${JSON.stringify(handoff, null, 2)}\n`);
};
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error) => {
        console.error(classifyLaunchFailure(error));
        process.exitCode = 1;
    });
}
