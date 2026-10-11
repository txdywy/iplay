// Complete detail fixtures include the subresources requested via append_to_response.
// Malformed-response tests deliberately bypass this helper.
export function tmdbDetail(payload) {
    return {
        external_ids: {},
        ...payload,
        credits: { cast: [], crew: [], ...payload.credits }
    };
}
