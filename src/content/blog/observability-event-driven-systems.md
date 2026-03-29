---
title: "Observability for Event-Driven Systems: The Metrics That Actually Matter"
description: "Logs and dashboards are necessary but not sufficient. Here's how to build meaningful observability for event-driven systems — from SLO design to correlating events with business outcomes."
pubDate: 2026-05-10
tags: ["observability", "kafka", "distributed-systems", "slo", "dynatrace", "grafana"]
draft: false
---

Event-driven systems fail quietly. In synchronous request-response architectures, a broken dependency surfaces immediately — the caller gets an error and the trace is complete. In production event-driven systems, a consumer can fall silently behind: no exception, no alert, just lag accumulating in a topic until a business metric finally drops and someone starts asking questions.

By the time the queue is tens of thousands of messages deep, the investigation becomes slow and expensive — especially when logs carry no correlation IDs and distributed traces stop at the broker boundary. The event effectively disappears.

That failure mode is solvable, but it requires treating observability as a first-class design concern rather than a dashboard you add after the first incident. This post covers how to build it: which signals actually matter, how to propagate traces across event boundaries, and how to design SLOs for async systems where the usual latency model doesn't apply.

---

## Observability vs. Monitoring

Before going further, one distinction worth naming because most teams conflate them:

**Monitoring** tells you when something is wrong — it's alert-based, threshold-driven, and answers "is X above or below Y?"

**Observability** lets you understand *why* something is wrong — it's exploration-based, correlation-driven, and answers "what actually happened, and where?"

You need both. But monitoring without observability means you know there's a fire and have no idea where it started.

---

## How the Three Pillars Connect

In an event-driven system, logs, metrics, and traces don't operate independently — they need to be correlated across the entire event pipeline. Here's how they fit together:

```
OBSERVABILITY IN EVENT-DRIVEN SYSTEMS
══════════════════════════════════════

Producer Service                Kafka Broker                Consumer Service
─────────────────               ──────────────              ─────────────────
Span: process-order             Topic: order-events         Span: process-payment
  correlationId: abc                  │                       correlationId: abc
  traceId: xyz          ─────────────►│─────────────────────► traceId: xyz
       │                              │                             │
  Metric: orders.created         Metric: lag                  Metric: payments.success
  Log: {"event":"ORDER_CREATED"}  Metric: throughput         Log: {"event":"PAYMENT_DONE"}
       │                              │                             │
       └──────────────────────────────┴─────────────────────────────┘
                                      │
                              Grafana/Dynatrace
                         ─────────────────────────
                         │ Dashboard:              │
                         │ - Business: orders/min  │
                         │ - SLO: lag < 1000       │
                         │ - Trace: end-to-end     │
                         └─────────────────────────┘
```

The broker is not a black box — it's an observable node. Consumer lag and throughput metrics from the broker, combined with traces that cross service boundaries and logs that carry shared IDs, are what make the complete picture possible.

---

## The Three Pillars, Applied to Events

The three pillars of observability — logs, metrics, traces — map differently onto event-driven systems than they do onto synchronous request-response systems.

**Logs** in an event-driven system need to carry correlation IDs that span the entire event lifecycle, from producer to consumer. A log entry at the producer without a correlation ID is nearly useless — you can't trace it forward to what the consumer did with it.

**Metrics** need to measure lag and throughput at the topic level, not just CPU and memory. Consumer group lag is the early warning signal for most event-driven failures.

**Traces** need to cross service boundaries through the event itself. A distributed trace that stops at `kafka.send()` tells you half the story.

### Structured Logging with Event Context

