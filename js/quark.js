export const QUARK_CHECK_BATCH_SIZE = 12;

export function isQuarkShareId(id) {
    return typeof id === 'string' && /^[a-z0-9_-]{1,128}$/i.test(id);
}

export function quarkShareId(url) {
    const id = /^https?:\/\/(?:pan|drive)\.quark\.cn\/s\/([^/?#]+)$/i.exec(url)?.[1];
    return isQuarkShareId(id) ? id : null;
}

export function formatQuarkCopyText({ password }) {
    return typeof password === 'string' ? password.trim() : '';
}

export async function copyQuarkShare(item, writeText) {
    await writeText(formatQuarkCopyText(item));
}
