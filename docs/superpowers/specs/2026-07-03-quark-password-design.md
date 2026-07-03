# Quark Share Password Extraction

## Goal

When a resource page provides a password for a Quark share URL, preserve it through the resource-search API, show it beside the link, and let the user copy the link and password in one action.

## Data flow

The Worker continues to extract canonical Quark share URLs from each fetched resource page. For every URL occurrence, it inspects nearby decoded page text for the common labels `提取码`, `密码`, and `访问码`. A matched password is attached to that URL as an optional `password` field. Nearby matching is scoped to each link so pages containing multiple links do not assign one page-wide password to every result.

The resource API keeps its existing response shape and adds only the optional field:

```json
{
  "url": "https://pan.quark.cn/s/example",
  "password": "1234"
}
```

Entries without a detected password omit the field and retain their current behavior.

## Matching rules

- Decode common HTML entities and escaped separators before inspection.
- Accept a short alphanumeric password following `提取码`, `密码`, or `访问码`, with optional punctuation or whitespace between the label and value.
- Prefer a password in the text immediately after the URL; fall back to the short context immediately before it.
- Do not treat unrelated prose or another URL as a password.
- Deduplicate by canonical URL while retaining a password if any occurrence of that URL supplies one.

## Interface

Each Quark link card displays the password when present and includes a single copy button. The copied text is:

```text
https://pan.quark.cn/s/example
提取码：1234
```

Without a password, the button copies only the URL. After a successful copy, the button briefly shows an `已复制` confirmation. The link itself remains directly openable.

## Error handling and compatibility

Password extraction is best-effort. Missing or malformed passwords never suppress a valid Quark URL. The optional API field is backward-compatible, and clipboard failure leaves the card usable as a normal link.

## Tests

- Worker tests cover passwords after and before URLs, escaped page content, absent passwords, multiple URL/password pairs, and duplicate URLs where only one occurrence includes a password.
- Frontend tests cover the composed clipboard text with and without a password and ensure rendered resource links remain openable.
- The full test, lint, and production build commands must pass.
