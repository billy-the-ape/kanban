/**
 * AA-O1b: source of the OpenCode plugin Kanban generates per launch attempt.
 *
 * The emitted file is plain ESM so it runs on every release in the supported
 * range, and it uses only documented plugin surface: the exported plugin
 * receives the OpenCode context and returns `event`, `tool.execute.before`,
 * `tool.execute.after` and `permission.ask` handlers. OpenCode's private bus is
 * never imported, so an internal refactor cannot silently break a card.
 *
 * Kanban is called with an argv array through `node:child_process` instead of a
 * shell string, so a task path containing quotes, backticks or newlines can
 * neither rewrite the generated source nor split into extra arguments.
 *
 * Attribution rules the generated code implements, in order:
 * 1. No `KANBAN_HOOK_TASK_ID` in the environment means the plugin was loaded
 *    outside a Kanban launch, so it does nothing at all.
 * 2. Every hook call runs the Kanban CLI, which echoes the attempt token from
 *    `KANBAN_HOOK_ATTEMPT_ID`; Kanban drops events from a superseded attempt.
 * 3. Only the launch's root session is attributed. When Kanban resumed an exact
 *    session the id is pinned through `KANBAN_OPENCODE_SESSION_ID`, otherwise
 *    the first non-child session becomes the root and the binding is never
 *    re-pointed. Subagent sessions carry `parentID`, so their tool and
 *    completion activity can neither park nor finish the card.
 *
 * The state machine keeps one fact per turn: busy is emitted once per turn, a
 * review at most once per turn, a duplicate idle after a review is ignored, a
 * pending permission suppresses the completion review, and an error is recorded
 * with `notification_type: "error"` so Kanban marks the card with the error
 * review reason instead of an ordinary completion. An approval is asked inside
 * the tool, so the approved tool finishing is what resumes the parked turn: it
 * returns to busy, and that turn still gets its one completion review. Each turn
 * also owns its assistant text: a genuinely new turn forgets what the previous turn
 * said, so a tool-only or empty follow-up cannot repeat a summary the human already
 * read, while work that resumes after an approval or error pause keeps the text of
 * the turn it belongs to.
 */

const PLUGIN_PLACEHOLDERS = {
	reviewArgv: "__KANBAN_REVIEW_ARGV__",
	inProgressArgv: "__KANBAN_IN_PROGRESS_ARGV__",
	activityArgv: "__KANBAN_ACTIVITY_ARGV__",
} as const;

