/**
 * Beads Continuation Enforcer Plugin for OpenCode
 *
 * Monitors for in-progress beads when session becomes idle and injects
 * continuation prompts to prevent premature stopping. Uses `bd` CLI.
 */

import type { Plugin } from '@opencode-ai/plugin';

interface Bead {
  id: string;
  title: string;
  status: string;
  type?: string;
  priority?: number;
}

interface SessionState {
  lastErrorAt?: number;
  countdownTimer?: ReturnType<typeof setTimeout>;
  countdownInterval?: ReturnType<typeof setInterval>;
  isRecovering?: boolean;
}

interface EventProperties {
  sessionID?: string;
  error?: unknown;
  info?: {
    id?: string;
    sessionID?: string;
    role?: string;
  };
}

const COUNTDOWN_SECONDS = 2;
const TOAST_DURATION_MS = 900;
const ERROR_COOLDOWN_MS = 3000;

const CONTINUATION_PROMPT = `[SYSTEM REMINDER - BEADS CONTINUATION]

You have incomplete beads (tasks) in progress. Continue working on the current bead.

- Proceed without asking for permission
- Complete the current bead before starting new work
- When done: \`bd close <bead-id>\` with summary of what changed
- Then check: \`bd ready\` for next available work

DO NOT STOP until the current bead is complete.`;

