/**
 * dsh-commander — a commander layer on top of AgentTeams.
 *
 * It does not reimplement teams. It rides on the `agent_teams_*` tools that
 * @nanmicoder/dsh-agent-teams registers and adds what a human supervisor needs:
 *
 * 1. A commander protocol section in the system prompt. The lead model becomes
 *    a commander: it plans, delegates to heterogeneous members, collects their
 *    periodic reports, and — at every decision point — presents a decision
 *    brief to the human and waits for the human's direction instead of
 *    silently pressing on.
 * 2. A `commander_brief` tool. The commander calls it when it wants to close a
 *    reporting cycle: it reads the team state from disk and returns a compact
 *    digest of members, tasks and the latest recorded member reports, and
 *    records that the cycle happened so the next brief knows what is new.
 *
 * Team state layout (owned by dsh-agent-teams):
 *   <workspace>/<stateDir>/<teamId>/team.json
 *   <workspace>/<stateDir>/<teamId>/inbox/captain.jsonl   (member -> captain)
 *
 * @module dsh-commander
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'commander';

/** Prompt registry is required; the tools registry is optional. */
export const inject = ['systemPrompt'];

/**
 * Coerce a configured roster entry into the durable shape used by the prompt
 * and the `commander_roster` tool.
 * @param {any} entry - one raw roster row.
 * @returns {{name: string, role: string, provider?: string, model?: string, reasoning_effort?: string, brief: string}|undefined} normalised row.
 */
function normalizeRosterEntry(entry) {
  if (entry === null || typeof entry !== 'object') return undefined;
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (name === '') return undefined;
  const text = (value) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  const row = {
    name,
    role: text(entry.role) ?? 'member',
    brief: text(entry.brief) ?? '',
  };
  const provider = text(entry.provider);
  const model = text(entry.model);
  const effort = text(entry.reasoning_effort);
  if (provider !== undefined) row.provider = provider;
  if (model !== undefined) row.model = model;
  if (effort !== undefined) row.reasoning_effort = effort;
  return row;
}

/**
 * Coerce and clamp the plugin configuration.
 *
 * Deliberately dependency-free: a schemastery schema would tie this package to
 * a peer that is only resolvable inside a profile's node_modules, and the
 * loader accepts a plain config object. Every field is optional and every
 * numeric value is clamped here, so a malformed profile line degrades to the
 * documented default instead of failing a boot.
 * @param {any} input - raw configuration from the profile patch.
 * @returns {{stateDir: string, reportEvery: number, requireDirection: boolean, maxReportChars: number, protocol: string, roster: Array<object>}} resolved config.
 */
export function resolveConfig(input) {
  const raw = input !== null && typeof input === 'object' ? input : {};
  const integer = (value, fallback, min) => {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.trunc(n));
  };
  const roster = Array.isArray(raw.roster)
    ? raw.roster.map(normalizeRosterEntry).filter((entry) => entry !== undefined)
    : [];
  return {
    stateDir:
      typeof raw.stateDir === 'string' && raw.stateDir.trim() !== ''
        ? raw.stateDir.trim()
        : '.agent-teams',
    reportEvery: integer(raw.reportEvery, 2, 1),
    requireDirection: raw.requireDirection !== false,
    maxReportChars: integer(raw.maxReportChars, 1200, 200),
    protocol: typeof raw.protocol === 'string' ? raw.protocol : '',
    roster,
  };
}

/** The section name; unique so a profile can disable it by name if needed. */
const SECTION_NAME = 'commander:protocol';

/** Route the browser half reads the roster from. */
const CATALOG_PATH = '/plugins/dsh-commander/catalog';

/**
 * Render the commander protocol.
 * @param {object} opts - resolved configuration.
 * @param {number} opts.reportEvery - reporting cadence in trigger events.
 * @param {boolean} opts.requireDirection - whether a human gate is mandatory.
 * @param {string} opts.protocol - extra operator guidance.
 * @param {Array<object>} [opts.roster] - configured model roster.
 * @returns {string} the system-prompt section text.
 */