const PLUGIN_SOURCE = `const kanbanOpenCodeBridge = async ({ client }) => {
  const env = (typeof process !== "undefined" && process.env) || {};
  const taskId = String(env.KANBAN_HOOK_TASK_ID || "").trim();
  if (!taskId) {
    return {};
  }

  const reviewArgv = __KANBAN_REVIEW_ARGV__;
  const inProgressArgv = __KANBAN_IN_PROGRESS_ARGV__;
  const activityArgv = __KANBAN_ACTIVITY_ARGV__;

  const pinnedSessionID = String(env.KANBAN_OPENCODE_SESSION_ID || "").trim() || null;
  const MAX_TEXT = 8000;
  const HOOK_TIMEOUT_MS = 20000;
  const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{6,200}$/;

  let rootSessionID = pinnedSessionID;
  let rootBound = pinnedSessionID !== null;
  let state = "idle";
  let turn = 0;
  let lastReviewKey = null;
  let lastErrorKey = null;
  let lastReviewWasCompletion = false;
  let spawnImpl = null;

  const assistantTextByMessage = new Map();
  const latestAssistantText = new Map();
  const messageRoleByKey = new Map();
  const toolInputByCall = new Map();
  const childSessionCache = new Map();

  const asRecord = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value;
  };

  const clip = (value) => {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.length > MAX_TEXT ? trimmed.slice(0, MAX_TEXT) : trimmed;
  };

  const pairKey = (sessionID, id) => String(sessionID) + ":" + String(id);

  const encodePayload = (payload) => {
    if (!payload || typeof payload !== "object") {
      return "";
    }
    try {
      return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    } catch {
      return "";
    }
  };

  const describeError = (value) => {
    if (typeof value === "string") {
      return clip(value);
    }
    const record = asRecord(value);
    if (!record) {
      return null;
    }
    const nested = asRecord(record.data);
    return (
      clip(record.message) ||
      clip(nested && nested.message) ||
      clip(record.name) ||
      clip(nested && nested.name) ||
      "OpenCode reported an error"
    );
  };

  const loadSpawn = async () => {
    if (spawnImpl) {
      return spawnImpl;
    }
    try {
      const childProcess = await import("node:child_process");
      if (typeof childProcess.spawn === "function") {
        spawnImpl = childProcess.spawn;
        return spawnImpl;
      }
    } catch {
      // Node builtins are unavailable in this plugin host: stay silent.
    }
    return null;
  };

  const notify = async (argv, sessionID, metadata) => {
    if (!Array.isArray(argv) || argv.length < 1) {
      return;
    }
    const run = await loadSpawn();
    if (!run) {
      return;
    }
    const args = argv.slice(1);
    const payload = { source: "opencode" };
    if (metadata.hookEventName) {
      payload.hook_event_name = metadata.hookEventName;
    }
    if (metadata.notificationType) {
      payload.notification_type = metadata.notificationType;
    }
    if (metadata.activityText) {
      payload.activity_text = metadata.activityText;
    }
    if (metadata.toolName) {
      payload.tool_name = metadata.toolName;
    }
    if (metadata.toolInputSummary) {
      payload.tool_input_summary = metadata.toolInputSummary;
    }
    if (metadata.finalMessage) {
      payload.final_message = metadata.finalMessage;
    }
    if (sessionID && SAFE_SESSION_ID.test(sessionID)) {
      args.push("--session-id", sessionID);
    }
    const encoded = encodePayload(payload);
    if (encoded) {
      args.push("--metadata-base64", encoded);
    }
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      try {
        const child = run(argv[0], args, { stdio: "ignore" });
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // Best effort.
          }
          done();
        }, HOOK_TIMEOUT_MS);
        if (timer && typeof timer.unref === "function") {
          timer.unref();
        }
        child.on("error", () => {
          clearTimeout(timer);
          done();
        });
        child.on("close", () => {
          clearTimeout(timer);
          done();
        });
      } catch {
        // Best effort: a bridge failure must never break an OpenCode session.
        done();
      }
    });
  };

  const isChildSession = async (sessionID) => {
    if (!sessionID) {
      return true;
    }
    if (childSessionCache.has(sessionID)) {
      return childSessionCache.get(sessionID);
    }
    const listSessions = client && client.session && client.session.list;
    if (typeof listSessions !== "function") {
      // Without parentage data nothing distinguishes a child from the root, so the
      // first session seen becomes the root and any other session stays unowned.
      return rootBound ? sessionID !== rootSessionID : false;
    }
    if (childSessionCache.size > 512) {
      childSessionCache.clear();
    }
    try {
      const listed = await listSessions.call(client.session);
      const rows = Array.isArray(listed && listed.data) ? listed.data : [];
      const session = rows.find((candidate) => candidate && candidate.id === sessionID);
      const isChild = Boolean(session && session.parentID);
      childSessionCache.set(sessionID, isChild);
      return isChild;
    } catch {
      // A failed lookup is the same as having no parentage data: bind the first
      // session rather than dropping every card transition.
      return rootBound ? sessionID !== rootSessionID : false;
    }
  };

  const owns = async (sessionID) => {
    if (!sessionID) {
      return false;
    }
    if (rootBound) {
      return sessionID === rootSessionID;
    }
    if (await isChildSession(sessionID)) {
      return false;
    }
    rootSessionID = sessionID;
    rootBound = true;
    return true;
  };

  const markBusy = async (sessionID, hookEventName) => {
    if (!(await owns(sessionID))) {
      return;
    }
    if (state === "busy") {
      return;
    }
    // Work that resumes after an approval or error pause continues the same
    // turn, while work that starts after a finished review is a new turn with
    // its own single-review budget.
    const continuingTurn = state === "review" && !lastReviewWasCompletion;
    state = "busy";
    if (!continuingTurn) {
      turn += 1;
      lastReviewKey = null;
      // A new turn must not inherit the previous turn's assistant text: a
      // tool-only or empty follow-up would otherwise finish with the summary the
      // human already read. Only a genuinely new turn clears it, so text that
      // resumes after an approval or error pause still belongs to its own turn.
      latestAssistantText.delete(sessionID);
    }
    lastErrorKey = null;
    lastReviewWasCompletion = false;
    await notify(inProgressArgv, sessionID, { hookEventName });
  };

  const markError = async (sessionID, hookEventName, detail) => {
    if (!(await owns(sessionID))) {
      return;
    }
    const errorKey = "error:" + String(turn) + ":" + String(detail || "");
    if (lastErrorKey === errorKey) {
      return;
    }
    lastErrorKey = errorKey;
    state = "error";
    lastReviewWasCompletion = false;
    // An error review keeps the card visible for the human while the error
    // review reason says why; the completion review for this turn stays
    // suppressed, so a failed model call never reads as a finished task.
    await notify(reviewArgv, sessionID, {
      hookEventName,
      notificationType: "error",
      activityText: detail || "OpenCode reported an error",
      // Kept raw while streaming so chunk-boundary spaces survive; trimmed here.
      finalMessage: (latestAssistantText.get(sessionID) || "").trim() || null,
    });
  };

  const markIdle = async (sessionID, hookEventName) => {
    if (!(await owns(sessionID))) {
      return;
    }
    if (state !== "busy") {
      // Covers the launch-time idle before any turn, a duplicate idle after a
      // review, an idle that parks the card on an approval request, and an idle
      // that follows an error turn.
      return;
    }
    const reviewKey = String(sessionID) + ":" + String(turn);
    if (lastReviewKey === reviewKey) {
      return;
    }
    lastReviewKey = reviewKey;
    lastReviewWasCompletion = true;
    state = "review";
    await notify(reviewArgv, sessionID, {
      hookEventName,
      activityText: "OpenCode finished the turn",
      finalMessage: (latestAssistantText.get(sessionID) || "").trim() || null,
    });
  };

  const summarizeToolArgs = (args) => {
    const record = asRecord(args);
    if (!record) {
      return null;
    }
    const parts = [];
    const interesting = ["filePath", "path", "command", "pattern", "url", "title"];
    for (const name of interesting) {
      const value = record[name];
      if (typeof value === "string" && value.trim()) {
        parts.push(name + "=" + value.trim().slice(0, 200));
      }
    }
    return parts.length > 0 ? parts.join(" ") : null;
  };

  const recordTool = async (phase, input, output) => {
    // A typeof check alone is always truthy, so the object itself has to be
    // checked before a property is read off it.
    const sessionID = input && typeof input.sessionID === "string" ? input.sessionID : null;
    if (!(await owns(sessionID))) {
      return;
    }
    const toolName = clip(input && input.tool) || undefined;
    const callID = input && typeof input.callID === "string" ? input.callID : "";
    const callKey = callID ? pairKey(sessionID, callID) : "";
    // The summarized input belongs to the call, so it has to be read before the
    // after-phase forgets it. Reading it afterwards always produced an empty
    // summary, so the card lost the detail the before-event carried.
    let toolInputSummary;
    if (phase === "before") {
      if (callKey) {
        toolInputSummary = summarizeToolArgs(output && output.args) || undefined;
        toolInputByCall.set(callKey, toolInputSummary);
      }
      await markBusy(sessionID, "BeforeTool");
    } else {
      toolInputSummary = callKey ? toolInputByCall.get(callKey) || undefined : undefined;
      if (callKey) {
        toolInputByCall.delete(callKey);
      }
      // OpenCode runs the permission check inside the tool, so once the human
      // approves there is no further before-event for that call: the approved
      // tool simply finishes. Without this the turn stays parked as a review and
      // its final idle is dropped as a duplicate, leaving the card stuck waiting
      // on an approval that was already answered. Work that resumes a parked
      // approval, or follows an error, continues the turn rather than starting a
      // new one, which is what markBusy decides.
      if ((state === "review" && !lastReviewWasCompletion) || state === "error") {
        await markBusy(sessionID, "AfterTool");
      }
    }
    await notify(activityArgv, sessionID, {
      hookEventName: phase === "before" ? "BeforeTool" : "AfterTool",
      toolName,
      toolInputSummary,
    });
  };

  return {
    event: async (input) => {
      const event = asRecord(input && input.event);
      if (!event) {
        return;
      }
      const type = typeof event.type === "string" ? event.type : "";
      const properties = asRecord(event.properties) || {};

      if (type === "message.updated") {
        const info = asRecord(properties.info);
        const sessionID = info && typeof info.sessionID === "string" ? info.sessionID : null;
        if (!(await owns(sessionID))) {
          return;
        }
        const messageID = info && typeof info.id === "string" ? info.id : null;
        const role = info && typeof info.role === "string" ? info.role : null;
        if (messageID && role) {
          messageRoleByKey.set(pairKey(sessionID, messageID), role);
          if (role === "assistant" && !assistantTextByMessage.has(pairKey(sessionID, messageID))) {
            assistantTextByMessage.set(pairKey(sessionID, messageID), "");
          }
        }
        return;
      }

      if (type === "message.part.updated") {
        const part = asRecord(properties.part);
        if (!part) {
          return;
        }
        const sessionID = typeof part.sessionID === "string" ? part.sessionID : null;
        if (!(await owns(sessionID))) {
          return;
        }
        if (part.type !== "text" || typeof part.messageID !== "string") {
          return;
        }
        if (messageRoleByKey.get(pairKey(sessionID, part.messageID)) !== "assistant") {
          return;
        }
        const delta = typeof properties.delta === "string" ? properties.delta : "";
        const fullText = typeof part.text === "string" ? part.text : "";
        const messageKey = pairKey(sessionID, part.messageID);
        const previous = assistantTextByMessage.get(messageKey) || "";
        // Deltas are appended exactly as they arrive: trimming at each step would
        // drop the space that lands at a chunk boundary and glue words together.
        const next = delta ? previous + delta : fullText || previous;
        if (!next.trim()) {
          return;
        }
        const bounded = next.length > MAX_TEXT ? next.slice(0, MAX_TEXT) : next;
        assistantTextByMessage.set(messageKey, bounded);
        latestAssistantText.set(sessionID, bounded);
        return;
      }

      const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : null;
      if (type === "session.status") {
        const status = asRecord(properties.status);
        const statusType = status && typeof status.type === "string" ? status.type : "";
        if (statusType === "busy") {
          await markBusy(sessionID, "session.status");
        } else if (statusType === "idle") {
          await markIdle(sessionID, "session.status");
        }
        return;
      }
      if (type === "session.busy") {
        await markBusy(sessionID, "session.busy");
        return;
      }
      if (type === "session.idle") {
        await markIdle(sessionID, "session.idle");
        return;
      }
      if (type === "session.error") {
        await markError(sessionID, "session.error", describeError(properties.error));
      }
    },

    "tool.execute.before": async (input, output) => {
      await recordTool("before", input, output);
    },

    "tool.execute.after": async (input) => {
      await recordTool("after", input);
    },

    "permission.ask": async (permission, output) => {
      const status = output && typeof output.status === "string" ? output.status : "";
      if (status !== "ask") {
        return;
      }
      const sessionID = permission && typeof permission.sessionID === "string" ? permission.sessionID : null;
      if (!(await owns(sessionID))) {
        return;
      }
      // A parked approval is attention, not completion: the state keeps the
      // following idle from being reported as a finished turn.
      state = "review";
      lastReviewWasCompletion = false;
      const requested = clip(permission && permission.permission) || undefined;
      const resource = clip(permission && permission.pattern) || undefined;
      const summary = [requested, resource].filter(Boolean).join(" ");
      await notify(reviewArgv, sessionID, {
        hookEventName: "PermissionRequest",
        notificationType: "permission.asked",
        activityText: summary ? "OpenCode is waiting for approval: " + summary : "OpenCode is waiting for approval",
      });
    },
  };
};

export const KanbanPlugin = kanbanOpenCodeBridge;
export default kanbanOpenCodeBridge;
`;

export interface OpenCodePluginSourceInput {
	/** Kanban CLI argv that records a review transition. */
	reviewArgv: readonly string[];
	/** Kanban CLI argv that records the card returning to in progress. */
	inProgressArgv: readonly string[];
	/** Kanban CLI argv that records activity without moving the card. */
	activityArgv: readonly string[];
}

/**
 * Generates the plugin body for one launch attempt. The three Kanban CLI
 * invocations are injected as JSON arrays, so the generated source never
 * embeds a shell string and cannot be rewritten by an unusual path.
 */
export function buildOpenCodePluginSource(input: OpenCodePluginSourceInput): string {
	return PLUGIN_SOURCE.replaceAll(PLUGIN_PLACEHOLDERS.reviewArgv, () => JSON.stringify([...input.reviewArgv]))
		.replaceAll(PLUGIN_PLACEHOLDERS.inProgressArgv, () => JSON.stringify([...input.inProgressArgv]))
		.replaceAll(PLUGIN_PLACEHOLDERS.activityArgv, () => JSON.stringify([...input.activityArgv]));
}
