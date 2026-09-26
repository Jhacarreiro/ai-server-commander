const DEFAULT_CONFIRMATION_POLICY = Object.freeze({
    read: false,
    write: false,
    delete: true,
    restart: true,
    permissions: true,
    credentials: true
});

const POLICY_LABELS = Object.freeze({
    read: 'read or inspect data',
    write: 'write or modify data',
    delete: 'delete data',
    restart: 'restart services',
    permissions: 'change permissions',
    credentials: 'access credentials'
});

function normalizeConfirmationPolicy(input) {
    if (input == null) return { ...DEFAULT_CONFIRMATION_POLICY };
    if (typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('confirmationPolicy must be a JSON object when provided.');
    }

    const normalized = { ...DEFAULT_CONFIRMATION_POLICY };
    for (const key of Object.keys(DEFAULT_CONFIRMATION_POLICY)) {
        if (Object.prototype.hasOwnProperty.call(input, key)) {
            if (typeof input[key] !== 'boolean') {
                throw new Error(`confirmationPolicy.${key} must be a boolean.`);
            }
            normalized[key] = input[key];
        }
    }
    return normalized;
}

function confirmationPolicyText(policy) {
    const normalized = normalizeConfirmationPolicy(policy);
    const enabled = Object.entries(normalized)
        .filter(([, required]) => required)
        .map(([key]) => POLICY_LABELS[key]);

    if (!enabled.length) {
        return 'Server policy does not require human confirmation for terminal-command categories.';
    }
    return `Human confirmation is required only before terminal commands expected to ${enabled.join(', ')}.`;
}

module.exports = {
    DEFAULT_CONFIRMATION_POLICY,
    confirmationPolicyText,
    normalizeConfirmationPolicy
};
