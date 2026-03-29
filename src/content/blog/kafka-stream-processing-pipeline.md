---
title: "Building a Kafka Stream Processing Pipeline from Scratch"
description: "A complete archetype for real-time analytics with Kafka Streams: windowed aggregations, stream-to-stream joins, state stores, and exactly-once processing in Java."
pubDate: 2026-04-12
tags: ["kafka", "kafka-streams", "java", "real-time", "stream-processing"]
draft: false
---

Most Kafka tutorials show you how to produce and consume messages. That's table stakes. The interesting work starts when you need to compute rolling metrics over live data, join streams from different domains, or maintain stateful aggregations that survive restarts.

This post is a complete walkthrough of a production-grade Kafka Streams pipeline. We'll build an archetype that covers the four capabilities you'll need in any serious real-time analytics system: stream processing with windowed aggregations, stateful session tracking, stream-to-stream joins, and proper exactly-once configuration. All of this in Java with Spring Boot.

---

## Why Kafka Streams Over a Separate Processing Engine?

Before the code: why Kafka Streams instead of Flink, Spark Streaming, or a custom consumer loop?

**Operational simplicity.** Kafka Streams is a library — it runs inside your Spring Boot application, not in a separate cluster. No separate infrastructure to provision, monitor, or scale.

**State stores.** Kafka Streams provides RocksDB-backed state stores that are automatically backed up to Kafka changelog topics. Your application can restart and recover its state without reprocessing the entire history.

**Exactly-once semantics.** With `EXACTLY_ONCE_V2`, Kafka Streams guarantees that each input record is processed exactly once, even across failures. This matters enormously for financial metrics and billing systems.

---

## Application Bootstrap

```java
@SpringBootApplication
@EnableKafkaStreams
public class StreamProcessingApplication {

    public static void main(String[] args) {
        SpringApplication.run(StreamProcessingApplication.class, args);
    }

    @Bean(name = KafkaStreamsDefaultConfiguration.DEFAULT_STREAMS_CONFIG_BEAN_NAME)
    public KafkaStreamsConfiguration kStreamsConfig() {
        Map<String, Object> props = new HashMap<>();
        props.put(StreamsConfig.APPLICATION_ID_CONFIG, "stream-processing-app");
        props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, kafkaBootstrapServers);
        props.put(StreamsConfig.DEFAULT_KEY_SERDE_CLASS_CONFIG, Serdes.String().getClass().getName());
        props.put(StreamsConfig.DEFAULT_VALUE_SERDE_CLASS_CONFIG, JsonSerde.class.getName());
        props.put(StreamsConfig.COMMIT_INTERVAL_MS_CONFIG, 1000);
        props.put(StreamsConfig.NUM_STREAM_THREADS_CONFIG, 3);
        props.put(StreamsConfig.REPLICATION_FACTOR_CONFIG, 3);
        // The key configuration: exactly-once processing
        props.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG, StreamsConfig.EXACTLY_ONCE_V2);

        return new KafkaStreamsConfiguration(props);
    }

    @Value("${spring.kafka.bootstrap-servers}")
    private String kafkaBootstrapServers;
}
```

Three things worth noting here: `NUM_STREAM_THREADS_CONFIG` controls parallelism within a single instance, `REPLICATION_FACTOR_CONFIG` ensures fault-tolerant state stores, and `EXACTLY_ONCE_V2` uses the improved exactly-once implementation that requires Kafka 2.5+.

---

## Pattern 1: Windowed Aggregations for Real-Time Metrics

The most common use case: count or sum events within rolling time windows. Here we compute login counts in 5-minute sliding windows with 1-minute advancement:

```java
@Component
public class UserMetricsProcessor {

    private final JsonSerde<UserEvent> userEventSerde;
    private final JsonSerde<UserMetrics> userMetricsSerde;

    @Bean
    public KStream<String, UserEvent> processUserMetrics(StreamsBuilder streamsBuilder) {
        KStream<String, UserEvent> userStream = streamsBuilder
            .stream("user-events", Consumed.with(Serdes.String(), userEventSerde));

        // Sliding window: count logins per user in 5-minute windows, advancing every minute
        userStream
            .filter((key, value) -> value.getEventType().equals("USER_LOGIN"))
            .selectKey((key, value) -> value.getUserId())
            .groupByKey(Grouped.with(Serdes.String(), userEventSerde))
            .windowedBy(TimeWindows.of(Duration.ofMinutes(5)).advanceBy(Duration.ofMinutes(1)))
            .count(Materialized.<String, Long, WindowStore<Bytes, byte[]>>as("user-login-counts")
                .withKeySerde(Serdes.String())
                .withValueSerde(Serdes.Long()))
            .toStream()
            .map((windowedKey, count) -> {
                String userId = windowedKey.key();
                UserMetrics metrics = new UserMetrics();
                metrics.setUserId(userId);
                metrics.setMetricType("LOGIN_COUNT");
                metrics.setValue(count.doubleValue());
                metrics.setWindowStart(Instant.ofEpochMilli(windowedKey.window().start()));
                metrics.setWindowEnd(Instant.ofEpochMilli(windowedKey.window().end()));
                metrics.setTimestamp(Instant.now());

                return KeyValue.pair(userId, metrics);
            })
            .to("user-metrics", Produced.with(Serdes.String(), userMetricsSerde));

        return userStream;
    }
}
```