```java
@Component
public class StructuredLogger {

    private static final Logger logger = LoggerFactory.getLogger(StructuredLogger.class);

    public void logEventPublished(String eventType, String eventId,
                                   String aggregateId, Map<String, Object> context) {
        LogEntry logEntry = LogEntry.builder()
            .timestamp(Instant.now())
            .level("INFO")
            .event("EVENT_PUBLISHED")
            .eventType(eventType)
            .eventId(eventId)           // Identifies THIS specific event — used for deduplication
                                        // and idempotency checks on the consumer side
            .aggregateId(aggregateId)
            .service(getServiceName())
            .traceId(MDC.get("traceId"))           // Links all spans in the distributed trace —
                                                    // lets you reconstruct the full call graph
                                                    // in Jaeger, Zipkin, or Dynatrace
            .spanId(MDC.get("spanId"))
            .correlationId(MDC.get("correlationId")) // Business-level correlation — links events
                                                      // that belong to the same user session,
                                                      // order, or transaction across services.
                                                      // Survives trace boundaries (e.g., async
                                                      // callbacks, scheduled retries)
            .context(context)
            .build();

        logger.info(JsonUtils.toJson(logEntry));
    }

    public void logEventConsumed(String eventType, String eventId,
                                  String consumerGroup, Duration processingTime) {
        LogEntry logEntry = LogEntry.builder()
            .timestamp(Instant.now())
            .level("INFO")
            .event("EVENT_CONSUMED")
            .eventType(eventType)
            .eventId(eventId)           // Match this to the producer log to confirm delivery
            .consumerGroup(consumerGroup)
            .processingDurationMs(processingTime.toMillis())
            .traceId(MDC.get("traceId"))           // Same traceId as producer — this is what
                                                    // stitches producer and consumer spans into
                                                    // a single end-to-end trace
            .correlationId(MDC.get("correlationId")) // Business correlation — query by this
                                                      // to answer "what else happened during
                                                      // this user's checkout flow?"
            .build();

        logger.info(JsonUtils.toJson(logEntry));
    }
}
```

The critical fields are `traceId`, `correlationId`, and `eventId` — and they serve distinct purposes. `eventId` is about the event itself: idempotency, deduplication, delivery confirmation. `traceId` is about the distributed trace: what spans belong together in the observability tool. `correlationId` is about the business transaction: what logical flow does this event belong to, even across asynchronous gaps or retries that break trace continuity. You need all three.

### Business Metrics vs. Technical Metrics

```java
@Component
public class BusinessMetrics {

    private final Counter orderCreations;
    private final Counter paymentSuccesses;
    private final Counter paymentFailures;
    private final Timer orderProcessingTime;
    private final Gauge activeUsers;

    public BusinessMetrics(MeterRegistry meterRegistry) {
        // Business metrics — these answer "is our system delivering value?"
        // Use these first during an incident to understand scope and customer impact
        this.orderCreations = Counter.builder("business.orders.created.total")
            .description("Total orders created")
            .register(meterRegistry);

        this.paymentSuccesses = Counter.builder("business.payments.success.total")
            .description("Successful payment events processed")
            .register(meterRegistry);

        this.paymentFailures = Counter.builder("business.payments.failure.total")
            .description("Failed payment events processed")
            .register(meterRegistry);

        // Technical metrics — these answer "is our infrastructure healthy?"
        // Use these second during an incident to pinpoint the root cause
        this.orderProcessingTime = Timer.builder("tech.order.processing.duration")
            .description("End-to-end order processing time")
            .register(meterRegistry);

        this.activeUsers = Gauge.builder("business.users.active")
            .description("Currently active users")
            .register(meterRegistry, this, BusinessMetrics::getActiveUserCount);
    }

    public void recordOrderCreated() {
        orderCreations.increment();
    }

    public void recordPaymentResult(boolean success) {
        if (success) {
            paymentSuccesses.increment();
        } else {
            paymentFailures.increment();
        }
    }

    public Timer.Sample startOrderProcessing() {
        return Timer.start();
    }

    private double getActiveUserCount() {
        return userService.getActiveUserCount();
    }
}
```

The business metrics (`business.*`) tell you whether your system is delivering value. The technical metrics (`tech.*`) tell you why it might not be. Both are necessary — but during an incident, you need the business metrics first to understand scope, then the technical metrics to find the root cause.

---

## Distributed Tracing Across Event Boundaries

The gap in most event-driven observability is trace propagation across the event boundary. When a producer publishes an event, the trace context needs to travel with the event so the consumer can continue the same trace.

