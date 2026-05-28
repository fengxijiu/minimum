import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TuiController } from "./controller/TuiController.js";
import type { TuiEvent } from "./controller/events.js";
import { listWorkspaceFiles, resolveFileMention, type FileItem } from "./files.js";
import {
	listSessions,
	loadSession,
	saveSession,
	type PersistedCard,
} from "./session.js";

type Mode = "normal" | "command" | "file";
type CardKind = "user" | "assistant" | "tool" | "system" | "error" | "reasoning";
type CardStatus = "streaming" | "done" | "error" | "cancelled";

interface Card {
	id: string;
	kind: CardKind;
	text: string;
	timestamp: number;
	status?: CardStatus;
	meta?: Record<string, unknown>;
}

interface CommandSpec {
	name: string;
	description: string;
	category: string;
	usage?: string;
}

interface ActiveLoop {
	prompt: string;
	intervalMs: number;
	nextFireAt: number;
	iter: number;
}

const COMMANDS: CommandSpec[] = [
	{ name: "/help", description: "Show commands", category: "System" },
	{ name: "/new", description: "Start a fresh session", category: "Session" },
	{ name: "/save", description: "Save transcript", category: "Session", usage: "/save [name]" },
	{ name: "/load", description: "Load transcript", category: "Session", usage: "/load [name]" },
	{ name: "/sessions", description: "List saved sessions", category: "Session" },
	{ name: "/status", description: "Show runtime status", category: "System" },
	{ name: "/clear", description: "Clear visible transcript", category: "System" },
	{ name: "/queue", description: "Inspect or clear queue", category: "Flow", usage: "/queue [clear]" },
	{ name: "/steer", description: "Inject guidance into current turn", category: "Flow" },
	{ name: "/cancel", description: "Cancel current turn", category: "Flow" },
	{ name: "/loop", description: "Run a prompt repeatedly", category: "Flow", usage: "/loop 30s task" },
	{ name: "/init", description: "Interactive setup wizard", category: "System" },
	{ name: "/exit", description: "Exit", category: "System" },
];

const WELCOME_CARD: Card = {
	id: "welcome",
	kind: "system",
	text: "Welcome to Minimum. Type a task, / for commands, or @ for files.",
	timestamp: Date.now(),
	status: "done",
};