The `Materialized` parameter names the state store (`"user-login-counts"`), which you can query via the interactive queries API — enabling your service to answer questions like "how many logins has user X had in the last 5 minutes?" without touching the output topic.

---

## Pattern 2: Stateful Session Aggregation

Sometimes you need to track state across multiple events for the same entity. Here we compute session duration by correlating login and logout events:

```java
// Still inside UserMetricsProcessor
userStream
    .filter((key, value) ->
        value.getEventType().equals("USER_LOGIN") ||
        value.getEventType().equals("USER_LOGOUT"))
    .selectKey((key, value) -> value.getUserId())
    .groupByKey(Grouped.with(Serdes.String(), userEventSerde))
    .aggregate(
        UserSession::new,
        (key, value, aggregate) -> {
            if (value.getEventType().equals("USER_LOGIN")) {
                aggregate.setLoginTime(value.getTimestamp());
                aggregate.setUserId(value.getUserId());
            } else if (value.getEventType().equals("USER_LOGOUT")) {
                aggregate.setLogoutTime(value.getTimestamp());
                if (aggregate.getLoginTime() != null) {
                    long duration = Duration.between(
                        aggregate.getLoginTime(),
                        aggregate.getLogoutTime()).toMinutes();
                    aggregate.setSessionDuration(duration);
                }
            }
            return aggregate;
        },
        Materialized.<String, UserSession, KeyValueStore<Bytes, byte[]>>as("user-sessions")
            .withKeySerde(Serdes.String())
            .withValueSerde(new JsonSerde<>(UserSession.class))
    )
    .toStream()
    .filter((key, value) -> value.getSessionDuration() != null)
    .map((key, value) -> {
        UserMetrics metrics = new UserMetrics();
        metrics.setUserId(value.getUserId());
        metrics.setMetricType("SESSION_DURATION");
        metrics.setValue(value.getSessionDuration().doubleValue());
        metrics.setTimestamp(Instant.now());
        return KeyValue.pair(key, metrics);
    })
    .to("user-metrics", Produced.with(Serdes.String(), userMetricsSerde));
```

The `aggregate` operator maintains the `UserSession` state store across restarts. When the app recovers from a crash, it replays from the changelog topic and the in-memory state is reconstructed automatically.

---

## Pattern 3: Hourly Business Analytics

For business dashboards, hourly aggregations are usually the right granularity — detailed enough to spot trends, coarse enough to stay manageable:

```java
@Component
public class OrderAnalyticsProcessor {

    @Bean
    public KStream<String, OrderEvent> processOrderAnalytics(StreamsBuilder streamsBuilder) {
        KStream<String, OrderEvent> orderStream = streamsBuilder
            .stream("order-events", Consumed.with(Serdes.String(), orderEventSerde));

        // Hourly order volume and revenue
        orderStream
            .filter((key, value) -> value.getEventType().equals("ORDER_CREATED"))
            .selectKey((key, value) -> "all-orders")
            .groupByKey(Grouped.with(Serdes.String(), orderEventSerde))
            .windowedBy(TimeWindows.of(Duration.ofHours(1)))
            .aggregate(
                OrderAnalytics::new,
                (key, value, aggregate) -> {
                    aggregate.incrementOrderCount();
                    aggregate.addAmount(value.getTotalAmount());
                    aggregate.setTimestamp(Instant.now());
                    return aggregate;
                },
                Materialized.<String, OrderAnalytics, WindowStore<Bytes, byte[]>>
                    as("hourly-order-analytics")
                    .withKeySerde(Serdes.String())
                    .withValueSerde(orderAnalyticsSerde)
            )
            .toStream()
            .map((windowedKey, analytics) -> {
                analytics.setWindowStart(Instant.ofEpochMilli(windowedKey.window().start()));
                analytics.setWindowEnd(Instant.ofEpochMilli(windowedKey.window().end()));
                analytics.setAverageOrderValue(
                    analytics.getTotalAmount() / analytics.getOrderCount());
                return KeyValue.pair(windowedKey.key(), analytics);
            })
            .to("order-analytics", Produced.with(Serdes.String(), orderAnalyticsSerde));

        return orderStream;
    }
}
```

