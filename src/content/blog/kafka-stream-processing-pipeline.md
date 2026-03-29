---
title: "Building a Kafka Stream Processing Pipeline from Scratch"
description: "A complete archetype for real-time analytics with Kafka Streams: windowed aggregations, stream-to-stream joins, state stores, and exactly-once processing in Java."
pubDate: 2026-04-12
tags: ["kafka", "kafka-streams", "java", "real-time", "stream-processing"]
draft: false
---

Most teams using Kafka are still writing raw consumer loops when they should be using Kafka Streams. The symptoms are familiar: stateful aggregations reinvented from scratch, offset commits managed by hand, fragile exactly-once logic bolted on after the fact. Batch works until it doesn't — when you need to react to an event within seconds, not hours, the architecture has to change.

This post is the archetype for that transition: a complete, production-oriented Kafka Streams pipeline in Java with Spring Boot, covering the four patterns that appear in every real-time analytics system.

---

## Kafka Streams vs. a Consumer Loop

Before the architecture: it's worth understanding what Kafka Streams actually buys you over writing a consumer yourself.

```
Simple Consumer Loop:

  Kafka ──► poll() ──► process() ──► commit offset
               │
               └─ You manage: state, failures, exactly-once,
                  windowing, joins, recovery after restart


Kafka Streams:

  Kafka ──► Topology ──► State Stores (RocksDB) ──► Output Topics
               │               │
               │         Changelog topics
               │         (automatic state backup)
               │
               └─ Framework manages: windowing, joins, exactly-once,
                  rebalancing, state recovery, interactive queries
```

A consumer loop is the right tool when you need simple, stateless processing: read a message, call an API, write a result. The moment you need to aggregate across time windows, join two streams, or maintain state that survives a restart, a consumer loop becomes a framework you're building yourself — poorly.

Kafka Streams handles all of that. It runs as a library inside your Spring Boot application, with no separate cluster to manage.

---

## Pipeline Architecture

Here's the full topology we're building before any code:

```
                    ┌─────────────────────────────────────────┐
                    │         Kafka Streams Topology          │
                    │                                         │
user-events ───────►│ UserMetricsProcessor                    │
                    │   └─ WindowedAggregation(5min)          │──► user-metrics
                    │   └─ SessionAggregation                 │
                    │                                         │
order-events ──────►│ OrderAnalyticsProcessor                 │──► order-analytics
                    │   └─ HourlyAggregation                  │
                    │                                         │
user-events ───┐    │ StreamJoinProcessor                     │
order-events ──┴───►│   └─ Join(5min window, by userId)       │──► enriched-events
                    │                                         │
                    │  State Stores (RocksDB):                │
                    │  ├─ user-login-counts (windowed)        │
                    │  ├─ user-sessions (KV)                  │
                    │  └─ hourly-order-analytics (windowed)   │
                    └─────────────────────────────────────────┘
```

Each state store is backed by a changelog topic in Kafka. If the application crashes, it replays from the changelog and reconstructs in-memory state automatically. With `EXACTLY_ONCE_V2`, offset commits and state store updates happen atomically — no double-counting, no lost events.

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

**Business problem:** In a high-volume system — say, a platform processing hundreds of thousands of loan applications per month — you need to detect anomalous activity in near real-time. How many times has a user logged in during the last 5 minutes? A spike in login attempts might indicate a fraud pattern or an automated submission bot. You can't answer that question with batch jobs; you need a rolling window over live data.

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

**Business problem:** In a loan processing system, you need to detect when a user submits multiple applications within the same session — this requires stateful session tracking. A session starts on login and ends on logout. You need to know the duration, what happened in between, and be able to reconstruct this state after a service restart without reprocessing the entire event history from scratch.

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

**Business problem:** Operations and finance teams need to monitor business health throughout the day — order volume, revenue, average ticket. At a consumer lending company, the ops team needs to know by 10am if application volumes are tracking toward monthly targets. Hourly aggregations are usually the right granularity for this: detailed enough to spot intraday trends, coarse enough to stay readable.

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

**Business problem:** You have user behavior events (logins, profile updates, application starts) on one topic, and order/transaction events on another. To build a unified activity timeline — or to detect that a user placed an order within minutes of logging in for the first time — you need to correlate these two streams in real time. Doing this after the fact with a database join introduces latency and misses the moment; doing it in the stream lets you react immediately.

The most powerful capability in Kafka Streams: joining two live streams within a time window. This lets you enrich events with context from another domain.

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

## Production Considerations

A few things that matter in production that most tutorials don't cover:

**Repartition costs.** Every `selectKey` triggers a repartition — your data is re-shuffled through an intermediate topic. If you're calling `selectKey` before a join or aggregation, profile the extra topic throughput this creates.

**State store sizing.** RocksDB state stores live on local disk. Size your persistent volumes accordingly, and monitor `streams.state.size` metrics. A state store that fills disk will cause your application to halt.

**Windowed state retention.** Kafka Streams automatically cleans up windowed state after the retention period. Set `StreamsConfig.WINDOW_STORE_CHANGE_LOG_ADDITIONAL_RETENTION_MS_CONFIG` to give late-arriving events a chance to be counted.

**Standby replicas.** Configure `NUM_STANDBY_REPLICAS` to 1 in production. This pre-warms state store copies on standby instances, cutting recovery time from minutes (full changelog replay) to seconds (incremental sync).

---

Kafka Streams is one of those libraries that looks simple until you hit the edge cases — late arrivals, rebalancing under load, changelog topic management. But when it's working well, it's genuinely elegant: your analytics pipeline runs inside your application, your state is durable, and you get exactly-once guarantees without a separate infrastructure cluster.

If you're building or scaling real-time analytics pipelines and want to compare approaches, I'd love to talk — luceroriosg@gmail.com.
