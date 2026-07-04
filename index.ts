import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "crypto";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import { IntercomClient } from "./broker/client.ts";
import { spawnBrokerIfNeeded } from "./broker/spawn.ts";
import { SessionListOverlay } from "./ui/session-list.ts";
import { ComposeOverlay, type ComposeResult } from "./ui/compose.ts";
import { InlineMessageComponent } from "./ui/inline-message.ts";
import { loadConfig, type IntercomConfig } from "./config.ts";
import type { SessionInfo, Message, Attachment } from "./types.ts";
import { ReplyTracker } from "./reply-tracker.ts";

const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";
const INBOUND_FLUSH_DELAY_MS = 200;
const INBOUND_IDLE_RETRY_MS = 500;
const DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX = "subagent-chat";
/** Connect/disconnect signalling prefixes – intercepted in handleIncomingMessage and silently consumed. */
const CONNECT_PREFIX = "🔗/connect:";
const DISCONNECT_PREFIX = "🔗/disconnect:";
interface InboundMessageEntry {
  from: SessionInfo;
  message: Message;
  replyCommand?: string;
  bodyText: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatAttachments(attachments: Attachment[]): string {
  let text = "";
  for (const att of attachments) {
    if (att.language) {
      text += `\n\n---\n📎 ${att.name}\n~~~${att.language}\n${att.content}\n~~~`;
    } else {
      text += `\n\n---\n📎 ${att.name}\n${att.content}`;
    }
  }
  return text;
}
function duplicateSessionNames(sessions: SessionInfo[]): Set<string> {
  return new Set(
    sessions
      .map(s => s.name?.toLowerCase())
      .filter((name): name is string => Boolean(name))
      .filter((name, index, names) => names.indexOf(name) !== index)
  );
}
function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}
function parseSubagentIntercomPayload(payload: unknown): { to: string; message: string; requestId?: string } | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.to !== "string" || typeof record.message !== "string") {
    return null;
  }
  const requestId = typeof record.requestId === "string" ? record.requestId : undefined;
  return { to: record.to, message: record.message, ...(requestId ? { requestId } : {}) };
}
function resolveIntercomPresenceName(sessionName: string | undefined, sessionId: string): string {
  const trimmedName = sessionName?.trim();
  if (trimmedName) {
    return trimmedName;
  }
  const normalizedSessionId = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
  return `${DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX}-${normalizedSessionId.slice(0, 8)}`;
}
function buildPresenceIdentity(pi: ExtensionAPI, sessionId: string): { name: string } {
  return {
    name: resolveIntercomPresenceName(pi.getSessionName(), sessionId),
  };
}
function formatSessionLabel(session: SessionInfo, duplicates: Set<string>): string {
  if (!session.name) {
    return session.id;
  }
  return duplicates.has(session.name.toLowerCase())
    ? `${session.name} (${shortSessionId(session.id)})`
    : session.name;
}
function formatSessionListRow(session: SessionInfo, currentCwd: string, isSelf: boolean): string {
  const name = session.name || "Unnamed session";
  const tags = [isSelf ? "self" : session.cwd === currentCwd ? "same cwd" : undefined, session.status]
    .filter((tag): tag is string => Boolean(tag));
  const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
  return `• ${name} (${shortSessionId(session.id)}) — ${session.cwd} (${session.model})${suffix}`;
}
function previewText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
function firstTextContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text?.replace(/\*\*/g, "") ?? "";
}
export default function piIntercomExtension(pi: ExtensionAPI) {
  let client: IntercomClient | null = null;
  const config: IntercomConfig = loadConfig();
  let runtimeContext: ExtensionContext | null = null;
  let currentSessionId: string | null = null;
  let currentModel = "unknown";
  let sessionStartedAt: number | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectPromise: Promise<IntercomClient> | null = null;
  let reconnectPromiseGeneration: number | null = null;
  let startupConnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  let shuttingDown = false;
  let disposed = true;
  let runtimeStarted = false;
  let runtimeGeneration = 0;
  let agentRunning = false;
  const activeTools = new Map<string, string>();
  const replyTracker = new ReplyTracker();
  const pendingIdleMessages: InboundMessageEntry[] = [];
  /** deliverAsUser messages waiting for agent_end to send results back */
  const pendingUserMessageResults: Array<{
    from: SessionInfo;
    messageId: string;
    expectsReply: boolean;
  }> = [];

  /** Duplex connect: the peer session we are in an always-on natural conversation with. */
  let connectedPeer: { id: string; name: string } | null = null;
  /** Pending duplex forward waiting for rendered-prose content (two-pass renderer). */
  let pendingDuplexForward: { peerId: string } | null = null;

  /** Global hook for two-pass renderers to deliver fsn-prose content (e.g., fate-sandbox). */
  function onProseReady(text: string): void {
    // Handle pendingUserMessageResults (existing send_message reply tracking)
    if (pendingUserMessageResults.length > 0) {
      const pending = pendingUserMessageResults.shift()!;
      const activeClient = client;
      if (activeClient?.isConnected()) {
        activeClient.send(pending.from.id, {
          text,
          replyTo: pending.expectsReply ? pending.messageId : undefined,
        }).catch(() => {
          // Best-effort result delivery
        });
      }
    }
    // Handle pending duplex forward (rendered-prose output for connected peer)
    if (pendingDuplexForward) {
      const { peerId } = pendingDuplexForward;
      pendingDuplexForward = null;
      const activeClient = client;
      if (activeClient?.isConnected()) {
        activeClient.send(peerId, {
          text,
          deliverAsUser: true,
          expectsReply: false,
        }).catch(() => {
          // Best-effort
        });
      }
    }
  }

  (globalThis as any).__intercomProseReady = onProseReady;
  let inboundFlushTimer: NodeJS.Timeout | null = null;
  let replyWaiter: {
    from: string;
    replyTo: string;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
  } | null = null;
  function waitForReply(from: string, replyTo: string, signal?: AbortSignal): Promise<Message> {
    if (replyWaiter) {
      return Promise.reject(new Error("Already waiting for a reply"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("Cancelled"));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        rejectReplyWaiter(new Error(`No reply from "${from}" within 10 minutes`));
      }, 10 * 60 * 1000);
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (replyWaiter?.replyTo === replyTo) {
          replyWaiter = null;
        }
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      replyWaiter = {
        from,
        replyTo,
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
    });
  }
  function rejectReplyWaiter(error: Error): void {
    replyWaiter?.reject(error);
  }
  function clearReconnectTimer(): void {
    if (!reconnectTimer) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  function clearStartupConnectTimer(): void {
    if (!startupConnectTimer) {
      return;
    }
    clearTimeout(startupConnectTimer);
    startupConnectTimer = null;
  }
  function clearInboundFlushTimer(): void {
    if (!inboundFlushTimer) {
      return;
    }
    clearTimeout(inboundFlushTimer);
    inboundFlushTimer = null;
  }
  function getLiveContext(ctx: ExtensionContext | null = runtimeContext, generation = runtimeGeneration): ExtensionContext | null {
    if (disposed || shuttingDown || generation !== runtimeGeneration || !ctx) {
      return null;
    }
    try {
      if (currentSessionId && ctx.sessionManager.getSessionId() !== currentSessionId) {
        return null;
      }
      void ctx.hasUI;
      return ctx;
    } catch {
      // A context that throws while reading session/UI state is no longer usable.
      return null;
    }
  }
  function notifyIfLive(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error", generation = runtimeGeneration): void {
    const liveContext = getLiveContext(ctx, generation);
    if (!liveContext?.hasUI) {
      return;
    }
    try {
      liveContext.ui.notify(message, level);
    } catch {
      // The UI can disappear during session shutdown/reload while async overlay work is settling.
    }
  }
  function getReconnectDelayMs(): number {
    const backoffMs = [1000, 2000, 5000, 10000, 30000];
    return backoffMs[Math.min(reconnectAttempt, backoffMs.length - 1)]!;
  }
  function currentStatus(): string {
    const activeToolName = activeTools.values().next().value;
    const lifecycleStatus = activeToolName ? `tool:${activeToolName}` : agentRunning ? "thinking" : "idle";
    return config.status ? `${lifecycleStatus} · ${config.status}` : lifecycleStatus;
  }
  function buildRegistration(): Omit<SessionInfo, "id"> {
    const liveContext = getLiveContext();
    if (!liveContext || !currentSessionId || sessionStartedAt === null) {
      throw new Error("Intercom runtime not initialized");
    }

    const identity = buildPresenceIdentity(pi, currentSessionId);
    return {
      name: identity.name,
      cwd: liveContext.cwd ?? process.cwd(),
      model: currentModel,
      pid: process.pid,
      startedAt: sessionStartedAt,
      lastActivity: Date.now(),
      status: currentStatus(),
    };
  }
  function syncPresenceIdentity(sessionId: string): void {
    if (!client || !getLiveContext()) {
      return;
    }
    client.updatePresence({ ...buildPresenceIdentity(pi, sessionId), status: currentStatus() });
  }
  function syncPresenceStatus(): void {
    if (!client || !currentSessionId || !getLiveContext()) {
      return;
    }
    client.updatePresence({ status: currentStatus() });
  }
  function currentSessionTargetMatches(to: string, resolvedTo?: string | null, activeClient?: IntercomClient): boolean {
    const targets = new Set<string>();
    const addTarget = (target: string | undefined | null) => {
      const trimmed = target?.trim();
      if (trimmed) targets.add(trimmed.toLowerCase());
    };
    addTarget(currentSessionId);
    addTarget(activeClient?.sessionId);
    addTarget(pi.getSessionName());
    if (currentSessionId) addTarget(buildPresenceIdentity(pi, currentSessionId).name);
    return Boolean(resolvedTo && activeClient?.sessionId && resolvedTo === activeClient.sessionId)
      || targets.has(to.trim().toLowerCase());
  }
  function sendIncomingMessage(entry: InboundMessageEntry, delivery: "trigger" | "followUp", generation = runtimeGeneration): void {
    if (runtimeStarted && !getLiveContext(runtimeContext, generation)) {
      return;
    }
    if (delivery !== "followUp") {
      replyTracker.queueTurnContext({ from: entry.from, message: entry.message, receivedAt: Date.now() });
    }
    const senderDisplay = entry.from.name || entry.from.id.slice(0, 8);
    const replyInstruction = entry.replyCommand ? `\n\nTo reply, use the intercom tool: ${entry.replyCommand}` : "";
    pi.sendMessage(
      {
        customType: "intercom_message",
        content: `**📨 From ${senderDisplay}** (${entry.from.cwd})${replyInstruction}\n\n${entry.bodyText}`,
        display: true,
        details: entry,
      },
      delivery === "trigger"
        ? { triggerTurn: true }
        : { deliverAs: "followUp" }
    );
  }
  function scheduleInboundFlush(delayMs = INBOUND_FLUSH_DELAY_MS): void {
    if (!getLiveContext()) {
      return;
    }
    const scheduledGeneration = runtimeGeneration;
    clearInboundFlushTimer();
    inboundFlushTimer = setTimeout(() => {
      inboundFlushTimer = null;
      flushIdleMessages(scheduledGeneration);
    }, delayMs);
  }
  function flushIdleMessages(generation = runtimeGeneration): void {
    if (pendingIdleMessages.length === 0) {
      return;
    }
    const ctx = getLiveContext(runtimeContext, generation);
    if (!ctx) {
      return;
    }

    let isIdle: boolean;
    try {
      isIdle = ctx.isIdle();
    } catch {
      // Stale contexts are cleaned up by shutdown/reload; do not deliver queued messages through them.
      return;
    }
    if (!isIdle) {
      scheduleInboundFlush(INBOUND_IDLE_RETRY_MS);
      return;
    }

    const entries = pendingIdleMessages.splice(0, pendingIdleMessages.length);
    entries.forEach((entry, index) => {
      sendIncomingMessage(entry, index === 0 ? "trigger" : "followUp");
    });
  }
  function queueIdleMessage(entry: InboundMessageEntry): void {
    pendingIdleMessages.push(entry);
    scheduleInboundFlush();
  }
  /**
   * Intercept a duplex protocol message (connect/disconnect) and update local state.
   * Returns true if the message was consumed, false otherwise.
   */
  function handleDuplexProtocolMessage(from: SessionInfo, message: Message): boolean {
    const text = message.content.text;
    if (text.startsWith(CONNECT_PREFIX)) {
      const peerName = text.slice(CONNECT_PREFIX.length).trim();
      if (connectedPeer) {
        notifyIfLive(runtimeContext!, `Already connected to "${connectedPeer.name}". /disconnect first.`, "error");
        return true;
      }
      connectedPeer = { id: from.id, name: from.name || peerName };
      notifyIfLive(runtimeContext!, `🔗 Duplex connected with "${connectedPeer.name}". Their messages will now arrive as your user, and your replies will be forwarded automatically.`, "info");
      return true;
    }
    if (text.startsWith(DISCONNECT_PREFIX)) {
      const peerName = text.slice(DISCONNECT_PREFIX.length).trim();
      if (connectedPeer && (connectedPeer.id === from.id || connectedPeer.name === peerName)) {
        connectedPeer = null;
        notifyIfLive(runtimeContext!, `🔗 Duplex disconnected from "${peerName}".`, "info");
      }
      return true;
    }
    return false;
  }

  function clearConnectedPeer(): void {
    if (connectedPeer) {
      const peerName = connectedPeer.name;
      connectedPeer = null;
      notifyIfLive(runtimeContext!, `🔗 Duplex peer "${peerName}" disconnected. Connection cleared.`, "warning");
    }
  }

  function handleIncomingMessage(ctx: ExtensionContext, from: SessionInfo, message: Message, skipDuplexProtocol = false): void {
    const messageGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, messageGeneration);
    if (!liveContext) {
      return;
    }
    // Intercept duplex protocol messages (connect/disconnect) before showing any notification
    if (!skipDuplexProtocol && !message.deliverAsUser && handleDuplexProtocolMessage(from, message)) {
      return;
    }
    if (replyWaiter) {
      const senderTarget = from.name || from.id;
      const fromMatches = senderTarget.toLowerCase() === replyWaiter.from.toLowerCase()
        || from.id === replyWaiter.from;
      const replyMatches = message.replyTo === replyWaiter.replyTo;
      if (fromMatches && replyMatches) {
        replyWaiter.resolve(message);
        return;
      }
    }
    // deliverAsUser → inject as real user message, completely silent (no notification, no TUI display)
    if (message.deliverAsUser) {
      // Duplex-forwarded messages from connected peer: inject silently, no reply tracking.
      // (The duplex agent_end handler already handles forwarding the response back.)
      if (connectedPeer && connectedPeer.id === from.id) {
        pi.sendUserMessage(message.content.text);
        return;
      }
      pendingUserMessageResults.push({
        from,
        messageId: message.id,
        expectsReply: Boolean(message.expectsReply),
      });
      pi.sendUserMessage(message.content.text);
      return;
    }

    const attachmentText = message.content.attachments?.length
      ? formatAttachments(message.content.attachments)
      : "";
    const bodyText = `${message.content.text}${attachmentText}`;
    const replyCommand = config.replyHint && message.expectsReply
      ? `intercom({ action: "reply", message: "..." })`
      : undefined;
    replyTracker.recordIncomingMessage(from, message);
    const entry = { from, message, replyCommand, bodyText };
    void (async () => {
      const activeContext = getLiveContext(liveContext, messageGeneration);
      if (!activeContext) {
        return;
      }
      if (!activeContext.isIdle()) {
        if (!activeContext.hasUI) {
          const activeClient = client;
          if (!message.replyTo && activeClient?.isConnected()) {
            try {
              const result = await activeClient.send(from.id, {
                text: "This agent is running in non-interactive mode and cannot respond to intercom messages while it is working. It will continue its current task and exit when done.",
                replyTo: message.id,
              });
              if (result.delivered && getLiveContext(liveContext, messageGeneration)) {
                replyTracker.markReplied(message.id);
              }
            } catch {
              // Best-effort reply; keep the busy non-interactive session running either way.
            }
          }
          return;
        }
        queueIdleMessage(entry);
        return;
      }
      if (getLiveContext(liveContext, messageGeneration)) {
        sendIncomingMessage(entry, "trigger", messageGeneration);
      }
    })();
  }
  function attachClientHandlers(nextClient: IntercomClient): void {
    nextClient.on("message", (from, message) => {
      const liveContext = getLiveContext();
      if (client !== nextClient || !liveContext) {
        return;
      }
      handleIncomingMessage(liveContext, from, message);
    });
    nextClient.on("session_left", (sessionId: string) => {
      if (connectedPeer && connectedPeer.id === sessionId) {
        clearConnectedPeer();
      }
    });
    nextClient.on("disconnected", (error: Error) => {
      if (client !== nextClient) {
        return;
      }
      rejectReplyWaiter(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      client = null;
      if (!shuttingDown && !disposed) {
        clearReconnectTimer();
        scheduleReconnect();
      }
    });
    nextClient.on("error", () => {
      // Keep broker/socket noise out of the TUI. Reconnect logic runs from the disconnect path.
    });
  }
  function scheduleReconnect(): void {
    if (disposed || shuttingDown || reconnectTimer || reconnectPromise || !getLiveContext()) {
      return;
    }
    const scheduledGeneration = runtimeGeneration;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (scheduledGeneration !== runtimeGeneration || !getLiveContext()) {
        return;
      }
      reconnectAttempt += 1;
      void ensureConnected("background").catch(() => {
        // ensureConnected("background") already queued the next retry.
      });
    }, getReconnectDelayMs());
  }
  async function ensureConnected(reason: "startup" | "background" | "tool" | "overlay"): Promise<IntercomClient> {
    if (!config.enabled) {
      throw new Error("Intercom disabled");
    }
    if (disposed || shuttingDown) {
      throw new Error("Intercom shutting down");
    }
    if (client && client.isConnected()) {
      return client;
    }
    const contextAtStart = getLiveContext();
    const generationAtStart = runtimeGeneration;
    if (!contextAtStart || !currentSessionId || sessionStartedAt === null) {
      throw new Error("Intercom runtime not initialized");
    }
    clearReconnectTimer();
    if (reconnectPromise && reconnectPromiseGeneration === generationAtStart) {
      return reconnectPromise;
    }
    const nextReconnectPromise = (async () => {
      const nextClient = new IntercomClient();
      client = nextClient;
      attachClientHandlers(nextClient);
      try {
        await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
        await nextClient.connect(buildRegistration());
        if (!getLiveContext(contextAtStart, generationAtStart)) {
          await nextClient.disconnect();
          throw new Error("Intercom runtime no longer active");
        }
        client = nextClient;
        reconnectAttempt = 0;
        return nextClient;
      } catch (error) {
        if (client === nextClient) {
          client = null;
        }
        if (reason === "background" && getLiveContext(contextAtStart, generationAtStart)) {
          scheduleReconnect();
        }
        throw toError(error);
      } finally {
        if (reconnectPromise === nextReconnectPromise) {
          reconnectPromise = null;
          reconnectPromiseGeneration = null;
        }
      }
    })();
    reconnectPromise = nextReconnectPromise;
    reconnectPromiseGeneration = generationAtStart;
    return nextReconnectPromise;
  }
  async function resolveSessionTarget(activeClient: IntercomClient, nameOrId: string): Promise<string | null> {
    const sessions = await activeClient.listSessions();
    const byId = sessions.find(s => s.id === nameOrId);
    if (byId) {
      return byId.id;
    }
    const lowerName = nameOrId.toLowerCase();
    const byName = sessions.filter(s => s.name?.toLowerCase() === lowerName);
    if (byName.length > 1) {
      throw new Error(`Multiple sessions named "${nameOrId}" are connected. Use the session ID instead.`);
    }
    return byName[0]?.id ?? null;
  }
  function deliverLocalSubagentRelayMessage(sender: "subagent-control" | "subagent-result", status: string, messageText: string): void {
    const now = Date.now();
    sendIncomingMessage({
      from: {
        id: sender,
        name: sender,
        cwd: runtimeContext?.cwd ?? process.cwd(),
        model: sender,
        pid: process.pid,
        startedAt: now,
        lastActivity: now,
        status,
      },
      message: {
        id: randomUUID(),
        timestamp: now,
        content: { text: messageText },
      },
      bodyText: messageText,
    }, "trigger");
  }
  function recordSubagentDeliveryError(entryType: string, to: string, message: string, error: unknown): void {
    pi.appendEntry(entryType, {
      to,
      message,
      error: getErrorMessage(error),
      timestamp: Date.now(),
    });
  }
  function emitResultDelivery(requestId: string | undefined, delivered: boolean, error?: unknown): void {
    if (!requestId) return;
    pi.events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, {
      requestId,
      delivered,
      ...(error ? { error: getErrorMessage(error) } : {}),
    });
  }
  function relaySubagentIntercomPayload(payload: unknown, options: {
    sender: "subagent-control" | "subagent-result";
    status: string;
    errorEntryType: string;
    acknowledge?: boolean;
  }): void {
    const parsed = parseSubagentIntercomPayload(payload);
    if (!parsed) return;

    const relayGeneration = runtimeGeneration;
    void (async () => {
      const relayStillLive = () => !runtimeStarted || Boolean(getLiveContext(runtimeContext, relayGeneration));
      if (!relayStillLive()) {
        return;
      }
      if (currentSessionTargetMatches(parsed.to)) {
        deliverLocalSubagentRelayMessage(options.sender, options.status, parsed.message);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, true);
        return;
      }

      let activeClient: IntercomClient;
      let target: string;
      try {
        activeClient = await ensureConnected("background");
        target = await resolveSessionTarget(activeClient, parsed.to) ?? parsed.to;
      } catch (error) {
        if (!relayStillLive()) return;
        recordSubagentDeliveryError(options.errorEntryType, parsed.to, parsed.message, error);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, false, error);
        return;
      }

      if (!relayStillLive()) {
        return;
      }
      if (currentSessionTargetMatches(parsed.to, target, activeClient)) {
        deliverLocalSubagentRelayMessage(options.sender, options.status, parsed.message);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, true);
        return;
      }

      try {
        const result = await activeClient.send(target, { text: parsed.message });
        if (!relayStillLive()) return;
        if (!result.delivered) {
          const error = new Error(result.reason ?? "Session may not exist or has disconnected.");
          recordSubagentDeliveryError(options.errorEntryType, parsed.to, parsed.message, error);
          if (options.acknowledge) emitResultDelivery(parsed.requestId, false, error);
          return;
        }
        if (options.acknowledge) emitResultDelivery(parsed.requestId, true);
      } catch (error) {
        if (!relayStillLive()) return;
        recordSubagentDeliveryError(options.errorEntryType, parsed.to, parsed.message, error);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, false, error);
      }
    })();
  }
  pi.events.on(SUBAGENT_CONTROL_INTERCOM_EVENT, (payload) => {
    relaySubagentIntercomPayload(payload, {
      sender: "subagent-control",
      status: "needs_attention",
      errorEntryType: "intercom_control_error",
    });
  });
  pi.events.on(SUBAGENT_RESULT_INTERCOM_EVENT, (payload) => {
    relaySubagentIntercomPayload(payload, {
      sender: "subagent-result",
      status: "result",
      errorEntryType: "intercom_result_error",
      acknowledge: true,
    });
  });
  pi.on("session_start", (_event, ctx) => {
    if (!config.enabled) {
      return;
    }
    shuttingDown = false;
    disposed = false;
    runtimeStarted = true;
    runtimeGeneration += 1;
    reconnectAttempt = 0;
    clearReconnectTimer();
    clearStartupConnectTimer();
    runtimeContext = ctx;
    currentSessionId = ctx.sessionManager.getSessionId();
    currentModel = ctx.model?.id ?? "unknown";
    sessionStartedAt = Date.now();
    agentRunning = false;
    activeTools.clear();
    const startupGeneration = runtimeGeneration;
    startupConnectTimer = setTimeout(() => {
      startupConnectTimer = null;
      if (!getLiveContext(ctx, startupGeneration)) {
        return;
      }
      void ensureConnected("startup").catch(() => {
        if (!getLiveContext(ctx, startupGeneration)) {
          return;
        }
        client = null;
        scheduleReconnect();
      });
    }, 0);
  });
  
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    disposed = true;
    runtimeGeneration += 1;
    clearStartupConnectTimer();
    clearReconnectTimer();
    rejectReplyWaiter(new Error("Session shutting down"));
    replyTracker.reset();
    pendingIdleMessages.length = 0;
    clearConnectedPeer();
    pendingDuplexForward = null;
    delete (globalThis as any).__intercomProseReady;
    clearInboundFlushTimer();
    agentRunning = false;
    activeTools.clear();
    if (client) {
      await client.disconnect();
      client = null;
    }
    runtimeContext = null;
    currentSessionId = null;
    sessionStartedAt = null;
  });
  pi.on("turn_end", () => {
    if (!getLiveContext()) {
      return;
    }
    replyTracker.endTurn();
    scheduleInboundFlush(0);
  });
  pi.on("agent_start", () => {
    if (!getLiveContext()) {
      return;
    }
    agentRunning = true;
    activeTools.clear();
    syncPresenceStatus();
  });
  pi.on("tool_execution_start", (event) => {
    if (!getLiveContext()) {
      return;
    }
    activeTools.set(event.toolCallId, event.toolName);
    syncPresenceStatus();
  });
  pi.on("tool_execution_end", (event) => {
    if (!getLiveContext()) {
      return;
    }
    activeTools.delete(event.toolCallId);
    syncPresenceStatus();
  });
  pi.on("agent_end", (event) => {
    if (!getLiveContext()) {
      return;
    }
    agentRunning = false;
    activeTools.clear();
    syncPresenceStatus();
    scheduleInboundFlush(0);

    // Forward last output to duplex-connected peer (automatic send_message to connected session)
    if (connectedPeer && client?.isConnected()) {
      let duplexForwardText: string | null = null;
      const messages = event.messages;
      if (messages && messages.length > 0) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg.role === "assistant" && msg.content) {
            for (const part of msg.content) {
              if (part.type === "text" && typeof (part as any).text === "string") {
                duplexForwardText = (part as any).text;
                break;
              }
            }
            if (duplexForwardText) break;
          }
        }
      }
      if (duplexForwardText) {
        client.send(connectedPeer.id, {
          text: duplexForwardText,
          deliverAsUser: true,
          expectsReply: false,
        }).catch(() => {
          // Best-effort; the peer will catch up on next turn
        });
      } else {
        // No assistant text found — rendered-prose may deliver later
        pendingDuplexForward = { peerId: connectedPeer.id };
      }
    }


    // Send results back for completed deliverAsUser messages
    if (pendingUserMessageResults.length > 0) {
      // Find the last assistant message from the completed agent loop
      let lastAssistantText: string | null = null;
      const messages = event.messages;
      if (messages && messages.length > 0) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg.role === "assistant" && msg.content) {
            for (const part of msg.content) {
              if (part.type === "text" && typeof (part as any).text === "string") {
                lastAssistantText = (part as any).text;
                break;
              }
            }
            if (lastAssistantText) break;
          }
        }
      }

      const pending = pendingUserMessageResults.shift()!;
      if (lastAssistantText) {
        const activeClient = client;
        if (activeClient?.isConnected()) {
          activeClient.send(pending.from.id, {
            text: lastAssistantText,
            replyTo: pending.expectsReply ? pending.messageId : undefined,
          }).catch(() => {
            // Best-effort result delivery
          });
        }
      } else {
        // No assistant text found (e.g., two-pass renderer will deliver fsn-prose via global hook later).
        // Re-queue the pending entry for prose-ready hook capture.
        pendingUserMessageResults.unshift(pending);
      }
    }
  });


  pi.on("turn_start", (_event, ctx) => {
    if (!getLiveContext(ctx)) {
      return;
    }
    currentSessionId = ctx.sessionManager.getSessionId();
    syncPresenceIdentity(ctx.sessionManager.getSessionId());
    replyTracker.beginTurn();
  });
  pi.on("model_select", (event, ctx) => {
    if (!getLiveContext(ctx)) {
      return;
    }
    currentModel = event.model.id;
    if (client) {
      client.updatePresence({
        ...buildPresenceIdentity(pi, ctx.sessionManager.getSessionId()),
        model: event.model.id,
        status: currentStatus(),
      });
    }
  });

  pi.registerMessageRenderer("intercom_message", (message, _options, theme) => {
    const details = message.details as { from: SessionInfo; message: Message; replyCommand?: string; bodyText?: string } | undefined;
    if (!details) return undefined;
    return new InlineMessageComponent(details.from, details.message, theme, details.replyCommand, details.bodyText);
  });

  pi.registerTool({
    name: "intercom",
    label: "Intercom",
    description: `Send a message to another session.
Use this to communicate findings, request help, or coordinate work with other sessions.

Usage:
  intercom({ action: "list" })                    → List active sessions
  intercom({ action: "send", to: "session-name", message: "..." })  → Send message
  intercom({ action: "ask", to: "session-name", message: "..." })   → Ask and wait for reply
  intercom({ action: "reply", message: "..." })                      → Reply to the active/single pending ask
  intercom({ action: "pending" })                                      → List unresolved inbound asks
  intercom({ action: "status" })                  → Show connection status`,
    promptSnippet:
      "Use to coordinate with other local sessions: list peers, send updates, ask for help, or check intercom connectivity.",

    parameters: Type.Object({
      action: Type.String({
        description: "Action: 'list', 'send', 'ask', 'reply', 'pending', or 'status'",
      }),
      to: Type.Optional(Type.String({
        description: "Target session name or ID (for 'send', 'ask', or disambiguating 'reply')",
      })),
      message: Type.Optional(Type.String({
        description: "Message to send (for 'send', 'ask', or 'reply' action)",
      })),
      attachments: Type.Optional(Type.Array(Type.Object({
        type: Type.Union([Type.Literal("file"), Type.Literal("snippet"), Type.Literal("context")]),
        name: Type.String(),
        content: Type.String(),
        language: Type.Optional(Type.String()),
      }))),
      replyTo: Type.Optional(Type.String({
        description: "Message ID to reply to (for threading or responding to an 'ask')",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let connectedClient: IntercomClient;
      try {
        connectedClient = await ensureConnected("tool");
      } catch (error) {
        return {
          content: [{ type: "text", text: `Intercom not connected: ${getErrorMessage(error)}` }],
          isError: true,
          details: { error: true },
        };
      }

      syncPresenceIdentity(ctx.sessionManager.getSessionId());

      const { action, to, message, attachments, replyTo } = params;

      switch (action) {
        case "list": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            const currentSession = sessions.find(s => s.id === mySessionId);
            const otherSessions = sessions.filter(s => s.id !== mySessionId);

            if (!currentSession) {
              return {
                content: [{ type: "text", text: "Current session is missing from intercom session list." }],
                isError: true,
                details: { error: true },
              };
            }

            const currentSection = `**Current session:**\n${formatSessionListRow(currentSession, currentSession.cwd, true)}`;
            const otherSection = otherSessions.length === 0
              ? "**Other sessions:**\nNo other sessions connected."
              : `**Other sessions:**\n${otherSessions.map(s => formatSessionListRow(s, currentSession.cwd, false)).join("\n")}`;

            return {
              content: [{ type: "text", text: `${currentSection}\n\n${otherSection}` }],
              isError: false,
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to list sessions: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "send": {
          if (!to || !message) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
              isError: true,
              details: { error: true },
            };
          }
          try {
            const sendTo = await resolveSessionTarget(connectedClient, to) ?? to;
            if (sendTo === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                isError: true,
                details: { error: true },
              };
            }
            if (!replyTo && config.confirmSend && ctx.hasUI) {
              const attachmentText = attachments?.length ? formatAttachments(attachments) : "";
              const confirmed = await ctx.ui.confirm(
                "Send Message",
                `Send to "${to}":\n\n${message}${attachmentText}`,
              );
              if (!confirmed) {
                return {
                  content: [{ type: "text", text: "Message cancelled by user" }],
                  isError: false,
                };
              }
            }
            const result = await connectedClient.send(sendTo, {
              text: message,
              attachments,
              replyTo,
            });
            if (!result.delivered) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{ type: "text", text: `Message to "${to}" was not delivered: ${errorText}` }],
                isError: true,
                details: { messageId: result.id, delivered: false, reason: result.reason },
              };
            }
            pi.appendEntry("intercom_sent", {
              to,
              message: { text: message, attachments, replyTo },
              messageId: result.id,
              timestamp: Date.now(),
            });
            if (replyTo) {
              replyTracker.markReplied(replyTo);
            }
            return {
              content: [{ type: "text", text: `Message sent to ${to}` }],
              isError: false,
              details: { messageId: result.id, delivered: true },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to send: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "ask": {
          if (!to || !message) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
              isError: true,
              details: { error: true },
            };
          }

          if (replyWaiter) {
            return {
              content: [{ type: "text", text: "Already waiting for a reply" }],
              isError: true,
              details: { error: true },
            };
          }

          if (_signal?.aborted) {
            return {
              content: [{ type: "text", text: "Cancelled" }],
              isError: true,
              details: { error: true },
            };
          }
          let replyPromise: Promise<Message> | null = null;

          try {
            const sendTo = await resolveSessionTarget(connectedClient, to) ?? to;
            if (_signal?.aborted) {
              return {
                content: [{ type: "text", text: "Cancelled" }],
                isError: true,
                details: { error: true },
              };
            }
            if (sendTo === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                isError: true,
                details: { error: true },
              };
            }
            const questionId = randomUUID();
            replyPromise = waitForReply(sendTo, questionId, _signal);
            const sendResult = await connectedClient.send(sendTo, {
              messageId: questionId,
              text: message,
              attachments,
              replyTo,
              expectsReply: true,
            });

            if (!sendResult.delivered) {
              const errorText = sendResult.reason ?? "Session may not exist or has disconnected.";
              rejectReplyWaiter(new Error(`Message to "${to}" was not delivered: ${errorText}`));
              if (replyPromise) {
                try {
                  await replyPromise;
                } catch {
                  // The waiter was already rejected above. Keep the delivery failure as the only error here.
                }
              }
              return {
                content: [{ type: "text", text: `Message to "${to}" was not delivered: ${errorText}` }],
                isError: true,
                details: { error: true },
              };
            }
            pi.appendEntry("intercom_sent", {
              to,
              message: { text: message, attachments, replyTo },
              messageId: sendResult.id,
              timestamp: Date.now(),
            });
            const replyMessage = await replyPromise;
            const replyText = replyMessage.content.text;
            const replyAttachments = replyMessage.content.attachments?.length
              ? formatAttachments(replyMessage.content.attachments)
              : "";
            pi.appendEntry("intercom_received", {
              from: to,
              message: { text: replyText, attachments: replyMessage.content.attachments },
              messageId: replyMessage.id,
              timestamp: replyMessage.timestamp,
            });
            return {
              content: [{ type: "text", text: `**Reply from ${to}:**\n${replyText}${replyAttachments}` }],
              isError: false,
            };
          } catch (error) {
            rejectReplyWaiter(toError(error));
            if (replyPromise) {
              try {
                await replyPromise;
              } catch {
                // The waiter is cleanup-only on this path. The real failure is the one from the outer catch.
              }
            }
            return {
              content: [{ type: "text", text: `Failed: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "reply": {
          if (!message) {
            return {
              content: [{ type: "text", text: "Missing 'message' parameter" }],
              isError: true,
              details: { error: true },
            };
          }

          try {
            const target = replyTracker.resolveReplyTarget({ to });
            if (target.from.id === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                isError: true,
                details: { error: true },
              };
            }
            const result = await connectedClient.send(target.from.id, {
              text: message,
              replyTo: target.message.id,
            });
            if (!result.delivered) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{ type: "text", text: `Reply to "${target.from.name || target.from.id}" was not delivered: ${errorText}` }],
                isError: true,
                details: { messageId: result.id, delivered: false, reason: result.reason },
              };
            }
            replyTracker.markReplied(target.message.id);
            pi.appendEntry("intercom_sent", {
              to: target.from.name || target.from.id,
              message: { text: message, replyTo: target.message.id },
              messageId: result.id,
              timestamp: Date.now(),
            });
            return {
              content: [{ type: "text", text: `Reply sent to ${target.from.name || target.from.id}` }],
              isError: false,
              details: { messageId: result.id, delivered: true, replyTo: target.message.id },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to reply: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "pending": {
          const pendingAsks = replyTracker.listPending();
          if (pendingAsks.length === 0) {
            return {
              content: [{ type: "text", text: "No unresolved inbound asks." }],
              isError: false,
            };
          }

          const now = Date.now();
          const lines = pendingAsks.map(({ from, message, receivedAt }) => {
            const preview = message.content.text.replace(/\s+/g, " ").slice(0, 80);
            const elapsedSeconds = Math.max(0, Math.floor((now - receivedAt) / 1000));
            return `- ${from.name || from.id} · ${message.id} · ${elapsedSeconds}s ago · ${preview}`;
          });
          return {
            content: [{ type: "text", text: `**Pending asks:**\n${lines.join("\n")}` }],
            isError: false,
          };
        }

        case "status": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            return {
              content: [{
                type: "text",
                text: `**Intercom Status:**\nConnected: Yes\nSession ID: ${mySessionId}\nActive sessions: ${sessions.length}`,
              }],
              isError: false,
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to get status: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${action}` }],
            isError: true,
            details: { error: true },
          };
      }
    },
    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "intercom";
      const target = typeof args.to === "string" && args.to.trim() ? args.to.trim() : undefined;
      const messagePreview = previewText(args.message, 96);
      const attachmentCount = Array.isArray(args.attachments) ? args.attachments.length : 0;
      let text = theme.fg("toolTitle", theme.bold("intercom "));
      text += theme.fg(action === "ask" ? "warning" : action === "reply" ? "success" : "accent", action);
      if (target) {
        text += " " + theme.fg("muted", "→") + " " + theme.fg("accent", target);
      }
      if (attachmentCount > 0) {
        text += " " + theme.fg("dim", `(${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"})`);
      }
      if (messagePreview) {
        text += "\n  " + theme.fg("dim", messagePreview);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme, context) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Intercom working..."), 0, 0);
      }
      const details = result.details as { delivered?: boolean; error?: boolean; messageId?: string; reason?: string } | undefined;
      const failed = Boolean(context.isError || details?.error === true || details?.delivered === false);
      let text = failed ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
      text += theme.fg(failed ? "error" : "text", firstTextContent(result));
      if (details?.messageId && !context.expanded) {
        text += theme.fg("dim", ` (${details.messageId.slice(0, 8)})`);
      }
      if (details?.reason && context.expanded) {
        text += "\n" + theme.fg("dim", `Reason: ${details.reason}`);
      }
      return new Text(text, 0, 0);
    },
  });


  pi.registerTool({
    name: "send_message",
    label: "发消息", // 更加自然直观
    description: `向另一个在线的人发送一条即时消息。
  对方会像收到真正的用户留言一样立刻查看并处理。
  你可以用它来呼叫默默流转的后勤伙伴、推动剧本杀/跑团里的GM剧情、或者联动其他角色的故事线。

  使用指南：
    send_message({ to: "对方名字", message: "..." })          → 开启“通话模式”：发过去后，你会留在原地等对方把话完全说完。
    send_message({ to: "对方名字", message: "...", blocking: false }) → 开启“留言模式”：消息发完你就去忙别的，对方稍后处理完了会弹窗提醒你。

  “通话模式（默认）”会让你原地等待对方处理完毕，并直接拿到他的最终回复。
  “留言模式”则是已读不回（暂时），消息送达后你可以自由行动，对方的答复随后会以新消息的形式发给你。`
    ,
    promptSnippet:
      "给另一个在线的人发送一条留言。适用于……打游戏？",

    parameters: Type.Object({
      action: Type.Optional(Type.String({
        description: "固定为 'send'（默认发信动作）",
      })),
      to: Type.String({
        description: "接收方的房间名或伙伴的名字（ID）",
      }),
      message: Type.String({
        description: "你想对TA说的话",
      }),
      blocking: Type.Optional(Type.Boolean({
        description: "是否留在原地等TA说完全部的话？默认为 true（是，在线等）；设置为 false 则为留言后去忙别的。",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let connectedClient: IntercomClient;
      try {
        connectedClient = await ensureConnected("tool");
      } catch (error) {
        return {
          content: [{ type: "text", text: `Intercom not connected: ${getErrorMessage(error)}` }],
          isError: true,
          details: { error: true },
        };
      }

      syncPresenceIdentity(ctx.sessionManager.getSessionId());

      const { to, message, blocking } = params;
      const blockingMode = blocking !== false; // default true

      if (!to || !message) {
        return {
          content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
          isError: true,
          details: { error: true },
        };
      }

      try {
        const sendTo = await resolveSessionTarget(connectedClient, to) ?? to;
        if (sendTo === connectedClient.sessionId) {
          return {
            content: [{ type: "text", text: "Cannot message the current session" }],
            isError: true,
            details: { error: true },
          };
        }

        if (blockingMode) {
          // Blocking: send with expectsReply, wait for the remote agent's final result
          if (_signal?.aborted) {
            return {
              content: [{ type: "text", text: "Cancelled" }],
              isError: true,
              details: { error: true },
            };
          }

          if (replyWaiter) {
            return {
              content: [{ type: "text", text: "Already waiting for a reply from another send_message call" }],
              isError: true,
              details: { error: true },
            };
          }

          const questionId = randomUUID();
          const replyPromise = waitForReply(sendTo, questionId, _signal);

          const sendResult = await connectedClient.send(sendTo, {
            messageId: questionId,
            text: message,
            deliverAsUser: true,
            expectsReply: true,
          });

          if (!sendResult.delivered) {
            const errorText = sendResult.reason ?? "Session may not exist or has disconnected.";
            rejectReplyWaiter(new Error(`Message to "${to}" was not delivered: ${errorText}`));
            try { await replyPromise; } catch { /* already rejected */ }
            return {
              content: [{ type: "text", text: `Message to "${to}" was not delivered: ${errorText}` }],
              isError: true,
              details: { error: true },
            };
          }

          pi.appendEntry("send_message_sent", { to, message, blocking: true, timestamp: Date.now() });

          const replyMessage = await replyPromise;
          const replyText = replyMessage.content.text;

          pi.appendEntry("send_message_received", {
            from: to,
            message: replyText,
            timestamp: Date.now(),
          });

          return {
            content: [{ type: "text", text: replyText }],
            isError: false,
          };
        } else {
          // Non-blocking: send and return immediately
          const messageId = randomUUID();
          const sendResult = await connectedClient.send(sendTo, {
            messageId,
            text: message,
            deliverAsUser: true,
            expectsReply: false,
          });

          if (!sendResult.delivered) {
            const errorText = sendResult.reason ?? "Session may not exist or has disconnected.";
            return {
              content: [{ type: "text", text: `Message to "${to}" was not delivered: ${errorText}` }],
              isError: true,
              details: { error: true },
            };
          }

          pi.appendEntry("send_message_sent", { to, message, blocking: false, timestamp: Date.now() });

          return {
            content: [{ type: "text", text: `Message sent to ${to}. Result will arrive when the remote agent finishes processing.` }],
            isError: false,
            details: { messageId, delivered: true, blocking: false },
          };
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed: ${getErrorMessage(error)}` }],
          isError: true,
          details: { error: true },
        };
      }
    },
    renderCall(args, theme) {
      const target = typeof args.to === "string" && args.to.trim() ? args.to.trim() : undefined;
      const messagePreview = previewText(args.message, 96);
      const isBlocking = args.blocking !== false;
      const modeLabel = isBlocking ? "blocking" : "fire-and-forget";
      let text = theme.fg("toolTitle", theme.bold("send_message "));
      text += theme.fg("warning", modeLabel);
      if (target) {
        text += " " + theme.fg("muted", "→") + " " + theme.fg("accent", target);
      }
      if (messagePreview) {
        text += "\n  " + theme.fg("dim", messagePreview);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme, context) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Waiting for remote agent..."), 0, 0);
      }
      const details = result.details as { delivered?: boolean; error?: boolean; messageId?: string; blocking?: boolean } | undefined;
      const failed = Boolean(context.isError || details?.error === true || details?.delivered === false);
      if (failed) {
        return new Text(theme.fg("error", "✗ ") + theme.fg("error", firstTextContent(result)), 0, 0);
      }
      const isNonBlocking = details?.blocking === false;
      if (isNonBlocking) {
        return new Text(theme.fg("success", "→ ") + theme.fg("text", firstTextContent(result)), 0, 0);
      }
      // Blocking result: show the result text
      return new Text(theme.fg("success", "✓ ") + theme.fg("text", firstTextContent(result)), 0, 0);
    },
  });

  async function openIntercomOverlay(ctx: ExtensionContext): Promise<void> {

    const overlayGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, overlayGeneration);
    if (!liveContext?.hasUI) return;

    let overlayClient: IntercomClient;
    try {
      overlayClient = await ensureConnected("overlay");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }
    if (!getLiveContext(ctx, overlayGeneration)) return;

    syncPresenceIdentity(ctx.sessionManager.getSessionId());

    let currentSession: SessionInfo;
    let sessions: SessionInfo[];
    let duplicates: Set<string>;
    try {
      const mySessionId = overlayClient.sessionId;
      const allSessions = await overlayClient.listSessions();
      if (!getLiveContext(ctx, overlayGeneration)) return;
      const foundCurrentSession = allSessions.find(s => s.id === mySessionId);
      if (!foundCurrentSession) {
        notifyIfLive(ctx, "Current session is missing from intercom session list", "error", overlayGeneration);
        return;
      }
      currentSession = foundCurrentSession;
      duplicates = duplicateSessionNames(allSessions);
      sessions = allSessions.filter(s => s.id !== mySessionId);
    } catch (error) {
      notifyIfLive(ctx, `Failed to list sessions: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }

    const selectedSession = await ctx.ui.custom<SessionInfo | undefined>(
      (_tui, theme, keybindings, done) => new SessionListOverlay(theme, keybindings, currentSession, sessions, done),
      { overlay: true }
    ).catch(() => undefined);

    if (!selectedSession || !getLiveContext(ctx, overlayGeneration)) return;

    try {
      overlayClient = await ensureConnected("overlay");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }
    if (!getLiveContext(ctx, overlayGeneration)) return;

    const targetLabel = formatSessionLabel(selectedSession, duplicates);

    const result = await ctx.ui.custom<ComposeResult>(
      (tui, theme, keybindings, done) => new ComposeOverlay(tui, theme, keybindings, selectedSession, targetLabel, overlayClient, done),
      { overlay: true }
    ).catch(() => undefined);

    if (result?.sent && result.messageId && result.text && getLiveContext(ctx, overlayGeneration)) {
      pi.appendEntry("intercom_sent", {
        to: selectedSession.name || selectedSession.id,
        message: { text: result.text },
        messageId: result.messageId,
        timestamp: Date.now(),
      });
      notifyIfLive(ctx, `Message sent to ${targetLabel}`, "info", overlayGeneration);
    }
  }

  // ── Slash commands for duplex conversation (no tools needed) ──
  pi.registerCommand("connect", {
    description: "Open a duplex conversation channel with another session. " +
      "Once connected, both sides' replies flow automatically as user messages — no tools needed.",
    handler: async (args, ctx) => {
      const targetName = (typeof args === "string" ? args : "").trim();
      if (!targetName) {
        if (ctx.hasUI) {
          ctx.ui.notify("Usage: /connect <session name>", "warning");
        }
        return;
      }
      if (connectedPeer) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Already connected to "${connectedPeer.name}". Use /disconnect first.`, "error");
        }
        return;
      }
      let activeClient: IntercomClient;
      try {
        activeClient = await ensureConnected("tool");
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Intercom not connected: ${getErrorMessage(error)}`, "error");
        }
        return;
      }
      if (activeClient.sessionId === null) {
        if (ctx.hasUI) ctx.ui.notify("No session ID yet.", "error");
        return;
      }
      const targetId = await resolveSessionTarget(activeClient, targetName) ?? null;
      if (!targetId) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Session "${targetName}" not found. Use /intercom to list sessions.`, "error");
        }
        return;
      }
      if (targetId === activeClient.sessionId) {
        if (ctx.hasUI) ctx.ui.notify("Cannot connect to yourself.", "warning");
        return;
      }
      // Send connect request to peer (deliverAsUser: false so it goes through handleDuplexProtocolMessage)
      const myName = buildPresenceIdentity(pi, activeClient.sessionId).name;
      const requestResult = await activeClient.send(targetId, {
        text: `${CONNECT_PREFIX}${myName}`,
        deliverAsUser: false,
        expectsReply: false,
      });
      if (!requestResult.delivered) {
        const reason = requestResult.reason ?? "Delivery failed.";
        if (ctx.hasUI) ctx.ui.notify(`Connection request not delivered: ${reason}`, "error");
        return;
      }
      // Store the peer locally
      connectedPeer = { id: targetId, name: targetName };
      syncPresenceStatus();
      if (ctx.hasUI) {
        ctx.ui.notify(`🔗 Duplex connected to "${targetName}". ` +
          `Your replies will now flow automatically to them, and vice versa.`, "info");
      }
    },
  });

  pi.registerCommand("disconnect", {
    description: "Close the current duplex conversation channel.",
    handler: async (_args, ctx) => {
      if (!connectedPeer) {
        if (ctx.hasUI) ctx.ui.notify("Not currently connected to any session.", "warning");
        return;
      }
      const peer = connectedPeer;
      connectedPeer = null;
      syncPresenceStatus();
      // Notify peer
      let activeClient: IntercomClient | null = null;
      try {
        activeClient = client;
        if (activeClient?.isConnected()) {
          await activeClient.send(peer.id, {
            text: `${DISCONNECT_PREFIX}${peer.name}`,
            deliverAsUser: false,
            expectsReply: false,
          });
        }
      } catch {
        // Best-effort
      }
      if (ctx.hasUI) {
        ctx.ui.notify(`🔗 Duplex disconnected from "${peer.name}".`, "info");
      }
    },
  });

  // ── Legacy overlay commands ──
  pi.registerCommand("intercom", {
    description: "List sessions (use /connect <name> for duplex)",
    handler: async (_args, ctx) => openIntercomOverlay(ctx),
  });

  pi.registerShortcut("alt+m", {
    description: "Open session intercom",
    handler: async (ctx) => openIntercomOverlay(ctx),
  });
}
