"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.riskLevelToNumericScore = riskLevelToNumericScore;
exports.calculateRiskLevel = calculateRiskLevel;
/**
 * Map risk level to a 0–1 severity score (higher = more severe).
 * Used in hook messages and audit logs for consistent numeric feedback.
 */
function riskLevelToNumericScore(level) {
    switch (level) {
        case 'low':
            return 0.25;
        case 'medium':
            return 0.5;
        case 'high':
            return 0.75;
        case 'critical':
            return 1;
    }
}
/**
 * Calculate overall risk level from tags
 */
function calculateRiskLevel(tags, rules) {
    const severities = tags.map((tag) => {
        const rule = rules.find((r) => r.id === tag);
        return rule?.severity ?? 'low';
    });
    if (severities.includes('critical'))
        return 'critical';
    if (severities.includes('high'))
        return 'high';
    if (severities.includes('medium'))
        return 'medium';
    return 'low';
}