export const BeadsEnforcer: Plugin = async (ctx) => {
  const sessions = new Map<string, SessionState>();

  function getState(sessionID: string): SessionState {
    let state = sessions.get(sessionID);
    if (!state) {
      state = {};
      sessions.set(sessionID, state);
    }
    return state;
  }

  function cancelCountdown(sessionID: string): void {
    const state = sessions.get(sessionID);
    if (!state) return;

    if (state.countdownTimer) {
      clearTimeout(state.countdownTimer);
      state.countdownTimer = undefined;
    }
    if (state.countdownInterval) {
      clearInterval(state.countdownInterval);
      state.countdownInterval = undefined;
    }
  }

  function cleanup(sessionID: string): void {
    cancelCountdown(sessionID);
    sessions.delete(sessionID);
  }

  async function isBeadsInitialized(): Promise<boolean> {
    try {
      const result = await ctx.$`bd status`.quiet();
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async function getInProgressBeads(): Promise<Bead[]> {
    try {
      const result = await ctx.$`bd list --status=in_progress --json`.quiet();
      if (result.exitCode !== 0) return [];
      const stdout = result.stdout.toString();
      const parsed = JSON.parse(stdout || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async function getReadyBeads(epicId?: string): Promise<Bead[]> {
    try {
      const cmd = epicId ? ctx.$`bd ready --parent ${epicId} --json` : ctx.$`bd ready --json`;
      const result = await cmd.quiet();
      if (result.exitCode !== 0) return [];
      const stdout = result.stdout.toString();
      const parsed = JSON.parse(stdout || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async function getEpicIdFromBranch(): Promise<string | null> {
    try {
      const result = await ctx.$`git branch --show-current`.quiet();
      if (result.exitCode !== 0) return null;
      const branch = result.stdout.toString().trim();
      // Beads ID pattern: bd-XXXXXX (6+ hex chars)
      const match = branch.match(/bd-[a-f0-9]{6,}/i);
      return match ? match[0] : null;
    } catch {
      return null;
    }
  }

  async function showCountdownToast(seconds: number, incompleteCount: number): Promise<void> {
    try {
      await ctx.client.tui.showToast({
        body: {
          title: 'Beads Continuation',
          message: `Resuming in ${seconds}s... (${incompleteCount} bead${incompleteCount > 1 ? 's' : ''} in progress)`,
          variant: 'warning' as const,
          duration: TOAST_DURATION_MS,
        },
      });
    } catch {
      /* intentionally ignored */
    }
  }

  async function buildContinuationMessage(
    inProgress: Bead[],
    epicId: string | null
  ): Promise<string> {
    const currentBead = inProgress[0];
    const otherInProgress = inProgress.slice(1);
    const readyBeads = await getReadyBeads(epicId || undefined);

    let message = `${CONTINUATION_PROMPT}

## Current Work
- **${currentBead.id}**: ${currentBead.title}
  Status: in_progress
  Run \`bd show ${currentBead.id}\` to see full details
`;

    if (otherInProgress.length > 0) {
      message += `
## Also In Progress (${otherInProgress.length})
${otherInProgress.map((b) => `- ${b.id}: ${b.title}`).join('\n')}
`;
    }

    if (readyBeads.length > 0) {
      message += `
## Ready After This (${readyBeads.length})
${readyBeads
  .slice(0, 3)
  .map((b) => `- ${b.id}: ${b.title}`)
  .join('\n')}
${readyBeads.length > 3 ? `  ... and ${readyBeads.length - 3} more` : ''}
`;
    }

    message += `
## Required Actions
1. Continue implementing ${currentBead.id}
2. When complete: \`bd close ${currentBead.id}\`
3. Then check: \`bd ready${epicId ? ` --parent ${epicId}` : ''}\`
`;

    return message;
  }

  async function injectContinuation(sessionID: string): Promise<void> {
    const state = sessions.get(sessionID);

    if (state?.isRecovering) return;
    if (state?.lastErrorAt && Date.now() - state.lastErrorAt < ERROR_COOLDOWN_MS) return;

    const inProgress = await getInProgressBeads();
    if (inProgress.length === 0) return;

    const epicId = await getEpicIdFromBranch();
    const message = await buildContinuationMessage(inProgress, epicId);

    try {
      await ctx.client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: 'text', text: message }],
        },
        query: { directory: ctx.directory },
      });
    } catch {
      /* intentionally ignored */
    }
  }

  function startCountdown(sessionID: string, incompleteCount: number): void {
    const state = getState(sessionID);
    cancelCountdown(sessionID);

    let secondsRemaining = COUNTDOWN_SECONDS;
    showCountdownToast(secondsRemaining, incompleteCount);

    state.countdownInterval = setInterval(() => {
      secondsRemaining--;
      if (secondsRemaining > 0) {
        showCountdownToast(secondsRemaining, incompleteCount);
      }
    }, 1000);

    state.countdownTimer = setTimeout(() => {
      cancelCountdown(sessionID);
      injectContinuation(sessionID);
    }, COUNTDOWN_SECONDS * 1000);
  }

  async function handleEvent(event: { type: string; properties?: unknown }): Promise<void> {
    const props = event.properties as EventProperties | undefined;

    if (event.type === 'session.error') {
      const sessionID = props?.sessionID;
      if (!sessionID) return;

      const state = getState(sessionID);
      state.lastErrorAt = Date.now();
      cancelCountdown(sessionID);
      return;
    }

    if (event.type === 'session.idle') {
      const sessionID = props?.sessionID;
      if (!sessionID) return;

      if (!(await isBeadsInitialized())) return;

      const state = getState(sessionID);
      if (state.isRecovering) return;
      if (state.lastErrorAt && Date.now() - state.lastErrorAt < ERROR_COOLDOWN_MS) return;

      const inProgress = await getInProgressBeads();
      if (inProgress.length === 0) return;

      startCountdown(sessionID, inProgress.length);
      return;
    }

    if (event.type === 'message.updated') {
      const info = props?.info;
      const sessionID = info?.sessionID;
      const role = info?.role;

      if (!sessionID) return;

      if (role === 'user') {
        const state = sessions.get(sessionID);
        if (state) {
          state.lastErrorAt = undefined;
        }
        cancelCountdown(sessionID);
      }

      if (role === 'assistant') {
        cancelCountdown(sessionID);
      }
      return;
    }

    if (event.type === 'message.part.updated') {
      const info = props?.info;
      const sessionID = info?.sessionID;
      const role = info?.role;

      if (sessionID && role === 'assistant') {
        cancelCountdown(sessionID);
      }
      return;
    }

    if (event.type === 'tool.execute.before' || event.type === 'tool.execute.after') {
      const sessionID = props?.sessionID;
      if (sessionID) {
        cancelCountdown(sessionID);
      }
      return;
    }

    if (event.type === 'session.deleted') {
      const info = props?.info;
      if (info?.id) {
        cleanup(info.id);
      }
      return;
    }
  }

  return {
    event: async ({ event }) => {
      await handleEvent(event as { type: string; properties?: unknown });
    },
  };
};

export default BeadsEnforcer;
