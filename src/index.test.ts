import { describe, it, expect, vi, afterEach } from 'vitest';
import { BeadsEnforcer } from './index';

type MockShellResult = {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
};

type MockShellFn = ReturnType<typeof vi.fn> & {
  quiet: () => Promise<MockShellResult>;
};

function createMockContext() {
  const shellMock = vi.fn();

  const createShellCall = (): MockShellFn => {
    const fn = vi.fn() as MockShellFn;
    fn.quiet = () => shellMock();
    return fn;
  };

  const $: ReturnType<typeof vi.fn> = vi.fn().mockImplementation(() => createShellCall());

  const ctx = {
    $,
    client: {
      session: {
        prompt: vi.fn().mockResolvedValue({}),
      },
      tui: {
        showToast: vi.fn().mockResolvedValue({}),
      },
    },
    directory: '/test/project',
    project: { name: 'test' },
    worktree: '/test/project',
    serverUrl: { href: 'http://localhost:3000' },
  };

  return { ctx, shellMock };
}

function mockShellResponse(exitCode: number, stdout: string): MockShellResult {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(''),
  };
}

type Hooks = Awaited<ReturnType<typeof BeadsEnforcer>>;

function fireEvent(hooks: Hooks, type: string, properties?: unknown): Promise<void> {
  return hooks.event!({ event: { type, properties } } as never);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('BeadsEnforcer', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should return an event hook', async () => {
      const { ctx } = createMockContext();
      const hooks = await BeadsEnforcer(ctx as never);

      expect(hooks).toHaveProperty('event');
      expect(typeof hooks.event).toBe('function');
    });
  });

  describe('session.idle event', () => {
    it('should skip if beads is not initialized', async () => {
      const { ctx, shellMock } = createMockContext();
      shellMock.mockResolvedValue(mockShellResponse(1, ''));

      const hooks = await BeadsEnforcer(ctx as never);
      await fireEvent(hooks, 'session.idle', { sessionID: 'test-session' });

      expect(ctx.client.tui.showToast).not.toHaveBeenCalled();
    });

    it('should skip if no in-progress beads', async () => {
      const { ctx, shellMock } = createMockContext();
      shellMock
        .mockResolvedValueOnce(mockShellResponse(0, ''))
        .mockResolvedValueOnce(mockShellResponse(0, '[]'));

      const hooks = await BeadsEnforcer(ctx as never);
      await fireEvent(hooks, 'session.idle', { sessionID: 'test-session' });

      expect(ctx.client.tui.showToast).not.toHaveBeenCalled();
    });

    it('should start countdown when in-progress beads exist', async () => {
      const { ctx, shellMock } = createMockContext();
      const inProgressBeads = [{ id: 'bd-abc123', title: 'Test bead', status: 'in_progress' }];

      shellMock
        .mockResolvedValueOnce(mockShellResponse(0, ''))
        .mockResolvedValueOnce(mockShellResponse(0, JSON.stringify(inProgressBeads)));

      const hooks = await BeadsEnforcer(ctx as never);
      await fireEvent(hooks, 'session.idle', { sessionID: 'test-session' });

      expect(ctx.client.tui.showToast).toHaveBeenCalledWith({
        body: expect.objectContaining({
          title: 'Beads Continuation',
          variant: 'warning',
        }),
      });
    });

    it('should inject continuation after countdown', async () => {
      const { ctx, shellMock } = createMockContext();
      const inProgressBeads = [{ id: 'bd-abc123', title: 'Test bead', status: 'in_progress' }];

      shellMock.mockResolvedValue(mockShellResponse(0, JSON.stringify(inProgressBeads)));

      const hooks = await BeadsEnforcer(ctx as never);
      await fireEvent(hooks, 'session.idle', { sessionID: 'test-session' });

      await delay(2100);

      expect(ctx.client.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { id: 'test-session' },
          body: {
            parts: [{ type: 'text', text: expect.stringContaining('BEADS CONTINUATION') }],
          },
        })
      );
    });
  });

  describe('session.error event', () => {
    it('should track error and enable cooldown', async () => {
      const { ctx, shellMock } = createMockContext();
      const inProgressBeads = [{ id: 'bd-abc123', title: 'Test bead', status: 'in_progress' }];

      shellMock
        .mockResolvedValueOnce(mockShellResponse(0, ''))
        .mockResolvedValueOnce(mockShellResponse(0, JSON.stringify(inProgressBeads)));

      const hooks = await BeadsEnforcer(ctx as never);

      await fireEvent(hooks, 'session.error', { sessionID: 'test-session' });
      await fireEvent(hooks, 'session.idle', { sessionID: 'test-session' });

      expect(ctx.client.tui.showToast).not.toHaveBeenCalled();
    });
  });

  describe('message.updated event', () => {
    it('should clear error state on user message', async () => {
      const { ctx, shellMock } = createMockContext();
      const inProgressBeads = [{ id: 'bd-abc123', title: 'Test bead', status: 'in_progress' }];

      const hooks = await BeadsEnforcer(ctx as never);

      await fireEvent(hooks, 'session.error', { sessionID: 'test-session' });
      await fireEvent(hooks, 'message.updated', {
        info: { sessionID: 'test-session', role: 'user' },
      });

      shellMock
        .mockResolvedValueOnce(mockShellResponse(0, ''))
        .mockResolvedValueOnce(mockShellResponse(0, JSON.stringify(inProgressBeads)));

      await fireEvent(hooks, 'session.idle', { sessionID: 'test-session' });

      expect(ctx.client.tui.showToast).toHaveBeenCalled();
    });

    it('should cancel countdown on assistant message', async () => {
      const { ctx, shellMock } = createMockContext();
      const inProgressBeads = [{ id: 'bd-abc123', title: 'Test bead', status: 'in_progress' }];

      shellMock
        .mockResolvedValueOnce(mockShellResponse(0, ''))
        .mockResolvedValueOnce(mockShellResponse(0, JSON.stringify(inProgressBeads)));

      const hooks = await BeadsEnforcer(ctx as never);
      await fireEvent(hooks, 'session.idle', { sessionID: 'test-session' });

      await fireEvent(hooks, 'message.updated', {
        info: { sessionID: 'test-session', role: 'assistant' },
      });

      await delay(2100);

      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });
  });

  describe('tool execution events', () => {
    it('should cancel countdown during tool execution', async () => {
      const { ctx, shellMock } = createMockContext();
      const inProgressBeads = [{ id: 'bd-abc123', title: 'Test bead', status: 'in_progress' }];

      shellMock
        .mockResolvedValueOnce(mockShellResponse(0, ''))
        .mockResolvedValueOnce(mockShellResponse(0, JSON.stringify(inProgressBeads)));

      const hooks = await BeadsEnforcer(ctx as never);
      await fireEvent(hooks, 'session.idle', { sessionID: 'test-session' });

      await fireEvent(hooks, 'tool.execute.before', { sessionID: 'test-session' });

      await delay(2100);

      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });
  });

  describe('session.deleted event', () => {
    it('should cleanup session state', async () => {
      const { ctx, shellMock } = createMockContext();
      const inProgressBeads = [{ id: 'bd-abc123', title: 'Test bead', status: 'in_progress' }];

      shellMock
        .mockResolvedValueOnce(mockShellResponse(0, ''))
        .mockResolvedValueOnce(mockShellResponse(0, JSON.stringify(inProgressBeads)));

      const hooks = await BeadsEnforcer(ctx as never);
      await fireEvent(hooks, 'session.idle', { sessionID: 'test-session' });

      await fireEvent(hooks, 'session.deleted', { info: { id: 'test-session' } });

      await delay(2100);

      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });
  });

  describe('epic ID extraction', () => {
    it('should extract epic ID from branch name', async () => {
      const { ctx, shellMock } = createMockContext();
      const inProgressBeads = [{ id: 'bd-abc123', title: 'Test bead', status: 'in_progress' }];

      shellMock
        .mockResolvedValueOnce(mockShellResponse(0, ''))
        .mockResolvedValueOnce(mockShellResponse(0, JSON.stringify(inProgressBeads)))
        .mockResolvedValueOnce(mockShellResponse(0, JSON.stringify(inProgressBeads)))
        .mockResolvedValueOnce(mockShellResponse(0, 'feature/bd-abc123-my-feature\n'))
        .mockResolvedValueOnce(mockShellResponse(0, '[]'));

      const hooks = await BeadsEnforcer(ctx as never);
      await fireEvent(hooks, 'session.idle', { sessionID: 'test-session' });

      await delay(2100);

      expect(ctx.client.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          body: {
            parts: [{ type: 'text', text: expect.stringContaining('bd-abc123') }],
          },
        })
      );
    });
  });
});