```java
@Component
public class OrderService {

    @Autowired
    private Tracer tracer;

    @Autowired
    private EventPublisher eventPublisher;

    public Order processOrder(OrderRequest request) {
        Span span = tracer.nextSpan()
            .name("process-order")
            .tag("order.id", request.getOrderId())
            .tag("customer.id", request.getCustomerId())
            .start();

        try (Tracer.SpanInScope ws = tracer.withSpanInScope(span)) {
            Order order = validateOrder(request);
            order = calculateTotal(order);
            order = applyDiscounts(order);
            order = saveOrder(order);

            span.tag("order.total", String.valueOf(order.getTotal()));
            span.tag("order.status", order.getStatus());

            // Inject the current trace context into the event headers.
            // This is what allows the consumer to create a child span and continue
            // the same distributed trace — without this, the trace breaks at the broker.
            Map<String, String> traceHeaders = new HashMap<>();
            tracer.inject(span.context(), Format.Builtin.TEXT_MAP,
                new TextMapAdapter(traceHeaders));

            eventPublisher.publishWithHeaders("order-events",
                new OrderCreatedEvent(order), traceHeaders);

            return order;
        } finally {
            span.end();
        }
    }
}
```

On the consumer side, extract the trace context from the event headers to continue the trace:

```java
@Component
public class PaymentEventConsumer {

    @Autowired
    private Tracer tracer;

    @KafkaListener(topics = "order-events")
    public void handleOrderCreated(ConsumerRecord<String, OrderCreatedEvent> record) {
        // Extract trace context from headers — this makes the consumer span a child
        // of the producer span, resulting in a single end-to-end trace that crosses
        // the Kafka boundary. Without this, Jaeger/Dynatrace shows two disconnected traces.
        Map<String, String> headers = extractHeaders(record);
        SpanContext parentContext = tracer.extract(Format.Builtin.TEXT_MAP,
            new TextMapAdapter(headers));

        Span span = tracer.buildSpan("process-payment")
            .asChildOf(parentContext)
            .start();

        try (Tracer.SpanInScope ws = tracer.withSpanInScope(span)) {
            paymentService.processPayment(record.value());
            span.tag("payment.status", "processed");
        } finally {
            span.end();
        }
    }
}
```

Now your trace view in Jaeger, Zipkin, or Dynatrace shows the complete journey: HTTP request → order service → Kafka topic → payment service. You can see exactly where time was spent and where failures occurred.

---

## SLO Design for Event-Driven Systems

SLOs (Service Level Objectives) for event-driven systems need to measure different things than SLOs for synchronous APIs. The key metrics:

**Availability SLO:** What percentage of events are successfully processed?
```
Availability = (events_processed_successfully / events_published) × 100
Target: 99.9% over rolling 30 days
```

**Latency SLO:** What is the end-to-end processing time from event publication to consumer completion?
```
Latency P95 < 2 seconds for payment events
Latency P95 < 30 seconds for notification events
Latency P95 < 5 minutes for reporting events
```

**Lag SLO:** How far behind are consumers from producers?
```
Consumer group lag < 1000 messages for real-time consumers
Consumer group lag < 10000 messages for analytics consumers
```

**Implementation:**
```java
@Component
public class EventDrivenSLOMonitor {

    private final MeterRegistry meterRegistry;

    public void recordEventProcessed(String topic, String consumerGroup,
                                      Duration lag, boolean success) {
        // Track success rate for availability SLO
        Counter.builder("slo.event.processed")
            .tag("topic", topic)
            .tag("consumer_group", consumerGroup)
            .tag("success", String.valueOf(success))
            .register(meterRegistry)
            .increment();

        // Track end-to-end lag for latency SLO
        Timer.builder("slo.event.lag")
            .tag("topic", topic)
            .tag("consumer_group", consumerGroup)
            .register(meterRegistry)
            .record(lag);
    }

    public double getAvailabilitySLI(String topic, String consumerGroup,
                                      Duration window) {
        // Calculate the ratio of successful to total events
        double total = getEventCount(topic, consumerGroup, window, null);
        double successful = getEventCount(topic, consumerGroup, window, "true");

        return total > 0 ? (successful / total) * 100 : 100.0;
    }
}
```

The latency SLO is particularly interesting: different consumer groups have different latency requirements, and this should be made explicit rather than assumed. Payment processing has a tighter SLO than analytics aggregation — but so does fraud detection vs. reporting, or inventory reservation vs. audit logging. Define SLO classes per consumer type: real-time consumers (payments, fraud, inventory) typically need sub-second P95 latency and lag alerts in the hundreds; near-real-time consumers (notifications, search indexing) can tolerate a few seconds and lag in the low thousands; batch consumers (analytics, reporting, compliance) may have no meaningful lag SLO at all, only an availability SLO over a daily window. Alert thresholds, on-call routing, and error budgets should all differ by class.

---