export function commanderProtocolText({ reportEvery, requireDirection, protocol, roster = [] }) {
  const gate = requireDirection
    ? 'MANDATORY: you may not begin an execution phase until the human has explicitly chosen a direction. After the brief, end your turn and wait; do not pre-emptively start work.'
    : 'RECOMMENDED: pause for the human direction at each decision point; if the human is absent you may proceed but must state your assumption in the next brief.';
  const rosterText =
    roster.length === 0
      ? 'No model roster is configured. Ask the human which provider/model each role should use before creating members, and never guess a model id.'
      : `The human configured this model roster (the human's lever — do not silently change it):
${roster
  .map((row) => {
    const route =
      row.provider !== undefined && row.model !== undefined
        ? `${row.provider}/${row.model}`
        : row.model !== undefined
          ? row.model
          : 'inherits the commander route';
    const effort = row.reasoning_effort === undefined ? '' : `, effort ${row.reasoning_effort}`;
    return `- ${row.name} — role: ${row.role}; model: ${route}${effort}${row.brief === '' ? '' : `; ${row.brief}`}`;
  })
  .join('\n')}
Pass the row's provider/model/reasoning_effort to agent_teams_add_member (or the plan member row) so the member actually runs on that model. Call commander_roster for the machine-readable form.`;
  const text = `Commander protocol (supervised multi-model team)

This section applies whenever you drive a team with the agent_teams_* tools. It does not replace the AgentTeams captain protocol; it adds the human-supervision contract on top of it.

## Roles
- The human ("指挥官") owns goals, scope, model assignment and final calls. They supervise *you* (the lead model), not every member directly.
- You are the commander (决策者): you make the plan, assign tasks, and are the only one who talks to the human.
- Members are execution models, possibly on different LLM providers/models. They report to you, never to the human.

## Model roster
${rosterText}

## Mandatory loop
1. INTAKE — restate the goal in one line and list open questions. Ask the human rather than inventing scope.
2. PLAN — produce a staged plan: members (name, role, assigned provider/model, why that model for that role) and a task DAG with acceptance criteria. Present it for approval through the normal AgentTeams staged-plan flow; do not start work before approval.
3. DELEGATE — assign tasks; tell each member, in their assignment, exactly when and what to report ("report after finishing X, include Y, flag blockers Z").
4. SUPERVISE — collect member reports. A member report, a finished task, or a blocker each counts as one reporting trigger. After every ${reportEvery} trigger event(s), or immediately on a blocker or scope change, you MUST close a reporting cycle with DECISION BRIEF (below).
5. DECISION BRIEF — call commander_brief to read team state and obtain the digest, then present the brief to the human in this exact shape:
   - 进展：what was completed, with evidence (paths, commands, links) — not self-praise.
   - 阻塞/风险：what is blocked, what is drifting, what needs a human decision.
   - 成员状态：each member, its model, its current task and state.
   - 选项：2–4 concrete next directions, each with cost/risk/tradeoff.
   - 我的建议：your recommendation and the reason.
   - 需要你决定：the single question the human must answer to continue.
6. GATE — ${gate}
7. CLOSE — when all tasks are terminal, deliver the final result with the same discipline, then archive.

## Quality-chain boundary
Pick task kinds by risk; do not run the full chain on every task.
- High risk (live code, contracts, cross-module): requirements → implementation → verification → review → integration.
- Small or internal task: implementation → verification → review.
- Read-only audit or docs consistency: one work task → review.
- A review task is mandatory, not optional: an implementation is not deliverable until a review of it reports verdict=pass. Never plan a chain that omits review, and add one before closing the team — delivery stays blocked without it.
- Every implementation assignment must say to write in chunks: read only the spec section you need, land one file, then continue. A member that reads everything and emits everything at once runs out of context.
- Verification and review tasks may write evidence under a dedicated directory (e.g. t3-verify/); name that directory in the task so it is allowed, and forbid edits to implementation files.

## Rules
- Never fabricate member reports. If a member has not reported, say "no report yet" and consider asking it.
- Never open a new direction to the human without a concrete recommendation.
- Members must not be asked to "just continue"; give them a task, a definition of done and a reporting instruction.
- Resolve disagreement through findings and reports, not free-form meetings: a member that disagrees records a finding or reports it, and the commander adjudicates.
- Model assignment is the human's lever: if a member's model struggles on its task, propose a re-assignment in the brief instead of quietly retrying.
- The human may also send you mid-run supervision ("第 2 组先停下", "换个模型试试"); treat it as a direction, fold it into the plan, and confirm in the next brief.
- Keep briefs short. One screen. The human decides, not you.
${protocol === '' ? '' : `\n## Operator notes\n${protocol}\n`}`;
  return text;
}