---

## Pattern 4: Stream-to-Stream Joins

The most powerful capability in Kafka Streams: joining two live streams within a time window. This lets you enrich events with context from another domain — for example, correlating user behavior with order events to build a unified activity timeline.

```java
@Component
public class StreamJoinProcessor {

    @Bean
    public KStream<String, EnrichedEvent> processStreamJoins(StreamsBuilder streamsBuilder) {
        // Re-key both streams by userId before joining
        KStream<String, UserEvent> userStream = streamsBuilder
            .stream("user-events", Consumed.with(Serdes.String(), userEventSerde))
            .selectKey((key, value) -> value.getUserId());

        KStream<String, OrderEvent> orderStream = streamsBuilder
            .stream("order-events", Consumed.with(Serdes.String(), orderEventSerde))
            .selectKey((key, value) -> value.getUserId());

        // Join user events with order events within a 5-minute window
        KStream<String, EnrichedEvent> userOrderJoin = userStream
            .join(
                orderStream,
                (userEvent, orderEvent) -> {
                    EnrichedEvent enriched = new EnrichedEvent();
                    enriched.setUserId(userEvent.getUserId());
                    enriched.setUserAction(userEvent.getEventType());
                    enriched.setOrderId(orderEvent.getOrderId());
                    enriched.setOrderAmount(orderEvent.getTotalAmount());
                    enriched.setCorrelationTimestamp(Instant.now());
                    return enriched;
                },
                JoinWindows.of(Duration.ofMinutes(5)),
                StreamJoined.with(Serdes.String(), userEventSerde, orderEventSerde)
            );

        userOrderJoin.to("enriched-events",
            Produced.with(Serdes.String(), enrichedEventSerde));

        return userOrderJoin;
    }
}
```

**Critical detail:** Both streams must be co-partitioned — same number of partitions, same partitioning strategy — for the join to work correctly. Kafka Streams will throw a `TopologyException` if you try to join streams that aren't co-partitioned. The `selectKey` calls above ensure both streams are keyed by `userId` before the join.

---

## The Architecture at Scale

Here's the complete topology for this pipeline:

```
Input Topics:         Processing:              Output Topics:
user-events    ──────► UserMetricsProcessor ──► user-metrics
order-events   ──────► OrderAnalyticsProcessor ► order-analytics
payment-events ──────► StreamJoinProcessor  ──► enriched-events
                              │
                        State Stores:
                        - user-login-counts (windowed)
                        - user-sessions (KV)
                        - hourly-order-analytics (windowed)
```

Each state store is backed by a changelog topic in Kafka. When a stream thread fails and recovers, it restores state from the changelog. With `EXACTLY_ONCE_V2`, the offset commits and state store updates happen atomically — no double-counting, no lost events.

---

## Production Considerations

A few things that matter in production that most tutorials don't cover:

**Repartition costs.** Every `selectKey` triggers a repartition — your data is re-shuffled through an intermediate topic. If you're calling `selectKey` before a join or aggregation, profile the extra topic throughput this creates.

**State store sizing.** RocksDB state stores live on local disk. Size your persistent volumes accordingly, and monitor `streams.state.size` metrics. A state store that fills disk will cause your application to halt.

**Windowed state retention.** Kafka Streams automatically cleans up windowed state after the retention period. Set `StreamsConfig.WINDOW_STORE_CHANGE_LOG_ADDITIONAL_RETENTION_MS_CONFIG` to give late-arriving events a chance to be counted.

**Standby replicas.** Configure `NUM_STANDBY_REPLICAS` to 1 in production. This pre-warms state store copies on standby instances, cutting recovery time from minutes (full changelog replay) to seconds (incremental sync).

---

Kafka Streams is one of those libraries that looks simple until you hit the edge cases — late arrivals, rebalancing under load, changelog topic management. But when it's working well, it's genuinely elegant: your analytics pipeline runs inside your application, your state is durable, and you get exactly-once guarantees without a separate infrastructure cluster.

If you're building or scaling real-time analytics pipelines and want to compare approaches, I'd love to talk — luceroriosg@gmail.com.
