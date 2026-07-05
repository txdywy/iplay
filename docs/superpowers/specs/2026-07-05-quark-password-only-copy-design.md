# Quark Password-Only Copy

## Scope

Update the Quark URL cards so password-related UI appears only when a password exists. The Quark share URL remains directly openable.

## Behavior

- When an item has a non-empty password, show `提取码：<password>` and a `复制密码` button.
- Clicking `复制密码` writes only the normalized password to the clipboard, without the URL or `提取码：` label.
- After a successful copy, briefly show `已复制` using the existing action feedback.
- When an item has no password, show neither password text nor a copy button.
- Clipboard failure keeps the link usable and shows a password-specific retry message.

## Implementation

Keep password normalization and clipboard formatting in `js/quark.js`. Configure the existing card renderer in `js/main.js` to create the action only for entries with a password. No API or Worker changes are required.

## Testing

Frontend unit tests verify that copying a password writes only the trimmed password and that missing passwords produce no copyable text. Existing extraction tests continue to cover the optional password field.
