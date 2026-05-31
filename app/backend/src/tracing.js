// tracing.js - added once, required before everything else
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: 'http://tempo:4318/v1/traces' }),
  instrumentations: [getNodeAutoInstrumentations()],
  serviceName: 'task-app-backend'
});
sdk.start();