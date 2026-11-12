// Merging DroidProxy's models into Factory's customModels list.
//
// A provider whose saved API key cannot be read right now produces no models,
// so a plain "replace everything we own" would delete its models from Factory.
// Models of such providers are kept until the key is readable again or the
// user removes the provider.

const isOwned = (entry, ownedPrefixes) => typeof entry?.id === "string" && ownedPrefixes.some((prefix) => entry.id.startsWith(prefix));

const isWaitingForKey = (entry, unreadableProviders) => typeof entry?.model === "string" && unreadableProviders.some((key) => entry.model.startsWith(`${key}/`));

function mergeCustomModels(existing, next, { ownedPrefixes, unreadableProviders = [] }) {
  const nextIds = new Set(next.map((entry) => entry.id));
  const users = existing.filter((entry) => !isOwned(entry, ownedPrefixes));
  const waiting = existing.filter((entry) => isOwned(entry, ownedPrefixes) && !nextIds.has(entry.id) && isWaitingForKey(entry, unreadableProviders));
  return [...users, ...[...next, ...waiting].map((entry, offset) => ({ ...entry, index: users.length + offset }))];
}

// True when Factory holds exactly the expected DroidProxy models, ignoring
// models kept for a provider whose key is unreadable.
function isInstalled(existing, expectedIds, { ownedPrefixes, unreadableProviders = [] }) {
  const expected = new Set(expectedIds);
  const installed = new Set(existing
    .filter((entry) => isOwned(entry, ownedPrefixes) && (expected.has(entry.id) || !isWaitingForKey(entry, unreadableProviders)))
    .map((entry) => entry.id));
  return expected.size > 0 && installed.size === expected.size && [...expected].every((id) => installed.has(id));
}

module.exports = { mergeCustomModels, isInstalled };
