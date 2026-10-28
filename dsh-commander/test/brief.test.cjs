// Deterministic test for dsh-commander: no model calls, no external fixtures.
// Builds a team state shaped exactly like @nanmicoder/dsh-agent-teams writes it
// (team.json + inbox/captain.jsonl), then invokes the registered tools' execute
// bodies directly through a fake plugin context.
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePath = join(__dirname, '..', 'lib', 'index.js');

// Field names and value shapes below mirror a real team.json produced by
// dsh-agent-teams (verified against 0.1.25, the version installed in the
// desktop profile; 0.1.27 writes the same shape) and a real captain-inbox
// record.
const teamRecord = {
  name: 'e2e-smoke',
  id: 'e2e-smoke',
  description: 'e2e smoke',
  captainSessionId: 'session-test',
  createdAt: 1793169687609,
  members: [
    {
      id: 'f8e34291-b7d7-4cd0-926c-b0c981d6470e',
      name: 'scout',
      role: 'test scout',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
      joinedAt: 1793169688389,
      status: 'running',
    },
  ],
  tasks: [
    {
      id: 't1',
      subject: 'List .md files in workspace root',
      description: 'List the .md files and report their names.',
      status: 'failed',
      assignee: 'scout',
      dependencies: [],
      attempt: 1,
      kind: 'work',
      attemptId: '9dfccd4a-3344-42a2-ab93-ae3c1bd012d4',
      output: 'BLOCKED',
    },
  ],
  taskSeq: 1,
};
const inboxRecord = {
  id: '20a8cfdd-4b80-4e3a-ab15-49f045106a80',
  from: 'scout',
  to: 'captain',
  content: 't1 FAILED (environment blocker) — no .md list produced.',
  ts: 1793169714233,
  sourceTaskId: 't1',
  sourceAttemptId: '9dfccd4a-3344-42a2-ab93-ae3c1bd012d4',
  sourceTaskStatus: 'failed',
  deliveredAt: 1793169714257,
};