export const App: React.FC = () => {
	const { exit } = useApp();
	const controllerRef = useRef<TuiController | null>(null);
	if (!controllerRef.current) {
		controllerRef.current = new TuiController({ workingDirectory: process.cwd() });
	}

	const [cards, setCards] = useState<Card[]>([WELCOME_CARD]);
	const [busy, setBusy] = useState(false);
	const [mode, setMode] = useState<Mode>("normal");
	const [inputValue, setInputValue] = useState("");
	const [sessionName, setSessionName] = useState("default");
	const [commandFilter, setCommandFilter] = useState("");
	const [fileFilter, setFileFilter] = useState("");
	const [activeLoop, setActiveLoop] = useState<ActiveLoop | null>(null);

	const cardsRef = useRef(cards);
	const busyRef = useRef(busy);
	const queueRef = useRef<string[]>([]);
	const submitRef = useRef<((raw: string) => Promise<void>) | null>(null);
	const activeLoopRef = useRef<ActiveLoop | null>(null);
	const loopFiringRef = useRef(false);

	useEffect(() => {
		cardsRef.current = cards;
	}, [cards]);

	useEffect(() => {
		busyRef.current = busy;
	}, [busy]);

	useEffect(() => {
		activeLoopRef.current = activeLoop;
	}, [activeLoop]);

	const appendCard = useCallback((card: Omit<Card, "id" | "timestamp">) => {
		setCards((prev) => [
			...prev,
			{
				...card,
				id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
				timestamp: Date.now(),
			},
		]);
	}, []);

	const appendSystem = useCallback(
		(text: string) => appendCard({ kind: "system", text, status: "done" }),
		[appendCard],
	);

	const applyEvent = useCallback((event: TuiEvent) => {
		switch (event.type) {
			case "turn.started":
				setCards((prev) => [
					...prev,
					{
						id: `user-${event.turnId}`,
						kind: "user",
						text: event.input,
						timestamp: Date.now(),
						status: "done",
					},
				]);
				break;
			case "assistant.delta":
				setCards((prev) => upsertStreamingCard(prev, event.turnId, event.content));
				break;
			case "assistant.reasoning":
				setCards((prev) => [
					...prev,
					{
						id: `reasoning-${event.turnId}-${prev.length}`,
						kind: "reasoning",
						text: event.content,
						timestamp: Date.now(),
						status: "done",
					},
				]);
				break;
			case "tool.started":
				setCards((prev) => [
					...prev,
					{
						id: `tool-${event.turnId}-${prev.length}`,
						kind: "tool",
						text: `Calling ${event.name}${event.repaired ? " (repaired args)" : ""}`,
						timestamp: Date.now(),
						status: "streaming",
						meta: { name: event.name, args: event.args },
					},
				]);
				break;
			case "tool.completed":
				setCards((prev) => [
					...markLastToolDone(prev, event.name, event.success),
					{
						id: `tool-result-${event.turnId}-${prev.length}`,
						kind: "tool",
						text: `${event.name}: ${truncate(event.result, 500)}`,
						timestamp: Date.now(),
						status: event.success ? "done" : "error",
					},
				]);
				break;
			case "validation.warning":
			case "context.optimized":
				setCards((prev) => [
					...prev,
					{
						id: `${event.type}-${event.turnId}-${prev.length}`,
						kind: "system",
						text: event.message,
						timestamp: Date.now(),
						status: "done",
					},
				]);
				break;
			case "usage":
				setCards((prev) => [
					...prev,
					{
						id: `usage-${event.turnId}`,
						kind: "system",
						text: formatUsage(event.usage),
						timestamp: Date.now(),
						status: "done",
					},
				]);
				break;
			case "turn.completed":
				setCards((prev) => sealAssistant(prev, event.turnId, event.success ? "done" : "error"));
				break;
			case "turn.cancelled":
				setCards((prev) => sealAssistant(prev, event.turnId, "cancelled"));
				break;
			case "turn.error":
				setCards((prev) => [
					...sealAssistant(prev, event.turnId, "error"),
					{
						id: `error-${event.turnId}`,
						kind: "error",
						text: event.error,
						timestamp: Date.now(),
						status: "error",
					},
				]);
				break;
			case "steer.accepted":
				setCards((prev) => [
					...prev,
					{
						id: `steer-${event.turnId}-${prev.length}`,
						kind: "system",
						text: `Steered current turn: ${event.content}`,
						timestamp: Date.now(),
						status: "done",
					},
				]);
				break;
		}
	}, []);

	const runSubmit = useCallback(
		async (text: string) => {
			setBusy(true);
			busyRef.current = true;
			try {
				for await (const event of controllerRef.current!.runTurn(text)) {
					applyEvent(event);
				}
			} finally {
				setBusy(false);
				busyRef.current = false;
				const next = queueRef.current.shift();
				if (next) {
					appendSystem(`Running queued task (${queueRef.current.length} left).`);
					void runSubmit(next);
				}
			}
		},
		[appendSystem, applyEvent],
	);

	const stopLoop = useCallback(() => {
		const current = activeLoopRef.current;
		setActiveLoop(null);
		if (current) appendSystem(`Loop stopped after ${current.iter} iteration(s).`);
	}, [appendSystem]);

	const startLoop = useCallback((intervalMs: number, prompt: string) => {
		setActiveLoop({
			prompt,
			intervalMs,
			nextFireAt: Date.now() + intervalMs,
			iter: 0,
		});
		appendSystem(`Loop started: every ${formatDuration(intervalMs)} -> ${prompt}`);
	}, [appendSystem]);

	const handleCommand = useCallback(
		async (raw: string) => {
			const [command = "", ...args] = raw.trim().split(/\s+/);
			switch (command.toLowerCase()) {
				case "/help":
					appendSystem(formatHelp());
					return;
				case "/new":
					controllerRef.current!.reset();
					queueRef.current = [];
					setCards([{ ...WELCOME_CARD, id: `welcome-${Date.now()}`, timestamp: Date.now() }]);
					setSessionName("default");
					stopLoop();
					return;
				case "/save": {
					const name = args[0] || sessionName || "default";
					const file = await saveSession(name, toPersistedCards(cardsRef.current));
					setSessionName(name);
					appendSystem(`Saved session "${name}" to ${file}`);
					return;
				}
				case "/load": {
					const name = args[0] || sessionName || "default";
					const loaded = await loadSession(name);
					setCards(fromPersistedCards(loaded.cards));
					setSessionName(loaded.name);
					appendSystem(`Loaded session "${loaded.name}".`);
					return;
				}
				case "/sessions": {
					const names = await listSessions();
					appendSystem(names.length ? `Sessions:\n${names.join("\n")}` : "No saved sessions.");
					return;
				}
				case "/status":
					appendSystem(
						[
							`Busy: ${busyRef.current ? "yes" : "no"}`,
							`Cards: ${cardsRef.current.length}`,
							`Queue: ${queueRef.current.length}`,
							`Session: ${sessionName}`,
							`Loop: ${activeLoopRef.current ? formatLoop(activeLoopRef.current) : "off"}`,
							`Shell tool: ${process.env.MINIMUM_ENABLE_SHELL === "1" ? "enabled" : "disabled"}`,
						].join("\n"),
					);
					return;
				case "/clear":
					setCards([]);
					return;
				case "/queue":
					if (args[0] === "clear") {
						queueRef.current = [];
						appendSystem("Queue cleared.");
					} else {
						appendSystem(
							queueRef.current.length
								? `Queued tasks:\n${queueRef.current.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
								: "Queue is empty.",
						);
					}
					return;
				case "/steer": {
					const text = args.join(" ").trim();
					if (!text) {
						appendSystem("Usage: /steer <guidance>");
						return;
					}
					controllerRef.current!.steer(text);
					appendSystem(`Steer queued for current turn: ${text}`);
					return;
				}
				case "/cancel":
					controllerRef.current!.abort();
					appendSystem("Cancel requested for current turn.");
					return;
				case "/loop": {
					const parsed = parseLoopCommand(args);
					if (parsed.kind === "stop") {
						stopLoop();
					} else if (parsed.kind === "status") {
						appendSystem(activeLoopRef.current ? formatLoop(activeLoopRef.current) : "No active loop.");
					} else if (parsed.kind === "start") {
						startLoop(parsed.intervalMs, parsed.prompt);
					} else {
						appendSystem(parsed.message);
					}
					return;
				}
				case "/init": {
					// Temporarily release stdin from Ink's raw mode so readline works
					setBusy(true);
					appendSystem("Starting interactive setup...");
					try {
						const wasRaw = process.stdin.isRaw;
						process.stdin.setRawMode?.(false);
						process.stdin.pause();

						const output = await controllerRef.current!.runInitInteractive();

						process.stdin.setRawMode?.(wasRaw ?? true);
						process.stdin.resume();

						appendSystem(output);
					} catch (err: any) {
						process.stdin.setRawMode?.(true);
						process.stdin.resume();
						appendSystem(`Init failed: ${err.message}`);
					} finally {
						setBusy(false);
					}
					return;
				}
				case "/exit":
				case "/quit":
					exit();
					return;
				default:
					appendSystem(`Unknown command: ${command}. Type /help.`);
			}
		},
		[appendSystem, exit, sessionName, startLoop, stopLoop],
	);

	const submit = useCallback(
		async (raw: string) => {
			const trimmed = raw.trim();
			if (!trimmed) return;
			setMode("normal");
			setInputValue("");

			if (activeLoopRef.current && !loopFiringRef.current) {
				stopLoop();
			}

			if (trimmed.startsWith("/")) {
				await handleCommand(trimmed);
				return;
			}

			const expanded = expandFileMentions(trimmed, controllerRef.current!.cwd);
			if (busyRef.current) {
				queueRef.current.push(expanded);
				appendSystem(`Queued while busy (${queueRef.current.length} pending).`);
				return;
			}

			await runSubmit(expanded);
		},
		[appendSystem, handleCommand, runSubmit, stopLoop],
	);

	useEffect(() => {
		submitRef.current = submit;
	}, [submit]);

	useEffect(() => {
		if (!activeLoop) return;
		const delay = Math.max(0, activeLoop.nextFireAt - Date.now());
		const timer = setTimeout(async () => {
			if (busyRef.current) {
				setActiveLoop((current) =>
					current ? { ...current, nextFireAt: Date.now() + 1000 } : current,
				);
				return;
			}
			const current = activeLoopRef.current;
			if (!current) return;
			const nextIter = current.iter + 1;
			setActiveLoop((loop) =>
				loop
					? {
							...loop,
							iter: nextIter,
							nextFireAt: Date.now() + loop.intervalMs,
						}
					: loop,
			);
			appendSystem(`/loop iteration ${nextIter}: ${current.prompt}`);
			loopFiringRef.current = true;
			try {
				await submitRef.current?.(current.prompt);
			} finally {
				loopFiringRef.current = false;
			}
		}, delay);
		return () => clearTimeout(timer);
	}, [activeLoop, appendSystem]);

	const handleInputChange = useCallback((value: string) => {
		setInputValue(value);
		if (value === "/" || (value.startsWith("/") && !value.includes(" "))) {
			setMode("command");
			setCommandFilter(value.slice(1));
		} else if (value === "@" || (value.startsWith("@") && !value.includes(" "))) {
			setMode("file");
			setFileFilter(value.slice(1));
		} else {
			setMode("normal");
		}
	}, []);

	useInput((input, key) => {
		if (key.ctrl && input === "c") {
			if (busyRef.current) {
				controllerRef.current!.abort();
				appendSystem("Cancel requested. Press Ctrl+C again when idle to exit.");
				return;
			}
			exit();
			return;
		}
		if (key.ctrl && input === "l") {
			setCards([]);
			return;
		}
		if (key.escape) {
			if (mode !== "normal") {
				setMode("normal");
				setInputValue("");
				return;
			}
			if (busyRef.current) {
				controllerRef.current!.abort();
				appendSystem("Cancel requested.");
			}
			return;
		}
		if (key.upArrow && !inputValue) {
			const lastUser = [...cardsRef.current].reverse().find((card) => card.kind === "user");
			if (lastUser) setInputValue(lastUser.text);
			return;
		}
		if (key.tab && mode === "command") {
			const match = filteredCommands(commandFilter)[0];
			if (match) {
				setInputValue(`${match.name} `);
				setMode("normal");
			}
			return;
		}
		if (key.tab && mode === "file") {
			const match = filteredFiles(fileFilter, controllerRef.current!.cwd)[0];
			if (match) {
				setInputValue(`@${match.path} `);
				setMode("normal");
			}
		}
	});

	const visibleCards = cards.slice(-80);

	return (
		<Box flexDirection="column" height="100%">
			<StatusBar
				busy={busy}
				mode={mode}
				cardCount={cards.length}
				queueCount={queueRef.current.length}
				sessionName={sessionName}
				activeLoop={activeLoop}
			/>

			{mode === "command" ? <CommandMenu filter={commandFilter} /> : null}
			{mode === "file" ? (
				<FileMenu filter={fileFilter} workingDirectory={controllerRef.current.cwd} />
			) : null}

			<Box flexDirection="column" flexGrow={1} paddingX={1} overflowY="hidden">
				{visibleCards.map((card) => (
					<CardView key={card.id} card={card} />
				))}
			</Box>

			<Box borderStyle="single" borderColor={busy ? "yellow" : "gray"} paddingX={1}>
				<Text color="green" bold>
					{"> "}
				</Text>
				<Box marginLeft={1} flexGrow={1}>
					<TextInput
						value={inputValue}
						onChange={handleInputChange}
						onSubmit={(value) => {
							void submit(value);
						}}
						placeholder={placeholderFor(mode, busy)}
					/>
				</Box>
			</Box>

			<Box paddingX={1} justifyContent="space-between">
				<Text color="gray" dimColor>
					/: commands | @: files | Tab: complete | Esc: cancel | Ctrl+L: clear
				</Text>
				<Text color="gray" dimColor>
					{process.env.MIMO_API_KEY ? "MiMo API" : "mock mode"}
				</Text>
			</Box>
		</Box>
	);
};

function StatusBar({
	busy,
	mode,
	cardCount,
	queueCount,
	sessionName,
	activeLoop,
}: {
	busy: boolean;
	mode: Mode;
	cardCount: number;
	queueCount: number;
	sessionName: string;
	activeLoop: ActiveLoop | null;
}) {
	return (
		<Box borderStyle="single" borderColor="cyan" paddingX={1} justifyContent="space-between">
			<Box gap={1}>
				<Text bold color="cyan">
					Minimum
				</Text>
				<Text color="gray">MiMo TUI</Text>
				{busy ? <Text color="yellow">working</Text> : <Text color="green">idle</Text>}
				{mode !== "normal" ? <Text color="magenta">{mode}</Text> : null}
			</Box>
			<Box gap={2}>
				{activeLoop ? <Text color="cyan">{formatLoop(activeLoop)}</Text> : null}
				{queueCount > 0 ? <Text color="yellow">queue {queueCount}</Text> : null}
				<Text color="gray">cards {cardCount}</Text>
				<Text color="blue">{sessionName}</Text>
			</Box>
		</Box>
	);
}

function CommandMenu({ filter }: { filter: string }) {
	const filtered = filteredCommands(filter);
	const grouped = groupByCategory(filtered);
	return (
		<Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
			<Text bold color="cyan">
				Commands
			</Text>
			{Object.entries(grouped).map(([category, commands]) => (
				<Box key={category} flexDirection="column" marginTop={1}>
					<Text color="yellow">{category}</Text>
					{commands.map((command) => (
						<Box key={command.name} marginLeft={2}>
							<Text color="white">{command.name.padEnd(12)}</Text>
							<Text color="gray">{command.description}</Text>
						</Box>
					))}
				</Box>
			))}
			<Text color="gray" dimColor>
				Tab completes the first match. Enter runs the typed command.
			</Text>
		</Box>
	);
}

function FileMenu({
	filter,
	workingDirectory,
}: {
	filter: string;
	workingDirectory: string;
}) {
	const files = useMemo(
		() => filteredFiles(filter, workingDirectory),
		[filter, workingDirectory],
	);
	return (
		<Box flexDirection="column" borderStyle="round" borderColor="magenta" padding={1}>
			<Text bold color="magenta">
				Files
			</Text>
			{files.slice(0, 14).map((file) => (
				<Box key={file.path} marginLeft={2}>
					<Text color={file.type === "dir" ? "cyan" : "white"}>
						{file.type === "dir" ? "[d] " : "[f] "}
						{file.path}
					</Text>
				</Box>
			))}
			{files.length === 0 ? <Text color="gray">No matches</Text> : null}
			{files.length > 14 ? <Text color="gray">Showing 14/{files.length}</Text> : null}
			<Text color="gray" dimColor>
				Tab inserts the first match.
			</Text>
		</Box>
	);
}

function CardView({ card }: { card: Card }) {
	const style = cardStyle(card);
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<Text bold color={style.color}>
					{style.label}
					{card.status === "streaming" ? " ..." : ""}:{" "}
				</Text>
				<Text color={card.kind === "reasoning" ? "gray" : undefined}>
					{card.text || "(empty)"}
				</Text>
			</Box>
			{card.meta?.args ? (
				<Box marginLeft={2}>
					<Text color="gray">{truncate(JSON.stringify(card.meta.args), 240)}</Text>
				</Box>
			) : null}
		</Box>
	);
}

function upsertStreamingCard(cards: Card[], turnId: number, chunk: string): Card[] {
	const id = `assistant-${turnId}`;
	const existing = cards.findIndex((card) => card.id === id);
	if (existing === -1) {
		return [
			...cards,
			{
				id,
				kind: "assistant",
				text: chunk,
				timestamp: Date.now(),
				status: "streaming",
			},
		];
	}
	return cards.map((card, index) =>
		index === existing ? { ...card, text: card.text + chunk, status: "streaming" } : card,
	);
}

function sealAssistant(cards: Card[], turnId: number, status: CardStatus): Card[] {
	const id = `assistant-${turnId}`;
	return cards.map((card) => (card.id === id ? { ...card, status } : card));
}

function markLastToolDone(cards: Card[], name: string, success: boolean): Card[] {
	const index = [...cards]
		.reverse()
		.findIndex((card) => card.kind === "tool" && card.meta?.name === name);
	if (index === -1) return cards;
	const realIndex = cards.length - 1 - index;
	return cards.map((card, current) =>
		current === realIndex ? { ...card, status: success ? "done" : "error" } : card,
	);
}

function filteredCommands(filter: string): CommandSpec[] {
	const normalized = filter.toLowerCase();
	return COMMANDS.filter(
		(command) =>
			!normalized ||
			command.name.toLowerCase().includes(normalized) ||
			command.description.toLowerCase().includes(normalized),
	);
}

function filteredFiles(filter: string, cwd: string): FileItem[] {
	const files = listWorkspaceFiles(cwd);
	if (!filter) return files;
	return files.filter((file) => file.path.includes(filter) || file.name.includes(filter));
}

function groupByCategory(commands: CommandSpec[]): Record<string, CommandSpec[]> {
	const grouped: Record<string, CommandSpec[]> = {};
	for (const command of commands) {
		grouped[command.category] ??= [];
		grouped[command.category]!.push(command);
	}
	return grouped;
}

function expandFileMentions(input: string, cwd: string): string {
	return input.replace(/@(\S+)/g, (_match, token: string) => resolveFileMention(cwd, token));
}

function toPersistedCards(cards: Card[]): PersistedCard[] {
	return cards.map((card) => ({
		id: card.id,
		kind: card.kind,
		text: card.text,
		status: card.status,
		timestamp: card.timestamp,
	}));
}

function fromPersistedCards(cards: PersistedCard[]): Card[] {
	return cards.map((card) => ({
		id: card.id,
		kind: isCardKind(card.kind) ? card.kind : "system",
		text: card.text,
		status: isCardStatus(card.status) ? card.status : "done",
		timestamp: card.timestamp,
	}));
}

function isCardKind(kind: string): kind is CardKind {
	return ["user", "assistant", "tool", "system", "error", "reasoning"].includes(kind);
}

function isCardStatus(status: string | undefined): status is CardStatus {
	return status === "streaming" || status === "done" || status === "error" || status === "cancelled";
}

type LoopCommand =
	| { kind: "start"; intervalMs: number; prompt: string }
	| { kind: "stop" }
	| { kind: "status" }
	| { kind: "error"; message: string };

function parseLoopCommand(args: string[]): LoopCommand {
	if (args.length === 0) return { kind: "status" };
	const first = args[0]?.toLowerCase();
	if (first === "stop" || first === "off" || first === "cancel") return { kind: "stop" };
	const interval = parseInterval(args[0] ?? "");
	if (interval === null) {
		return {
			kind: "error",
			message: "Usage: /loop <5s..6h> <prompt>, /loop stop, or /loop",
		};
	}
	const prompt = args.slice(1).join(" ").trim();
	if (!prompt) return { kind: "error", message: "Usage: /loop <interval> <prompt>" };
	return { kind: "start", intervalMs: interval, prompt };
}

function parseInterval(raw: string): number | null {
	const match = /^([0-9]+(?:\.[0-9]+)?)(s|sec|secs|m|min|mins|h|hr|hrs)?$/i.exec(raw.trim());
	if (!match) return null;
	const value = Number.parseFloat(match[1] ?? "");
	if (!Number.isFinite(value) || value <= 0) return null;
	const unit = match[2]?.toLowerCase() ?? "s";
	const ms =
		unit.startsWith("h") ? value * 3_600_000 : unit.startsWith("m") ? value * 60_000 : value * 1000;
	if (ms < 5_000 || ms > 21_600_000) return null;
	return Math.round(ms);
}

function formatLoop(loop: ActiveLoop): string {
	const nextMs = Math.max(0, loop.nextFireAt - Date.now());
	return `loop ${formatDuration(loop.intervalMs)} next ${formatDuration(nextMs)} iter ${loop.iter}`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const total = Math.round(ms / 1000);
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes < 60) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return remainder ? `${hours}h${remainder}m` : `${hours}h`;
}

function formatUsage(usage: Record<string, unknown>): string {
	const tokens = usage.totalTokens ?? usage.total_tokens;
	const cost = usage.totalCostUsd;
	const parts = ["Turn usage"];
	if (tokens !== undefined) parts.push(`tokens=${tokens}`);
	if (cost !== undefined) parts.push(`cost=$${cost}`);
	return parts.join(" ");
}

function formatHelp(): string {
	return COMMANDS.map((command) => {
		const usage = command.usage ? ` (${command.usage})` : "";
		return `${command.name.padEnd(10)} ${command.description}${usage}`;
	}).join("\n");
}

function cardStyle(card: Card): { color: string; label: string } {
	switch (card.kind) {
		case "user":
			return { color: "green", label: "You" };
		case "assistant":
			return { color: "blue", label: "MiMo" };
		case "tool":
			return { color: card.status === "error" ? "red" : "yellow", label: "Tool" };
		case "error":
			return { color: "red", label: "Error" };
		case "reasoning":
			return { color: "gray", label: "Thinking" };
		case "system":
			return { color: "gray", label: "System" };
	}
}

function placeholderFor(mode: Mode, busy: boolean): string {
	if (busy) return "Turn running. Type a follow-up to queue it, /steer to guide, or Esc to cancel.";
	if (mode === "command") return "Type command...";
	if (mode === "file") return "Type filename...";
	return "Type task, / for commands, @ for files...";
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export default App;
