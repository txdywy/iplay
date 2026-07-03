# Quark Share Password Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract passwords associated with Quark share URLs, return them through the resource API, and provide one-click copying of the link plus password.

**Architecture:** The Worker will parse URL occurrences with bounded surrounding context and merge duplicate occurrences without losing a discovered password. A small browser-independent frontend module will compose clipboard text, while the existing resource renderer will add password metadata and a copy button to Quark cards.

**Tech Stack:** Cloudflare Worker JavaScript, browser DOM APIs, Clipboard API, Node.js test runner, ESLint, Tailwind CSS.

---

## File structure

- Modify `worker/_worker.js`: extract URL/password pairs and preserve passwords during deduplication.
- Modify `tests/quark-urls.test.js`: verify backend matching, isolation, escaping, absence, and merging.
- Create `js/quark.js`: pure password normalization and clipboard-text composition.
- Create `tests/quark-copy.test.js`: verify clipboard text independently of the browser DOM.
- Modify `js/main.js`: display passwords, render the one-click button, and invoke the Clipboard API.
- Modify `docs/API.md`: document the optional `password` response property.

### Task 1: Worker extraction

**Files:**
- Modify: `tests/quark-urls.test.js`
- Modify: `worker/_worker.js`

- [ ] **Step 1: Write failing extraction tests**

Add resource-page fixtures containing `链接…提取码：a1B2`, `密码 xyz9…链接`, two separate link/password pairs, an escaped link/password, a link with no password, and duplicate occurrences where only one has a password. Assert exact `{ url, password? }` results.

- [ ] **Step 2: Verify RED**

Run `node --test tests/quark-urls.test.js`. Expected: FAIL because returned items do not contain `password`.

- [ ] **Step 3: Implement minimal contextual extraction**

Replace URL-only collection for resource pages with an occurrence parser that:

```js
const PASSWORD_PATTERN = /(?:提取码|密码|访问码)\s*[：:=]?\s*([a-z0-9]{2,12})/i;
```

For each canonical URL match, inspect bounded decoded context after the URL first and before it second, stopping context at neighboring Quark URLs. Return `{ url, password }` when matched and `{ url }` otherwise. Merge duplicate URLs by filling a missing password from later occurrences.

- [ ] **Step 4: Verify GREEN**

Run `node --test tests/quark-urls.test.js`. Expected: all Quark extraction tests PASS.

### Task 2: Copy-text contract

**Files:**
- Create: `js/quark.js`
- Create: `tests/quark-copy.test.js`

- [ ] **Step 1: Write failing pure-function tests**

```js
assert.equal(formatQuarkCopyText({ url: 'https://pan.quark.cn/s/demo', password: 'a1B2' }),
    'https://pan.quark.cn/s/demo\n提取码：a1B2');
assert.equal(formatQuarkCopyText({ url: 'https://pan.quark.cn/s/demo' }),
    'https://pan.quark.cn/s/demo');
```

- [ ] **Step 2: Verify RED**

Run `node --test tests/quark-copy.test.js`. Expected: FAIL because `js/quark.js` does not exist.

- [ ] **Step 3: Implement the formatter**

Export `formatQuarkCopyText(item)` from `js/quark.js`; trim the optional password and append `\n提取码：${password}` only when non-empty.

- [ ] **Step 4: Verify GREEN**

Run `node --test tests/quark-copy.test.js`. Expected: both tests PASS.

### Task 3: Resource-card interface

**Files:**
- Modify: `js/main.js`

- [ ] **Step 1: Add the copy interaction**

Import `formatQuarkCopyText`. Extend `renderLinkCards` with an optional action callback that renders a `<button type="button">`; prevent link navigation when it is clicked, write formatted content with `navigator.clipboard.writeText`, and briefly change its text from `一键复制` to `已复制`.

- [ ] **Step 2: Display the password**

For Quark cards only, render `提取码：${item.password}` when present and configure the copy action. Keep the enclosing link openable in a new tab. On clipboard failure, call the existing toast with a concise retry message.

- [ ] **Step 3: Run focused tests and lint**

Run `node --test tests/quark-copy.test.js tests/quark-urls.test.js && npm run lint`. Expected: all tests and lint PASS.

### Task 4: Documentation and verification

**Files:**
- Modify: `docs/API.md`

- [ ] **Step 1: Document the optional field**

Add `"password": "a1B2"` to the Quark URL response example and explain that it is omitted when the source page provides no recognizable password.

- [ ] **Step 2: Run the complete verification suite**

Run `npm test`. Expected: Node tests, ESLint, and Tailwind production build all PASS.

- [ ] **Step 3: Inspect the final diff**

Run `git diff --check && git diff --stat`. Expected: no whitespace errors and only the files listed by this plan are changed.

- [ ] **Step 4: Commit the implementation**

```bash
git add worker/_worker.js tests/quark-urls.test.js js/quark.js tests/quark-copy.test.js js/main.js docs/API.md docs/superpowers/plans/2026-07-03-quark-password.md
git commit -m "feat: extract and copy Quark share passwords"
```