(async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const workspace = mkdtempSync(join(tmpdir(), 'commander-test-'));
  const teamDir = join(workspace, '.agent-teams', 'e2e-smoke');
  mkdirSync(join(teamDir, 'inbox'), { recursive: true });
  writeFileSync(join(teamDir, 'team.json'), JSON.stringify(teamRecord, null, 2));
  writeFileSync(join(teamDir, 'inbox', 'captain.jsonl'), `${JSON.stringify(inboxRecord)}\n`);

  const registered = [];
  const routes = [];
  let section;
  const ctx = {
    systemPrompt: {
      section(value) {
        section = value;
      },
    },
    inject(services, callback) {
      if (services.includes('tools')) {
        callback({ tools: { register(definition) { registered.push(definition); } } });
        return;
      }
      if (services.includes('webServer')) {
        callback({ webServer: { register(route) { routes.push(route); return () => {}; } } });
        return;
      }
      throw new Error(`unexpected injection: ${JSON.stringify(services)}`);
    },
    get(name) {
      if (name === 'connection') return { requestRejection: () => undefined };
      return undefined;
    },
  };
  mod.apply(ctx, {
    stateDir: '.agent-teams',
    reportEvery: 2,
    requireDirection: true,
    roster: [
      { name: 'planner', role: '规划', provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      { name: 'coder', role: '实现', provider: 'deepseek-official', model: 'deepseek-flash', reasoning_effort: 'max' },
    ],
  });

  const failures = [];
  const check = (label, condition, detail) => {
    if (condition) {
      console.log('PASS', label);
    } else {
      failures.push(label);
      console.log('FAIL', label, detail ?? '');
    }
  };

  check('section registered', section?.name === 'commander:protocol' && typeof section?.text === 'string');
  check('section order after agent-teams (117)', section?.order === 118, String(section?.order));
  check('section mentions decision brief', section?.text?.includes('DECISION BRIEF'));
  check('section carries the quality-chain boundary', section?.text?.includes('Quality-chain boundary'));
  check('section requires chunked writing for implementations', section?.text?.includes('write in chunks'));
  check('section resolves disagreement via findings, not meetings', section?.text?.includes('not free-form meetings'));
  check('section makes review mandatory for delivery', section?.text?.includes('review task is mandatory'));
  check('section renders the configured roster', section?.text?.includes('deepseek-official/deepseek-v4-pro'));
  check('section warns not to silently change the roster', section?.text?.includes('do not silently change it'));
  const briefTool = registered.find((definition) => definition.name === 'commander_brief');
  const rosterTool = registered.find((definition) => definition.name === 'commander_roster');
  check('two tools registered', registered.length === 2, String(registered.length));
  check('brief tool named', briefTool?.name === 'commander_brief', briefTool?.name);
  check('roster tool named', rosterTool?.name === 'commander_roster', rosterTool?.name);
  check('brief parameter schema is object-rooted', briefTool?.parameters?.type === 'object');
  check('roster parameter schema is object-rooted', rosterTool?.parameters?.type === 'object');

  const rosterResult = await rosterTool.execute({}, {});
  check('roster tool ok', rosterResult.ok === true);
  check('roster tool reports configured', rosterResult.configured === true);
  check('roster tool count', rosterResult.count === 2, String(rosterResult.count));
  check('roster digest has pro route', rosterResult.digest.includes('deepseek-v4-pro'));
  check('roster digest has flash effort', rosterResult.digest.includes('reasoning_effort=max'));

  // Browser catalog route: same roster, served to the composer panel.
  check('catalog route registered once', routes.length === 1, String(routes.length));
  const catalog = routes[0];
  check('catalog route path', catalog?.path === '/plugins/dsh-commander/catalog', catalog?.path);
  const responses = [];
  const res = {
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      responses.push({ status: this.status, headers: this.headers, body });
    },
  };
  await catalog.handler({ method: 'GET', headers: {} }, res);
  const served = JSON.parse(responses[0].body);
  check('catalog responds 200', responses[0].status === 200, String(responses[0].status));
  check('catalog serves the configured roster', served.roster.length === 2, String(served.roster.length));
  check('catalog serves model routes', served.roster[0].model === 'deepseek-v4-pro', served.roster[0].model);
  const denied = [];
  const deniedRes = {
    writeHead(status) { this.status = status; },
    end(body) { denied.push({ status: this.status, body }); },
  };
  await catalog.handler({ method: 'POST' }, deniedRes);
  check('catalog rejects non-GET', denied[0].status === 405, String(denied[0].status));

  const exec = { agent: { session: { id: 'session-test', header: { cwd: workspace } } } };
  const first = await briefTool.execute({ note: 'first cycle' }, exec);
  check('first call ok', first.ok === true, JSON.stringify(first).slice(0, 300));
  check('members counted', first.members === 1, String(first.members));
  check('tasks counted', first.tasks === 1, String(first.tasks));
  check('one report read', first.reports === 1, String(first.reports));
  check('report is new on first brief', first.newReports === 1, String(first.newReports));
  check('digest names the member', first.digest.includes('scout'));
  check('digest shows member model route', first.digest.includes('deepseek-official/deepseek-flash'));
  check('digest shows the task', first.digest.includes('t1 [failed]'));
  check('digest includes report body', first.digest.includes('environment blocker'));
  check('digest shows report source task', first.digest.includes('task t1'));
  check('digest shows report status', first.digest.includes('status failed'));
  check('digest tells the lead to wait', first.digest.includes('wait for the human direction'));
  check(
    'brief marker written',
    JSON.parse(readFileSync(join(teamDir, 'commander-brief.json'), 'utf8')).reportFingerprints.length === 1,
  );

  const second = await briefTool.execute({ note: 'second cycle' }, exec);
  check('second call ok', second.ok === true);
  check('second brief has no new reports', second.newReports === 0, String(second.newReports));
  check('second digest says nothing new', second.digest.includes('no new reports since your previous brief'));

  // A new report arriving between briefs must show up as new again.
  writeFileSync(
    join(teamDir, 'inbox', 'captain.jsonl'),
    `${JSON.stringify(inboxRecord)}\n${JSON.stringify({ ...inboxRecord, id: 'second-report', content: 't2 DONE', sourceTaskId: 't2', sourceTaskStatus: 'completed' })}\n`,
  );
  const third = await briefTool.execute({ note: 'third cycle' }, exec);
  check('third brief sees only the new report', third.newReports === 1, String(third.newReports));
  check('third brief shows the new report', third.digest.includes('t2 DONE'));

  const noTeam = await briefTool.execute(
    {},
    { agent: { session: { id: 'other-session', header: { cwd: join(workspace, 'empty-scratch') } } } },
  );
  check('missing state root degrades cleanly', noTeam.ok === false && noTeam.digest.includes('No Team exists yet'));

  // Config coercion: malformed values must degrade, not throw.
  const coerced = mod.resolveConfig({ reportEvery: 'x', requireDirection: 'yes', roster: [null, { name: ' ok ' }, { model: 'm' }] });
  check('malformed reportEvery falls back', coerced.reportEvery === 2, String(coerced.reportEvery));
  check('roster drops nameless rows and trims names', coerced.roster.length === 1 && coerced.roster[0].name === 'ok');
  check('requireDirection only false opts out', coerced.requireDirection === true);

  rmSync(workspace, { recursive: true, force: true });
  console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\nFAILURES: ${failures.length}`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((error) => {
  console.error('TEST ERROR:', error);
  process.exit(2);
});
