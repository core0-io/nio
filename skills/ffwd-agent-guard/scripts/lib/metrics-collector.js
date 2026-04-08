// ---------------------------------------------------------------------------
// Metrics Schema
// All metric names, descriptions, units, and label documentation in one place.
// ---------------------------------------------------------------------------
export const METRICS_SCHEMA = {
    toolUseCount: {
        name: 'agentguard.tool_use.count',
        description: 'Number of tool invocations captured by AgentGuard',
        unit: '{invocations}',
        labels: {
            tool_name: 'Name of the tool being invoked (Bash, Write, Edit, WebFetch, etc.)',
            event: 'Hook event name (PreToolUse, PostToolUse)',
            platform: 'Runtime platform identifier passed via --platform argument',
        },
    },
    turnCount: {
        name: 'agentguard.turn.count',
        description: 'Number of conversation turns completed (Stop or SubagentStop events)',
        unit: '{turns}',
        labels: {
            platform: 'Runtime platform identifier',
        },
    },
};
// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter as OTLPMetricExporterHttp } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPMetricExporter as OTLPMetricExporterGrpc } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { Metadata } from '@grpc/grpc-js';
// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------
function deriveMetricsEndpoint(tracesEndpoint) {
    return tracesEndpoint.replace(/\/v1\/traces\/?$/, '/v1/metrics');
}
export function createMeterProvider(config) {
    if (!config.endpoint)
        return null;
    const headers = {};
    if (config.api_key) {
        headers['Authorization'] = `Bearer ${config.api_key}`;
    }
    const metricsUrl = config.protocol === 'grpc' ? config.endpoint : deriveMetricsEndpoint(config.endpoint);
    let exporter;
    if (config.protocol === 'grpc') {
        const grpcMetadata = new Metadata();
        for (const [k, v] of Object.entries(headers)) {
            grpcMetadata.set(k, v);
        }
        exporter = new OTLPMetricExporterGrpc({
            url: metricsUrl,
            metadata: grpcMetadata,
            timeoutMillis: config.timeout,
        });
    }
    else {
        exporter = new OTLPMetricExporterHttp({
            url: metricsUrl,
            headers,
            timeoutMillis: config.timeout,
        });
    }
    return new MeterProvider({
        readers: [
            new PeriodicExportingMetricReader({
                exporter,
                exportIntervalMillis: 1000,
            }),
        ],
    });
}
// ---------------------------------------------------------------------------
// Record functions
// ---------------------------------------------------------------------------
export async function recordToolUse(provider, toolName, event, platform) {
    const meter = provider.getMeter('agentguard-collector', '1.0.0');
    const counter = meter.createCounter(METRICS_SCHEMA.toolUseCount.name, {
        description: METRICS_SCHEMA.toolUseCount.description,
        unit: METRICS_SCHEMA.toolUseCount.unit,
    });
    counter.add(1, {
        'agentguard.tool_name': toolName,
        'agentguard.event': event,
        'agentguard.platform': platform,
    });
    await provider.forceFlush();
}
export async function recordTurn(provider, platform) {
    const meter = provider.getMeter('agentguard-collector', '1.0.0');
    const counter = meter.createCounter(METRICS_SCHEMA.turnCount.name, {
        description: METRICS_SCHEMA.turnCount.description,
        unit: METRICS_SCHEMA.turnCount.unit,
    });
    counter.add(1, {
        'agentguard.platform': platform,
    });
    await provider.forceFlush();
}