/**
 * Resolve a calling agent's workspace root.
 * @param {any} exec - the tool execution context.
 * @returns {string} absolute workspace path.
 */
function workspaceOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
}

/**
 * Read and parse one JSON file, returning undefined on any problem.
 * @param {string} file - absolute path.
 * @returns {Promise<any>} parsed value or undefined.
 */
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Locate this captain's team directory.
 *
 * The lead's team id is derived by scanning the state root for a `team.json`
 * whose captain session id matches the calling agent's session. Reading the
 * directory is cheap and avoids depending on plugin internals.
 * @param {string} stateRoot - `<workspace>/<stateDir>`.
 * @param {string} sessionId - calling agent's session id.
 * @returns {Promise<{teamId: string, team: any, dir: string} | undefined>} match.
 */
async function findTeamOf(stateRoot, sessionId) {
  let entries;
  try {
    entries = await readdir(stateRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let fallback;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(stateRoot, entry.name);
    const team = await readJson(join(dir, 'team.json'));
    if (team === undefined) continue;
    const captainId = team?.captainSessionId ?? team?.captain?.sessionId ?? team?.captain;
    if (typeof captainId === 'string' && captainId === sessionId) {
      return { teamId: entry.name, team, dir };
    }
    if (fallback === undefined) fallback = { teamId: entry.name, team, dir };
  }
  return fallback;
}

/**
 * Normalise the heterogeneous shapes a team record may use for members/tasks.
 * @param {any} team - parsed team.json.
 * @returns {{members: any[], tasks: any[]}} arrays, possibly empty.
 */
function collectionsOf(team) {
  const members = Array.isArray(team?.members)
    ? team.members
    : Array.isArray(team?.roster)
      ? team.roster
      : [];
  const tasks = Array.isArray(team?.tasks)
    ? team.tasks
    : Array.isArray(team?.taskBoard?.tasks)
      ? team.taskBoard.tasks
      : [];
  return { members, tasks };
}

/**
 * Read the last N JSONL records of the captain inbox.
 * @param {string} file - absolute path of captain.jsonl.
 * @param {number} limit - maximum records to return.
 * @returns {Promise<any[]>} parsed records, oldest first.
 */
async function readCaptainInbox(file, limit) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // A torn final line is normal after a crash; ignore it.
    }
  }
  return records.slice(-limit);
}

/**
 * Trim one inbox record for the digest.
 *
 * Real captain-inbox records (dsh-agent-teams) look like:
 *   {"id":"…","from":"scout","to":"captain","content":"…","ts":1793169714233,
 *    "sourceTaskId":"t1","sourceAttemptId":"…","sourceTaskStatus":"failed",…}
 * Earlier/alternative shapes (`text`, `message`, content blocks, `at`/`time`)
 * are still accepted so a format change degrades instead of dropping a report.
 * @param {any} record - one inbox record.
 * @param {number} maxChars - maximum characters kept per report.
 * @returns {{id?: string, from: string, text: string, at?: string, task?: string, status?: string}} compact report.
 */
function compactReport(record, maxChars) {
  const from = record?.from ?? record?.sender ?? record?.source?.name ?? 'unknown';
  const rawText =
    typeof record?.content === 'string'
      ? record.content
      : typeof record?.text === 'string'
        ? record.text
        : typeof record?.message === 'string'
          ? record.message
          : Array.isArray(record?.content)
            ? record.content
                .filter((block) => block?.type === 'text' && typeof block.text === 'string')
                .map((block) => block.text)
                .join('\n')
            : JSON.stringify(record?.payload ?? record ?? {});
  const text = String(rawText);
  const stamp = record?.ts ?? record?.at ?? record?.time ?? record?.createdAt;
  const at =
    typeof stamp === 'number' && Number.isFinite(stamp)
      ? new Date(stamp).toISOString()
      : typeof stamp === 'string'
        ? stamp
        : undefined;
  return {
    id: typeof record?.id === 'string' ? record.id : undefined,
    from: String(from),
    text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text,
    at,
    task: typeof record?.sourceTaskId === 'string' ? record.sourceTaskId : undefined,
    status: typeof record?.sourceTaskStatus === 'string' ? record.sourceTaskStatus : undefined,
  };
}

