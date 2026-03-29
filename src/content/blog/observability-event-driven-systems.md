---
title: "Observability for Event-Driven Systems: The Metrics That Actually Matter"
description: "Logs and dashboards are necessary but not sufficient. Here's how to build meaningful observability for event-driven systems — from SLO design to correlating events with business outcomes."
pubDate: 2026-05-10
tags: ["observability", "kafka", "distributed-systems", "slo", "dynatrace", "grafana"]
draft: false
---

There's a particular failure mode I've seen across multiple event-driven systems: the monitoring is extensive but the observability is poor. You have dashboards. You have alerts. You have hundreds of metrics. And yet, when something goes wrong, you spend forty minutes in the logs trying to reconstruct what actually happened.

The problem is usually not missing data — it's unmeaningful data. Metrics that tell you infrastructure utilization but not business impact. Logs that tell you an exception was thrown but not which user, which transaction, and which downstream effect it had. Traces that stop at the service boundary instead of following the event through the entire pipeline.

This post is about building observability for event-driven systems that answers the questions that actually matter during an incident — and during the quiet periods when you're trying to understand if your system is healthy.

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
            .eventId(eventId)
            .aggregateId(aggregateId)
            .service(getServiceName())
            .traceId(MDC.get("traceId"))
            .spanId(MDC.get("spanId"))
            .correlationId(MDC.get("correlationId"))
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
            .eventId(eventId)
            .consumerGroup(consumerGroup)
            .processingDurationMs(processingTime.toMillis())
            .traceId(MDC.get("traceId"))
            .correlationId(MDC.get("correlationId"))
            .build();

        logger.info(JsonUtils.toJson(logEntry));
    }
}
```

The critical fields are `traceId`, `correlationId`, and `eventId`. With these three, you can reconstruct the complete journey of any event across any number of services.

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

            // Propagate trace context in the event header
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
        // Extract trace context from headers
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

Now your trace view in Jaeger or Zipkin shows the complete journey: HTTP request → order service → Kafka topic → payment service. You can see exactly where time was spent and where failures occurred.

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

The latency SLO is particularly interesting: different consumer groups have different latency requirements. Payment processing has a tighter SLO than analytics aggregation. Define these explicitly and alert differently based on the consumer's SLO class.

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

## The Incident Playbook

When an alert fires for an event-driven system, the investigation follows a specific path:

1. **Check consumer group lag** — is a consumer falling behind or stopped?
2. **Check business metrics** — what's the impact? Are orders failing? Are payments not processing?
3. **Check producer throughput** — did publishing spike unexpectedly?
4. **Follow the trace** — find a failing event by ID and trace it through the pipeline
5. **Check dead letter topics** — are events accumulating there?

This is why the instrumentation matters: each step requires specific data. Without business metrics, you can't answer step 2. Without distributed traces, you can't do step 4. Without DLQ monitoring, you miss step 5 entirely.

---

Observability is a feature, not an afterthought. The teams that build it in from the start spend their incidents doing root cause analysis. The teams that skip it spend their incidents in the dark.

If you're building out observability for an event-driven system and want to compare approaches — especially around SLO design and trace propagation — I'd enjoy the conversation at luceroriosg@gmail.com.
