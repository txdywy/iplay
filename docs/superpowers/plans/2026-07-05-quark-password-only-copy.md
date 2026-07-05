# Quark Password-Only Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a copy action only for Quark entries with a password and copy only that password.

**Architecture:** Keep clipboard-value normalization in the browser-independent `js/quark.js` module. Extend the existing generic link-card renderer to resolve an action label per item, allowing Quark entries without passwords to remain plain links without action UI.

**Tech Stack:** Browser JavaScript modules, Node.js test runner, ESLint, Tailwind CSS

---

### Task 1: Password-only clipboard behavior

**Files:**
- Modify: `tests/quark-copy.test.js`
- Modify: `js/quark.js`

- [x] **Step 1: Write the failing tests**

Replace the combined URL/password expectations with:

```js
test('formats only the normalized Quark password for copying', () => {
    assert.equal(formatQuarkCopyText({ password: ' a1B2 ' }), 'a1B2');
});

test('returns an empty copy value when no password was found', () => {
    assert.equal(formatQuarkCopyText({}), '');
});

test('writes only the Quark password in one clipboard action', async () => {
    const writes = [];
    await copyQuarkShare({ password: 'a1B2' }, async text => writes.push(text));
    assert.deepEqual(writes, ['a1B2']);
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/quark-copy.test.js`

Expected: FAIL because the formatter still includes the URL and label.

- [x] **Step 3: Implement the minimal formatter**

Change `formatQuarkCopyText` to return only a trimmed string password, or an empty string when absent:

```js
export function formatQuarkCopyText({ password }) {
    return typeof password === 'string' ? password.trim() : '';
}
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `node --test tests/quark-copy.test.js`

Expected: all three tests PASS.

### Task 2: Password-only action UI

**Files:**
- Modify: `js/main.js:416-510`
- Modify: `js/main.js:635-650`

- [x] **Step 1: Resolve the action label for each card**

Inside the `safeItems` loop, resolve function-valued labels and use the resolved string for visibility, initial button text, and reset feedback:

```js
const resolvedActionLabel = typeof actionLabel === 'function' ? actionLabel(item) : actionLabel;
const hasAction = resolvedActionLabel && typeof onAction === 'function';
// ...
button.textContent = resolvedActionLabel;
// ...
setTimeout(() => { button.textContent = resolvedActionLabel; }, 1600);
```

- [x] **Step 2: Configure Quark cards and clipboard failure text**

Use a conditional label so passwordless entries have no action, and update the failure toast:

```js
actionLabel: item => item.password ? '复制密码' : '',
```

```js
showToast('复制失败，请手动复制密码');
```

- [x] **Step 3: Run full verification**

Run: `npm test`

Expected: unit tests, lint, and production CSS build all PASS with no errors.

- [x] **Step 4: Commit the implementation**

```bash
git add js/quark.js js/main.js tests/quark-copy.test.js docs/superpowers/plans/2026-07-05-quark-password-only-copy.md
git commit -m "feat: copy only Quark passwords"
```