## Consumer Group Lag: The Canary in the Coal Mine

In my experience, consumer group lag is the single most actionable metric in event-driven systems. A growing lag almost always means one of:

1. A consumer is processing events slower than they're being produced
2. A consumer has crashed and isn't processing at all
3. A sudden spike in production rate (expected — traffic surge — or unexpected — runaway publisher)

**Grafana alerting rule:**
```yaml
groups:
  - name: kafka-lag-alerts
    rules:
      - alert: KafkaConsumerGroupLagHigh
        expr: kafka_consumer_group_lag{consumer_group="payment-consumer"} > 1000
        for: 2m
        labels:
          severity: warning
          slo_class: real_time
        annotations:
          summary: "Payment consumer lag exceeds 1000 messages"
          description: "Consumer group {{ $labels.consumer_group }} on topic {{ $labels.topic }} has lag of {{ $value }} messages"

      - alert: KafkaConsumerGroupLagCritical
        expr: kafka_consumer_group_lag{consumer_group="payment-consumer"} > 5000
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Payment consumer lag critical — SLO breach imminent"
```

Set the lag alert threshold based on your latency SLO. If your SLO requires P95 processing within 2 seconds, and your consumer processes 500 events per second, then a lag of 1000 already puts you at risk.

---

## What I'd Alert On First

If you're starting from scratch, don't try to instrument everything at once. These are the five alerts I'd stand up first, in priority order:

1. **Consumer group lag > threshold (by SLO class)** — catches the most common failure mode silently accumulating before anyone notices in the UI. A stopped consumer with zero errors is otherwise invisible.

2. **Business success rate drop** — e.g., `business.payments.success.total` rate drops more than 10% below baseline. This is your customer-impact signal. It fires when something is actually broken for users, not just when infrastructure is stressed.

3. **Dead letter topic (DLQ) message count increasing** — events landing in DLQ means your system is swallowing failures. A growing DLQ is a slow disaster that teams often discover too late.

4. **Producer throughput deviation** — a sudden spike or sudden drop in `business.orders.created.total` rate often signals either a runaway publisher or a broken upstream integration. Both look like normal operation without this alert.

5. **End-to-end event processing P95 latency breach** — once traces are instrumented, alert on the full producer-to-consumer latency, not just consumer-side processing time. This catches broker slowdowns, partition rebalancing, and network issues that are invisible to individual service metrics.

Add infrastructure alerts (CPU, memory, GC pause) after these. They're useful for root cause investigation but not for detecting that something is actually wrong for users.

---

## The Incident Playbook

When an alert fires for an event-driven system, the investigation follows a specific path:

1. **Check consumer group lag** — is a consumer falling behind or stopped? A lag that's growing linearly suggests a slow consumer or a throughput spike. A lag that's flat and high suggests the consumer stopped entirely — check if the pod is running and if there are rebalancing events in the broker logs.

2. **Check business metrics** — what's the impact? Are orders failing? Are payments not processing? A lag spike in a notification topic may be acceptable for minutes; the same spike in a payment topic means active revenue impact. The business metrics tell you how urgent the response needs to be.

3. **Check producer throughput** — did publishing spike unexpectedly? Compare current `events.published` rate against the rolling baseline. A 10x spike often means a retry loop, a batch job that ran early, or an upstream system recovering from its own outage and replaying.

4. **Follow the trace** — find a failing event by `eventId` or `correlationId` in your log search, then use the `traceId` to pull the full distributed trace in Dynatrace or Jaeger. This shows exactly which span failed, what the error was, and how long each stage took. Without traces propagated across the event boundary, this step becomes manual log archaeology.

5. **Check dead letter topics** — are events accumulating there? DLQ messages include the original event and (if your consumer is instrumented correctly) the exception that caused the failure. Often you'll find a schema mismatch, a null field, or a downstream dependency that's returning 500s for a specific event type.

This is why the instrumentation matters: each step requires specific data. Without business metrics, you can't answer step 2. Without distributed traces, you can't do step 4. Without DLQ monitoring, you miss step 5 entirely.

---

Observability is a feature, not an afterthought. The teams that build it in from the start spend their incidents doing root cause analysis. The teams that skip it spend their incidents in the dark.

If you're building out observability for an event-driven system and want to compare approaches — especially around SLO design and trace propagation — I'd enjoy the conversation at luceroriosg@gmail.com.
