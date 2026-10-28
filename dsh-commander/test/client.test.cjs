// Loads the browser bundle under a stub module loader and asserts that it
// registers the composer control and renders the expected button label.
// No browser and no model calls: this catches syntax/registration regressions
// before a page refresh exposes them to the user.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const clientPath = join(__dirname, '..', 'lib', 'client.js');
const source = readFileSync(clientPath, 'utf8');

const failures = [];
const check = (label, condition, detail) => {
  if (condition) {
    console.log('PASS', label);
  } else {
    failures.push(label);
    console.log('FAIL', label, detail ?? '');
  }
};

// Minimal React surface used by the bundle.
let elementCount = 0;
const React = {
  createElement(type, props, ...children) {
    elementCount += 1;
    return { type, props: { ...props, children: children.length === 1 ? children[0] : children } };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useRef(initial) {
    return { current: initial ?? null };
  },
  useEffect() {
    // Effects are not evaluated here; the render path must not depend on them.
  }
};

const loaded = [];
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(entry) {
        loaded.push(entry);
      }
    }
  },
  document: { querySelector: () => null },
  console
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: clientPath });

check('bundle registered one module', loaded.length === 1, String(loaded.length));
const entry = loaded[0];
check('module id', entry?.id === 'dsh-commander', entry?.id);

const mod = entry.factory((specifier) => {
  if (specifier === 'react') return React;
  if (specifier === 'react/jsx-runtime') return { jsx: React.createElement, jsxs: React.createElement };
  throw new Error(`unexpected module: ${specifier}`);
});
check('exports apply', typeof mod.apply === 'function');
check('injects slots', Array.isArray(mod.inject) && mod.inject.includes('slots'), JSON.stringify(mod.inject));

const registrations = [];
const injections = [];
const ctx = {
  slots: {
    inject(name, callback) {
      injections.push(name);
      callback();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    }
  }
};
mod.apply(ctx);

check('injects into the composer dock slot', injections[0] === 'conversation.input.dock', JSON.stringify(injections));
check('registers exactly one control', registrations.length === 1, String(registrations.length));
const registered = registrations[0];
check('dock registration names the slot', registered?.options?.name === 'conversation.input.dock', JSON.stringify(registered?.options));
check('dock registration carries an id', typeof registered?.options?.id === 'string', JSON.stringify(registered?.options));
check('registration has a component', typeof registered?.component === 'function');

// Render once with the stub hooks: the closed control must be a button labelled 编队.
const tree = registered.component({ locked: false, onActiveChange: () => {}, inputActions: undefined });
check('render produced an element', tree && typeof tree === 'object');
check('root is a wrapper div', tree?.type === 'div');
const button = walk(tree, (node) => node?.props?.['aria-label'] === '编队');
check('renders the 编队 button', button !== undefined);
check('button is enabled when the composer is unlocked', button?.props?.disabled === false);
check('button starts closed (no panel text)', walk(tree, (node) => node?.props?.children === '编队（团队启动器）') === undefined);

// Pure helpers: the generated instruction must carry the goal, per-member duty,
// role, model and the review-bearing chain.
const helpers = mod.__test;
check('test seam exported', helpers && typeof helpers.instructionText === 'function');
const blank = helpers.defaultState();
check('default roster starts blank and custom', blank.members.length === 2 && blank.members[0].role === '自定义');
check('default roster carries no canned duty', blank.members.every((member) => member.duty === ''));
const sample = blank;
sample.goal = '完成论文实验结果部分';
sample.members[0].role = '编码实现';
sample.members[0].duty = '复现代码并给出结果表';
const text = helpers.instructionText(sample);
check('instruction carries the goal', text.includes('任务目标：完成论文实验结果部分'));
check('instruction carries the duty', text.includes('复现代码并给出结果表'));
check('instruction names the role', text.includes('编码实现'));
check('instruction names the model route', text.includes('deepseek-official/deepseek-flash'));
check('instruction requires review in the chain', text.includes('review'));
check('instruction asks the lead to consolidate', text.includes('汇总成一份交付'));
sample.members[1].customRole = '数据清洗';
check('instruction uses a custom role name', helpers.instructionText(sample).includes('数据清洗'));
sample.askOnly = true;
check('ask-only mode suppresses the go-ahead line', helpers.instructionText(sample).includes('只讨论、不要开工'));

function walk(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = walk(child, predicate);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (predicate(node)) return node;
  return walk(node.props?.children, predicate);
}

console.log(failures.length === 0 ? '\nALL CLIENT CHECKS PASSED' : `\nFAILURES: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
