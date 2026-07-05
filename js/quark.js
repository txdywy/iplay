export function formatQuarkCopyText({ password }) {
    return typeof password === 'string' ? password.trim() : '';
}

export async function copyQuarkShare(item, writeText) {
    await writeText(formatQuarkCopyText(item));
}
