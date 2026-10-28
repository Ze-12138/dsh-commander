/**
 * dsh-commander — browser half.
 *
 * Adds a "编队" (team) control above the composer card
 * (`conversation.input.dock`). It does not create teams: it composes a
 * well-formed instruction — goal, per-member role, duty and model — and inserts
 * it into the draft, so the AgentTeams plan-approval flow still governs whether
 * a team starts.
 *
 * Talking to the decision-maker is the normal composer: the lead model is the
 * decision-maker. Talking to one member uses the AgentTeams panel's member
 * sessions; this control does not need a second chat surface.
 *
 * Bundle format: window.__ModuleLoader__.load({ id, factory(require) })
 */
window.__ModuleLoader__.load({
  id: 'dsh-commander',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var h = React.createElement;

    var STORAGE_KEY = 'dsh-commander.composer.v2';
    var CATALOG_URL = '/plugins/dsh-commander/catalog';
    var CUSTOM = '__custom__';

    var ROLE_PRESETS = ['编码实现', '建模分析', '论文写作', '方案设计', '审查复核', '资料检索', '自定义'];
    var MODEL_PRESETS = [
      { provider: 'deepseek-official', model: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
      { provider: 'deepseek-official', model: 'deepseek-flash', label: 'deepseek-flash' }
    ];

    function routeKey(provider, model) {
      if (!model) return '';
      return (provider ? provider + '/' : '') + model;
    }

    function makeMember(overrides) {
      var base = { role: '编码实现', customRole: '', duty: '', provider: 'deepseek-official', model: 'deepseek-flash', custom: false };
      if (overrides) {
        for (var key in overrides) base[key] = overrides[key];
      }
      return base;
    }

    function defaultState() {
      // No canned roster: two blank members are only a starting point. The
      // human names each role and duty for the task at hand.
      return {
        useTeam: true,
        goal: '',
        askOnly: false,
        members: [
          makeMember({ role: '自定义', customRole: '', duty: '' }),
          makeMember({ role: '自定义', customRole: '', duty: '' })
        ],
        chain: 'three',
        reportEvery: 2
      };
    }

    /**
     * Restore the last configuration, falling back to defaults when storage is
     * missing, unreadable, or holds a shape this version no longer understands.
     * @returns {object} composer state.
     */
    function loadState() {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return defaultState();
        var raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return defaultState();
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.members) || parsed.members.length === 0) {
          return defaultState();
        }
        return {
          useTeam: parsed.useTeam !== false,
          goal: typeof parsed.goal === 'string' ? parsed.goal : '',
          askOnly: parsed.askOnly === true,
          chain: parsed.chain === 'plain' || parsed.chain === 'full' ? parsed.chain : 'three',
          reportEvery: [1, 2, 3].indexOf(parsed.reportEvery) >= 0 ? parsed.reportEvery : 2,
          members: parsed.members.slice(0, 8).map(function (member) {
            return makeMember({
              role: typeof member.role === 'string' && member.role !== '' ? member.role : '编码实现',
              customRole: typeof member.customRole === 'string' ? member.customRole : '',
              duty: typeof member.duty === 'string' ? member.duty : '',
              provider: typeof member.provider === 'string' ? member.provider : '',
              model: typeof member.model === 'string' ? member.model : '',
              custom: member.custom === true
            });
          })
        };
      } catch (error) {
        return defaultState();
      }
    }

    function saveState(state) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return;
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (error) {
        // Storage quota or privacy mode: remembering is best-effort.
      }
    }

    function roleOf(member) {
      if (member.role === '自定义') {
        return member.customRole && member.customRole.trim() !== '' ? member.customRole.trim() : '自定义角色';
      }
      return member.role;
    }

    function routeLabel(member) {
      if (!member.model) return '继承队长模型';
      return routeKey(member.provider, member.model);
    }

    function instructionText(state) {
      if (!state.useTeam) return '这个任务不用团队，你直接做。';
      var lines = [];
      if (state.goal && state.goal.trim() !== '') {
        lines.push('任务目标：' + state.goal.trim(), '');
      }
      lines.push('用 Agent Teams 完成上面的目标，编队配置如下：');
      lines.push('成员数：' + state.members.length);
      lines.push('每名成员的职责与模型：');
      state.members.forEach(function (member, index) {
        var duty = member.duty && member.duty.trim() !== '' ? '（' + member.duty.trim() + '）' : '';
        lines.push('  ' + (index + 1) + '. ' + roleOf(member) + duty + ' → ' + routeLabel(member));
      });
      var chain =
        state.chain === 'full'
          ? '五段质量链（requirements → implementation → verification → review → integration）'
          : state.chain === 'three'
            ? '三段（implementation → verification → review）'
            : '普通任务（work）';
      lines.push('质量链：' + chain);
      lines.push(
        '汇报与交付：每名成员完成后向你汇报「做了什么、产出在哪、卡在哪」；你收齐后汇总成一份交付给我，并说明每个人的贡献。'
      );
      lines.push(
        '汇报节奏：每 ' + state.reportEvery + ' 个触发事件（成员汇报/任务完成/阻塞）给我一次决策简报，以「需要你决定：」结尾，等我定方向再继续。'
      );
      lines.push(
        state.askOnly
          ? '这次只讨论、不要开工：先给方案、分工和待确认问题，等我确认后再执行。'
          : '先出计划（成员名单 + 任务 DAG + 验收标准）给我审批，不要直接开工。'
      );
      return lines.join('\n');
    }

    var DECIDE_TEXT = [
      '先判断这件事值不值得开团队，再决定怎么做：',
      '判断标准：①能否拆成 2 个以上有明确交付物的子任务；②是否需要独立验收；③出错代价大不大。三条中两条为「是」才用团队。',
      '- 不值得：直接做，并用一句话说明为什么不用团队。',
      '- 值得：按名册给出 2–3 名成员的编队方案（角色 + provider/model + 为什么用这个模型）与任务 DAG，暂存计划等我审批。',
      '不要未经我确认就开工。'
    ].join('\n');

    /**
     * Locate the composer's editable element.
     * @returns {Element|null} the editor or null.
     */
    function findComposer() {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
      return (
        document.querySelector('[data-composer-input][contenteditable="true"]') ||
        document.querySelector('[data-composer-card] [contenteditable="true"][role="textbox"]') ||
        document.querySelector('[data-composer-card] textarea')
      );
    }

    /**
     * Insert text into the composer draft.
     * @param {any} inputActions - the composer's standard actions, when present.
     * @param {string} text - text to append.
     * @returns {boolean} whether an insertion happened.
     */
    function insertIntoDraft(inputActions, text) {
      try {
        if (inputActions && typeof inputActions.insertText === 'function') {
          var span = typeof inputActions.captureInsertion === 'function' ? inputActions.captureInsertion() : undefined;
          inputActions.insertText(text, span);
          return true;
        }
      } catch (error) {
        // fall through to the DOM path
      }
      var target = findComposer();
      if (!target) return false;
      target.focus();
      try {
        if (document.execCommand('insertText', false, text)) return true;
      } catch (error) {
        // fall through
      }
      return false;
    }

    /**
     * Ask the host composer to submit the draft, when it exposes that action.
     * @param {any} inputActions - the composer's standard actions.
     * @returns {boolean} whether a submit was requested.
     */
    function submitDraft(inputActions) {
      try {
        if (inputActions && typeof inputActions.submit === 'function') {
          inputActions.submit();
          return true;
        }
        if (inputActions && typeof inputActions.send === 'function') {
          inputActions.send();
          return true;
        }
      } catch (error) {
        // fall through
      }
      return false;
    }

    function styleButton(active) {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
        height: '26px',
        minWidth: '58px',
        padding: '0 10px',
        borderRadius: '8px',
        border: '1px solid ' + (active ? 'var(--dsh-accent, #4b6bfb)' : 'var(--dsh-border, rgba(0,0,0,0.15))'),
        background: active ? 'var(--dsh-accent-soft, rgba(75,107,251,0.12))' : 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '1',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        flexShrink: 0
      };
    }

    function fieldStyle() {
      return { display: 'flex', alignItems: 'center', gap: '6px', margin: '4px 0', fontSize: '12px' };
    }

    function inputStyle() {
      return {
        flex: '1 1 auto',
        minWidth: '0',
        height: '26px',
        padding: '0 6px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, rgba(0,0,0,0.15))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px'
      };
    }

    function areaStyle() {
      return {
        flex: '1 1 auto',
        minWidth: '0',
        minHeight: '44px',
        padding: '6px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, rgba(0,0,0,0.15))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        resize: 'vertical'
      };
    }

    function TeamControl(props) {
      var locked = props.locked === true;
      var onActiveChange = props.onActiveChange;
      var inputActions = props.inputActions;

      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];

      var teamState = React.useState(loadState);
      var state = teamState[0];
      var setState = teamState[1];

      var rosterState = React.useState([]);
      var rosterModels = rosterState[0];
      var setRosterModels = rosterState[1];

      var anchorRef = React.useRef(null);
      var anchorState = React.useState(null);
      var anchor = anchorState[0];
      var setAnchor = anchorState[1];

      var hintState = React.useState('');
      var hint = hintState[0];
      var setHint = hintState[1];

      React.useEffect(
        function () {
          if (typeof onActiveChange === 'function') onActiveChange(open);
          return function () {
            if (typeof onActiveChange === 'function') onActiveChange(false);
          };
        },
        [open]
      );

      // One mount-time read of the host roster; the panel keeps working from
      // defaults when the route is missing (headless assembly, older host).
      React.useEffect(
        function () {
          var alive = true;
          if (typeof fetch !== 'function') return function () {};
          fetch(CATALOG_URL, { credentials: 'include' })
            .then(function (response) {
              return response && response.ok ? response.json() : null;
            })
            .then(function (data) {
              if (!alive || !data || !Array.isArray(data.roster) || data.roster.length === 0) return;
              setRosterModels(
                data.roster.map(function (row) {
                  return {
                    provider: row.provider || '',
                    model: row.model || '',
                    label: routeKey(row.provider, row.model) || '继承队长模型'
                  };
                })
              );
            })
            .catch(function () {
              // Optional enhancement only.
            });
          return function () {
            alive = false;
          };
        },
        []
      );

      React.useEffect(
        function () {
          saveState(state);
        },
        [state]
      );

      function measureAnchor() {
        var element = anchorRef.current;
        if (!element || typeof element.getBoundingClientRect !== 'function') return;
        var rect = element.getBoundingClientRect();
        setAnchor({ left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width });
      }

      React.useEffect(
        function () {
          if (!open || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
            return function () {};
          }
          function onViewportChange() {
            measureAnchor();
          }
          window.addEventListener('resize', onViewportChange);
          window.addEventListener('scroll', onViewportChange, true);
          return function () {
            window.removeEventListener('resize', onViewportChange, true);
            window.removeEventListener('scroll', onViewportChange, true);
          };
        },
        [open]
      );

      function update(patch) {
        setState(function (previous) {
          var next = {};
          for (var key in previous) next[key] = previous[key];
          for (var patchKey in patch) next[patchKey] = patch[patchKey];
          return next;
        });
      }

      function updateMember(index, patch) {
        var members = state.members.map(function (member, i) {
          if (i !== index) return member;
          var next = {};
          for (var key in member) next[key] = member[key];
          for (var patchKey in patch) next[patchKey] = patch[patchKey];
          return next;
        });
        update({ members: members });
      }

      function addMember() {
        if (state.members.length >= 8) return;
        var template = state.members[state.members.length - 1] || makeMember();
        update({
          members: state.members.concat([
            makeMember({ role: '自定义', customRole: '', duty: '', provider: template.provider, model: template.model })
          ])
        });
      }

      function removeMember(index) {
        if (state.members.length <= 1) return;
        update({
          members: state.members.filter(function (_member, i) {
            return i !== index;
          })
        });
      }

      function modelOptions() {
        var seen = {};
        var options = [];
        function push(provider, model) {
          var key = routeKey(provider, model);
          if (key === '' || seen[key]) return;
          seen[key] = true;
          options.push({ key: key, label: key });
        }
        rosterModels.forEach(function (row) {
          push(row.provider, row.model);
        });
        MODEL_PRESETS.forEach(function (row) {
          push(row.provider, row.model);
        });
        state.members.forEach(function (member) {
          if (!member.custom) push(member.provider, member.model);
        });
        return options;
      }

      function emit(text, alsoSend) {
        var inserted = insertIntoDraft(inputActions, text);
        setOpen(false);
        if (!inserted) {
          setHint('无法插入到输入框，请手动复制。');
          return;
        }
        if (alsoSend && !submitDraft(inputActions)) {
          setHint('已插入草稿；发送键未暴露，请按 Enter 发送。');
          return;
        }
        setHint('');
      }

      var options = modelOptions();
      var preview = instructionText(state);

      var rows = state.members.map(function (member, index) {
        var roleSelect = h(
          'select',
          {
            value: member.role,
            style: inputStyle(),
            'aria-label': '成员 ' + (index + 1) + ' 的角色',
            onChange: function (event) {
              updateMember(index, { role: event.target.value });
            }
          },
          ROLE_PRESETS.map(function (role) {
            return h('option', { key: role, value: role }, role);
          })
        );
        var customRoleInput =
          member.role === '自定义'
            ? h('input', {
                type: 'text',
                placeholder: '自定义角色名，例如 数据清洗',
                value: member.customRole,
                style: inputStyle(),
                onChange: function (event) {
                  updateMember(index, { customRole: event.target.value });
                }
              })
            : null;
        var currentKey = member.custom ? CUSTOM : routeKey(member.provider, member.model);
        var modelSelect = h(
          'select',
          {
            value: currentKey,
            style: inputStyle(),
            'aria-label': '成员 ' + (index + 1) + ' 的模型',
            onChange: function (event) {
              var value = event.target.value;
              if (value === CUSTOM) {
                updateMember(index, { custom: true });
                return;
              }
              if (value === '') {
                updateMember(index, { provider: '', model: '', custom: false });
                return;
              }
              var parts = value.split('/');
              updateMember(index, {
                provider: parts.length > 1 ? parts[0] : '',
                model: parts.length > 1 ? parts[1] : parts[0],
                custom: false
              });
            }
          },
          options.map(function (option) {
            return h('option', { key: option.key, value: option.key }, option.label);
          }),
          h('option', { key: '', value: '' }, '继承队长模型'),
          h('option', { key: CUSTOM, value: CUSTOM }, '自定义…')
        );
        var customModelInput = member.custom
          ? h('input', {
              type: 'text',
              placeholder: 'provider/model，例如 volcark/doubao-…',
              value: routeKey(member.provider, member.model),
              style: inputStyle(),
              onChange: function (event) {
                var value = event.target.value.trim();
                var slash = value.indexOf('/');
                updateMember(index, {
                  provider: slash > 0 ? value.slice(0, slash) : '',
                  model: slash > 0 ? value.slice(slash + 1) : value
                });
              }
            })
          : null;
        var dutyInput = h('input', {
          type: 'text',
          placeholder: '这个 agent 具体干什么，例如：写论文初稿，引用建模结论',
          value: member.duty,
          style: inputStyle(),
          onChange: function (event) {
            updateMember(index, { duty: event.target.value });
          }
        });
        return h(
          'div',
          { key: index, style: { margin: '8px 0 0' } },
          h(
            'div',
            { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
            h('span', { style: { width: '16px', opacity: 0.55, fontSize: '11px' } }, String(index + 1)),
            roleSelect,
            modelSelect,
            h(
              'button',
              {
                type: 'button',
                title: '删除该成员',
                style: { height: '26px', padding: '0 6px', borderRadius: '6px', border: '1px solid transparent', background: 'transparent', color: 'inherit', cursor: 'pointer', flexShrink: 0 },
                onClick: function () {
                  removeMember(index);
                }
              },
              '×'
            )
          ),
          h('div', { style: { margin: '4px 0 0 22px' } }, dutyInput),
          customRoleInput ? h('div', { style: { margin: '4px 0 0 22px' } }, customRoleInput) : null,
          customModelInput ? h('div', { style: { margin: '4px 0 0 22px' } }, customModelInput) : null
        );
      });

      var panelStyle = (function () {
        var width = 400;
        var viewportWidth = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1280;
        var viewportHeight = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800;
        var left = 12;
        if (anchor) left = Math.max(12, Math.min(anchor.left + anchor.width - width, viewportWidth - width - 12));
        // Prefer opening upward: the composer sits below the trigger, so a
        // downward panel would cover it.
        var spaceAbove = anchor ? anchor.top - 12 : 0;
        var openUp = anchor ? spaceAbove >= 240 : false;
        var base = {
          position: 'fixed',
          left: left + 'px',
          width: width + 'px',
          overflowY: 'auto',
          padding: '10px 12px',
          borderRadius: '10px',
          border: '1px solid var(--dsh-border, rgba(0,0,0,0.15))',
          background: 'var(--dsh-bg-elevated, #ffffff)',
          color: 'inherit',
          boxShadow: '0 8px 24px rgba(0,0,0,0.24)',
          zIndex: 2147483000
        };
        if (openUp) {
          base.bottom = viewportHeight - anchor.top + 6 + 'px';
          base.maxHeight = Math.max(200, Math.min(560, spaceAbove - 6)) + 'px';
        } else {
          var top = anchor ? Math.min(anchor.bottom + 6, viewportHeight - 140) : 96;
          base.top = top + 'px';
          base.maxHeight = Math.max(200, Math.min(560, viewportHeight - top - 24)) + 'px';
        }
        return base;
      })();

      var panel = h(
        'div',
        {
          role: 'dialog',
          'aria-label': '编队',
          style: panelStyle,
          onKeyDown: function (event) {
            if (event.key === 'Escape') setOpen(false);
          }
        },
        h('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '6px' } }, '编队（团队启动器）'),
        h(
          'div',
          { style: fieldStyle() },
          h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
            h('input', {
              type: 'radio',
              checked: state.useTeam === true,
              onChange: function () {
                update({ useTeam: true });
              }
            }),
            '用团队'
          ),
          h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '10px' } },
            h('input', {
              type: 'radio',
              checked: state.useTeam === false,
              onChange: function () {
                update({ useTeam: false });
              }
            }),
            '不用团队'
          )
        ),
        state.useTeam
          ? h(
              'div',
              null,
              h('div', { style: { fontSize: '11px', opacity: 0.65, margin: '8px 0 2px' } }, '本次任务目标（会写进指令）'),
              h('textarea', {
                value: state.goal,
                placeholder: '例：用三人分工完成一篇实验结果部分：代码复现、建模分析、论文写作',
                style: areaStyle(),
                onChange: function (event) {
                  update({ goal: event.target.value });
                }
              }),
              h('div', { style: { fontSize: '11px', opacity: 0.65, margin: '10px 0 2px' } }, '成员（角色 / 模型 / 这个 agent 干什么）'),
              rows,
              h(
                'button',
                {
                  type: 'button',
                  style: { margin: '6px 0 8px', height: '26px', padding: '0 8px', borderRadius: '6px', border: '1px dashed var(--dsh-border, rgba(0,0,0,0.2))', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px' },
                  onClick: addMember
                },
                '+ 加一个成员'
              ),
              h(
                'div',
                { style: fieldStyle() },
                h('span', { style: { width: '64px', opacity: 0.7 } }, '质量链'),
                h(
                  'select',
                  {
                    value: state.chain,
                    style: inputStyle(),
                    onChange: function (event) {
                      update({ chain: event.target.value });
                    }
                  },
                  h('option', { value: 'plain' }, '普通任务（1 段）'),
                  h('option', { value: 'three' }, '三段：实现→检验→复核'),
                  h('option', { value: 'full' }, '五段：规格→实现→检验→复核→集成')
                )
              ),
              h(
                'div',
                { style: fieldStyle() },
                h('span', { style: { width: '64px', opacity: 0.7 } }, '汇报节奏'),
                h(
                  'select',
                  {
                    value: String(state.reportEvery),
                    style: inputStyle(),
                    onChange: function (event) {
                      update({ reportEvery: Number(event.target.value) });
                    }
                  },
                  h('option', { value: '1' }, '每个触发事件都汇报'),
                  h('option', { value: '2' }, '每 2 个触发事件汇报'),
                  h('option', { value: '3' }, '每 3 个触发事件汇报')
                )
              ),
              h(
                'label',
                { style: { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', margin: '6px 0' } },
                h('input', {
                  type: 'checkbox',
                  checked: state.askOnly === true,
                  onChange: function (event) {
                    update({ askOnly: event.target.checked });
                  }
                }),
                '只讨论，先不开工（先给我方案和问题）'
              ),
              h('div', { style: { fontSize: '11px', opacity: 0.65, margin: '8px 0 2px' } }, '将插入的指令（可先改）'),
              h(
                'pre',
                {
                  style: {
                    margin: 0,
                    padding: '6px 8px',
                    maxHeight: '120px',
                    overflow: 'auto',
                    borderRadius: '6px',
                    border: '1px solid var(--dsh-border, rgba(0,0,0,0.12))',
                    background: 'rgba(127,127,127,0.06)',
                    fontSize: '11px',
                    lineHeight: 1.5,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word'
                  }
                },
                preview
              )
            )
          : null,
        hint === '' ? null : h('div', { style: { fontSize: '11px', color: '#c2410c', marginTop: '6px' } }, hint),
        h(
          'div',
          { style: { display: 'flex', gap: '6px', marginTop: '10px' } },
          h(
            'button',
            {
              type: 'button',
              style: { flex: '1 1 auto', height: '28px', borderRadius: '8px', border: '1px solid transparent', background: 'var(--dsh-accent, #4b6bfb)', color: '#fff', cursor: 'pointer', fontSize: '12px' },
              onClick: function () {
                emit(preview, false);
              }
            },
            '插入指令'
          ),
          h(
            'button',
            {
              type: 'button',
              style: { flex: '1 1 auto', height: '28px', borderRadius: '8px', border: '1px solid var(--dsh-border, rgba(0,0,0,0.2))', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px' },
              onClick: function () {
                emit(preview, true);
              }
            },
            '插入并发送'
          ),
          h(
            'button',
            {
              type: 'button',
              title: '让 AI 判断该不该开团队、怎么开',
              style: { flex: '0 0 auto', height: '28px', padding: '0 8px', borderRadius: '8px', border: '1px solid var(--dsh-border, rgba(0,0,0,0.2))', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px' },
              onClick: function () {
                emit(DECIDE_TEXT, false);
              }
            },
            '一键决定'
          )
        )
      );

      return h(
        'div',
        { style: { position: 'relative', display: 'flex', justifyContent: 'flex-end', padding: '2px 4px', width: '100%', boxSizing: 'border-box' } },
        h(
          'button',
          {
            ref: anchorRef,
            type: 'button',
            title: '编队：设置团队目标、成员职责与模型',
            'aria-label': '编队',
            disabled: locked,
            style: styleButton(open),
            onClick: function () {
              measureAnchor();
              setOpen(!open);
            }
          },
          '编队'
        ),
        open ? panel : null
      );
    }

    function apply(ctx) {
      ctx.slots.inject('conversation.input.dock', function () {
        try {
          return ctx.slots.register(
            { name: 'conversation.input.dock', id: 'commander-launcher', order: 0 },
            TeamControl
          );
        } catch (error) {
          console.error('[dsh-commander] failed to register the composer control', error);
          return undefined;
        }
      });
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    // Pure helpers exposed for the stub test; the runtime only calls apply().
    exports.__test = {
      instructionText: instructionText,
      defaultState: defaultState,
      loadState: loadState,
      roleOf: roleOf
    };
    return module.exports;
  }
});