/**
 * Register the commander section and, when possible, the brief tool.
 * @param {any} ctx - the plugin context.
 * @param {any} config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);

  ctx.systemPrompt.section({
    name: SECTION_NAME,
    // 118 sits just after AgentTeams' captain usage section (default 117):
    // the captain protocol establishes the tools, this section adds the human
    // supervision contract, so it must render after it.
    order: 118,
    text: commanderProtocolText(resolved),
  });

  // The tools registry ships in every standard profile, but a minimal
  // composition may omit it; inject lazily so this plugin never blocks boot.
  ctx.inject(['tools'], (toolCtx) => {
    // Read-only view of the human's model roster, so the lead never has to
    // guess a provider/model id (a wrong id fails member creation).
    toolCtx.tools.register({
      name: 'commander_roster',
      description:
        "Return the human's configured model roster for this commander team: the member names, roles and provider/model routes the human assigned. Use these exact routes when creating members so each role actually runs on the intended model. Read-only.",
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [
          { type: 'text', text: typeof value?.digest === 'string' ? value.digest : JSON.stringify(value) },
        ],
      },
      async execute() {
        const configured = resolved.roster.length > 0;
        const digest = configured
          ? [
              'Configured model roster (authoritative; do not substitute other models without telling the human):',
              ...resolved.roster.map((row) => {
                const route =
                  row.provider !== undefined && row.model !== undefined
                    ? `${row.provider}/${row.model}`
                    : row.model !== undefined
                      ? row.model
                      : 'inherits the commander route';
                const effort = row.reasoning_effort === undefined ? '' : `, reasoning_effort=${row.reasoning_effort}`;
                return `- ${row.name} | role=${row.role} | model=${route}${effort}${row.brief === '' ? '' : ` | ${row.brief}`}`;
              }),
              '',
              'Pass provider/model/reasoning_effort verbatim to agent_teams_add_member (or the plan member row).',
            ].join('\n')
          : 'No model roster is configured. Ask the human which provider/model each role should use before creating members; never guess a model id.';
        return { ok: true, configured, count: resolved.roster.length, roster: resolved.roster, digest };
      },
    });
    toolCtx.tools.register({
      name: 'commander_brief',
      description:
        'Close one commander reporting cycle. Reads the current Team state from disk and returns a digest of members, tasks, and the latest member reports delivered to you, plus the set of reports that are new since your previous brief. Call this before presenting a decision brief to the human. Read-only with respect to team state; it only records the brief marker.',
      // The registry forwards `parameters` to the provider verbatim, so this is
      // a complete object-rooted JSON Schema — not the author-facing property
      // DSL that `defineTool` compiles (that helper is not importable here).
      parameters: {
        type: 'object',
        properties: {
          note: {
            type: 'string',
            description: 'One-line summary of the cycle this brief closes.',
          },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [
          { type: 'text', text: typeof value?.digest === 'string' ? value.digest : JSON.stringify(value) },
        ],
      },
      async execute(args, exec) {
        const workspace = workspaceOf(exec);
        const stateRoot = join(workspace, resolved.stateDir);
        const sessionId = exec?.agent?.session?.id ?? exec?.agent?.sessionId ?? '';
        const found = await findTeamOf(stateRoot, sessionId);
        if (found === undefined) {
          return {
            ok: false,
            error: 'no team found under the workspace state directory',
            stateRoot,
            digest:
              'No Team exists yet. Create the team with the agent_teams_* tools before taking a commander brief.',
          };
        }
        const { members, tasks } = collectionsOf(found.team);
        const inbox = await readCaptainInbox(join(found.dir, 'inbox', 'captain.jsonl'), 20);
        const reports = inbox.map((record) => compactReport(record, resolved.maxReportChars));

        const markerPath = join(found.dir, 'commander-brief.json');
        const previous = await readJson(markerPath);
        const seenBefore = new Set(
          Array.isArray(previous?.reportFingerprints) ? previous.reportFingerprints : [],
        );
        // Report identity is the durable mailbox id when present, so a second
        // brief only shows what arrived after the first one.
        const fingerprints = reports.map((report) => report.id ?? `${report.at ?? ''}|${report.from}|${report.text.length}`);
        const newReports = reports.filter((_report, index) => !seenBefore.has(fingerprints[index]));

        const memberLines = members.map((member) => {
          const memberName = member?.name ?? member?.id ?? '?';
          const role = member?.role ?? 'member';
          const state = member?.state ?? member?.status ?? member?.phase ?? 'unknown';
          const model = member?.model?.model ?? member?.model?.id ?? member?.model ?? 'inherited';
          const provider = member?.model?.provider ?? member?.provider ?? '';
          const route = provider === '' ? String(model) : `${provider}/${model}`;
          return `- ${memberName} [${role}] ${state} — ${route}`;
        });
        const taskLines = tasks.map((task) => {
          const id = task?.id ?? '?';
          const subject = task?.subject ?? task?.title ?? '(untitled)';
          const status = task?.status ?? 'unknown';
          const owner = task?.ownerName ?? task?.assignee ?? task?.owner ?? '-';
          const attempt = task?.attemptId ?? task?.attempt_id;
          return `- ${id} [${status}] ${subject} — owner: ${owner}${attempt ? ` — attempt: ${attempt}` : ''}`;
        });

        const digest = [
          `Team: ${found.team?.name ?? found.teamId} (${found.teamId})`,
          `Brief note: ${typeof args?.note === 'string' ? args.note : '(none)'}`,
          '',
          `Members (${members.length}):`,
          ...(memberLines.length > 0 ? memberLines : ['- (none)']),
          '',
          `Tasks (${tasks.length}):`,
          ...(taskLines.length > 0 ? taskLines : ['- (none)']),
          '',
          `Member reports delivered to you (${reports.length} total, ${newReports.length} new):`,
          ...(newReports.length > 0
            ? newReports.map((report) => {
                const meta = [
                  `from ${report.from}`,
                  report.at ? `at ${report.at}` : '',
                  report.task ? `task ${report.task}` : '',
                  report.status ? `status ${report.status}` : '',
                ]
                  .filter(Boolean)
                  .join(', ');
                return `--- ${meta}\n${report.text}`;
              })
            : ['- (no new reports since your previous brief)']),
          '',
          'Present a decision brief to the human now: 进展 / 阻塞与风险 / 成员状态 / 选项 / 我的建议 / 需要你决定。Then end your turn and wait for the human direction.',
        ].join('\n');

        await mkdir(found.dir, { recursive: true });
        await writeFile(
          markerPath,
          `${JSON.stringify({ at: new Date().toISOString(), note: args?.note ?? null, reportFingerprints: fingerprints }, null, 2)}\n`,
          'utf8',
        );

        return {
          ok: true,
          teamId: found.teamId,
          members: members.length,
          tasks: tasks.length,
          reports: reports.length,
          newReports: newReports.length,
          digest,
        };
      },
    });
  });

  // The browser half's composer panel reads its roster from here, so the panel
  // and `commander_roster` cannot drift apart. Headless profiles never bind a
  // web server, so this injection simply never runs there.
  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx?.webServer;
    if (server === undefined || typeof server.register !== 'function') return;
    server.register({
      kind: 'exact',
      path: CATALOG_PATH,
      handler: async (req, res) => {
        if (req?.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ error: 'method not allowed' }));
          return;
        }
        // Raw web-server routes do not inherit the connection's auth fence;
        // apply the same request-rejection check the shipped route owners use.
        const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
        const rejection =
          connection === undefined
            ? 503
            : typeof connection.requestRejection === 'function'
              ? connection.requestRejection(req)
              : undefined;
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ error: rejection === 503 ? 'authentication unavailable' : 'unauthorized' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(
          JSON.stringify({
            roster: resolved.roster,
            reportEvery: resolved.reportEvery,
            requireDirection: resolved.requireDirection,
          }),
        );
      },
    });
  });
}
