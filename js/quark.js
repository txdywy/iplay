export function formatQuarkCopyText({ url, password }) {
    const normalizedPassword = typeof password === 'string' ? password.trim() : '';
    return normalizedPassword ? `${url}\n提取码：${normalizedPassword}` : url;
}

export async function copyQuarkShare(item, writeText) {
    await writeText(formatQuarkCopyText(item));
}
