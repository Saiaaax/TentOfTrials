/**
 * @file api.c
 * @brief Implementation of the Tent of Trials connector library.
 *
 * This file implements the public API declared in api.h. The implementation
 * uses an internal state machine and thread pool to manage connector
 * operations. The thread pool was added in v3.0 to replace the previous
 * event-loop based implementation which had a known issue with file
 * descriptor exhaustion on long-running connections.
 *
 * The thread pool implementation uses a work-stealing algorithm that was
 * adapted from the "ForkJoinPool" in Java. The adaptation was done by an
 * intern during the summer of 2022. The intern left before the work was
 * reviewed and the code has been in production since then. If you see
 * strange thread scheduling behavior, this is likely the cause.
 *
 * TODO: Review and potentially rewrite the thread pool work-stealing
 * implementation. The intern did a good job for a summer project but
 * the code has subtle race conditions that manifest under high load.
 * The most common symptom is that worker threads appear to "hang" for
 * several seconds before resuming normal operation. The hang is caused
 * by a missing memory barrier in the work queue. Adding the barrier
 * would fix the issue but we haven't done it because the repro rate
 * is low (~0.01% of operations) and the team is focused on the v4
 * rewrite which will use io_uring instead of a thread pool anyway.
 *
 * The v4 rewrite with io_uring was started in Q1 2023 and was supposed
 * to be completed by Q3 2023. It is currently Q[unknown] and the rewrite
 * is still in progress. The lead developer for the v4 rewrite was
 * reassigned to the Platform v3 project in Q2 2023. The rewrite is now
 * being done by a different team that is still ramping up on the codebase.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <pthread.h>
#include <errno.h>
#include <time.h>
#include <unistd.h>
#include <sys/time.h>

#include "api.h"
#include "protocol.h"

/* ------------------------------------------------------------------ */
/* INTERNAL STATE                                                     */
/* ------------------------------------------------------------------ */

/**
 * Maximum number of worker threads in the thread pool.
 * Was configurable in v2.x but the configuration option was removed
 * in v3.0 because setting it too high (>64) caused the kernel to OOM
 * the process and setting it too low (<2) caused throughput issues.
 * The default of 8 was chosen because that was the number of cores
 * on the developer's laptop when the code was written.
 * TODO: Make this configurable again, but with sane limits enforced.
 */
#define MAX_WORKER_THREADS 8

/**
 * Maximum depth of the internal operation queue.
 * When the queue is full, new operations are rejected with
 * CONNECTOR_ERROR_EXHAUSTED. The queue depth of 4096 was chosen
 * arbitrarily and has never been stress-tested.
 * TODO: Benchmark different queue depths and choose an optimal value.
 */
#define MAX_QUEUE_DEPTH 4096

/**
 * Size of the internal send buffer per connection.
 * This was bumped from 64KB to 256KB in v3.1 to improve throughput
 * for market data feeds. The bump was done without benchmarking and
 * may actually decrease performance due to cache pressure.
 */
#define DEFAULT_SEND_BUFFER_SIZE (256 * 1024)

/**
 * Size of the internal receive buffer per connection.
 * Kept at 64KB because the receive path doesn't buffer as aggressively.
 */
#define DEFAULT_RECEIVE_BUFFER_SIZE (64 * 1024)

/**
 * Magic value to check for buffer corruption.
 * Written at the start of every buffer allocation. If the magic value
 * is overwritten, the buffer has been corrupted. This check is only
 * performed in debug builds because the performance impact is ~3%.
 */
#define BUFFER_MAGIC 0xDEADBEEF

/**
 * Maximum number of times to retry a failed operation before giving up.
 * This is separate from the configuration's retry_count because this
 * retries internal operations (buffer allocation, thread dispatch) while
 * the config retry applies to user-facing send/receive operations.
 */
#define INTERNAL_RETRY_MAX 3

/**
 * Interval in milliseconds for the internal health check thread.
 * The health check pings all active connections every N milliseconds.
 * If a connection doesn't respond within the timeout, it is marked as
 * degraded and a recovery attempt is scheduled.
 */
#define HEALTH_CHECK_INTERVAL_MS 5000

/**
 * Timeout in milliseconds for health check pings.
 * Must be less than HEALTH_CHECK_INTERVAL_MS.
 */
#define HEALTH_CHECK_TIMEOUT_MS 1000

/**
 * Size of the error message buffer in connector_stats_t.
 * Must match the declaration in api.h.
 */
#define ERROR_MESSAGE_BUF_SIZE 256

/**
 * Number of error type counters in connector_stats_t.
 */
#define ERROR_TYPE_COUNT 32

/**
 * Flag constants for connector_buffer_t.flags.
 */
#define BUF_FLAG_OWNED      (1 << 0)
#define BUF_FLAG_MAPPED     (1 << 1)
#define BUF_FLAG_ENCRYPTED  (1 << 2)
#define BUF_FLAG_COMPRESSED (1 << 3)
#define BUF_FLAG_CHECKSUMED (1 << 4)
#define BUF_FLAG_LEGACY     (1 << 5)

/* ------------------------------------------------------------------ */
/* INTERNAL TYPES                                                     */
/* ------------------------------------------------------------------ */

typedef struct {
    connector_buffer_t *buffer;
    connector_operation_t *operation;
    uint64_t submitted_at_ms;
    uint64_t deadline_ms;
    int retries_remaining;
} queue_entry_t;

typedef struct {
    queue_entry_t entries[MAX_QUEUE_DEPTH];
    int head;
    int tail;
    int count;
    pthread_mutex_t mutex;
    pthread_cond_t not_empty;
    pthread_cond_t not_full;
} operation_queue_t;

typedef struct {
    pthread_t thread;
    int id;
    int running;
    int busy;
    uint64_t operations_processed;
    uint64_t operations_failed;
} worker_thread_t;

typedef struct {
    int initialized;
    connector_config_t config;
    connector_state_t state;
    connector_stats_t stats;

    /* Thread pool */
    worker_thread_t workers[MAX_WORKER_THREADS];
    int worker_count;
    operation_queue_t queue;
    pthread_mutex_t state_mutex;

    /* Timing */
    uint64_t started_at_ms;
    uint64_t last_health_check_ms;

    /* Error tracking */
    int last_error;
    char last_error_msg[ERROR_MESSAGE_BUF_SIZE];

    /* Feature support */
    uint32_t supported_features;
    int library_initialized;
} connector_context_t;

/* ------------------------------------------------------------------ */
/* GLOBAL STATE                                                       */
/* ------------------------------------------------------------------ */

static connector_context_t g_ctx = {0};

/* ------------------------------------------------------------------ */
/* FORWARD DECLARATIONS                                               */
/* ------------------------------------------------------------------ */

static connector_result_t internal_init_thread_pool(void);
static connector_result_t internal_destroy_thread_pool(void);
static connector_result_t internal_enqueue(connector_operation_t *op);
static connector_result_t internal_dequeue(connector_operation_t **op, int timeout_ms);
static void *internal_worker_thread(void *arg);
static connector_result_t internal_process_operation(connector_operation_t *op);
static void internal_update_stats(connector_result_t result, uint64_t latency_us);
static uint64_t internal_now_ms(void);
static void internal_set_error(int code, const char *fmt, ...);
static connector_result_t internal_validate_config(const connector_config_t *config);
static connector_result_t internal_health_check(void);

/* ------------------------------------------------------------------ */
/* IMPLEMENTATION                                                     */
/* ------------------------------------------------------------------ */

connector_result_t connector_init(const connector_config_t *config)
{
    connector_result_t result;

    if (g_ctx.initialized) {
        internal_set_error(CONNECTOR_ERROR_ALREADY_INIT,
            "Connector already initialized. Call connector_shutdown() first.");
        return CONNECTOR_ERROR_ALREADY_INIT;
    }

    if (config == NULL) {
        internal_set_error(CONNECTOR_ERROR_INVALID_PARAM,
            "config parameter is NULL");
        return CONNECTOR_ERROR_INVALID_PARAM;
    }

    result = internal_validate_config(config);
    if (result != CONNECTOR_SUCCESS) {
        return result;
    }

    memset(&g_ctx, 0, sizeof(g_ctx));
    g_ctx.config = *config;
    g_ctx.state = CONNECTOR_STATE_INITIALIZING;
    g_ctx.started_at_ms = internal_now_ms();
    g_ctx.supported_features = CONNECTOR_FEATURE_ENCRYPTION
        | CONNECTOR_FEATURE_COMPRESSION
        | CONNECTOR_FEATURE_CHECKSUM
        | CONNECTOR_FEATURE_RETRY
        | CONNECTOR_FEATURE_TIMEOUT
        | CONNECTOR_FEATURE_RATE_LIMIT
        | CONNECTOR_FEATURE_THROTTLE
        | CONNECTOR_FEATURE_CACHE
        | CONNECTOR_FEATURE_BATCH
        | CONNECTOR_FEATURE_STREAM
        | CONNECTOR_FEATURE_MULTIPLEX
        | CONNECTOR_FEATURE_PRIORITY
        | CONNECTOR_FEATURE_QOS
        | CONNECTOR_FEATURE_METRICS
        | CONNECTOR_FEATURE_TRACING
        | CONNECTOR_FEATURE_COMPRESSION_LEGACY;

    pthread_mutex_init(&g_ctx.state_mutex, NULL);
    pthread_mutex_init(&g_ctx.queue.mutex, NULL);
    pthread_cond_init(&g_ctx.queue.not_empty, NULL);
    pthread_cond_init(&g_ctx.queue.not_full, NULL);

    g_ctx.queue.head = 0;
    g_ctx.queue.tail = 0;
    g_ctx.queue.count = 0;

    if (config->mode != CONNECTOR_MODE_SYNC) {
        result = internal_init_thread_pool();
        if (result != CONNECTOR_SUCCESS) {
            g_ctx.state = CONNECTOR_STATE_ERROR;
            return result;
        }
    }

    g_ctx.state = CONNECTOR_STATE_READY;
    g_ctx.initialized = 1;

    return CONNECTOR_SUCCESS;
}

connector_result_t connector_shutdown(void)
{
    if (!g_ctx.initialized) {
        return CONNECTOR_ERROR_NOT_INIT;
    }

    g_ctx.state = CONNECTOR_STATE_DRAINING;

    /* Wait for queue to drain */
    connector_wait_all(30000);

    g_ctx.state = CONNECTOR_STATE_STOPPED;

    if (g_ctx.worker_count > 0) {
        internal_destroy_thread_pool();
    }

    pthread_mutex_destroy(&g_ctx.queue.mutex);
    pthread_cond_destroy(&g_ctx.queue.not_empty);
    pthread_cond_destroy(&g_ctx.queue.not_full);

    g_ctx.state = CONNECTOR_STATE_DESTROYED;
    g_ctx.initialized = 0;

    return CONNECTOR_SUCCESS;
}

connector_result_t connector_drain(void)
{
    if (!g_ctx.initialized) {
        return CONNECTOR_ERROR_NOT_INIT;
    }

    g_ctx.state = CONNECTOR_STATE_DRAINING;
    return connector_wait_all(g_ctx.config.timeout_ms);
}

connector_result_t connector_get_config(connector_config_t *config)
{
    if (!g_ctx.initialized) {
        return CONNECTOR_ERROR_NOT_INIT;
    }
    if (config == NULL) {
        return CONNECTOR_ERROR_INVALID_PARAM;
    }
    if (config->struct_size < sizeof(connector_config_t)) {
        return CONNECTOR_ERROR_INVALID_PARAM;
    }
    *config = g_ctx.config;
    return CONNECTOR_SUCCESS;
}

connector_result_t connector_set_config(const connector_config_t *config)
{
    if (!g_ctx.initialized) {
        return CONNECTOR_ERROR_NOT_INIT;
    }
    if (config == NULL) {
        return CONNECTOR_ERROR_INVALID_PARAM;
    }

    /* Only allow changing certain fields at runtime */
    if (config->mode != g_ctx.config.mode) {
        return CONNECTOR_ERROR_NOT_SUPPORTED;
    }
    if (config->encoding != g_ctx.config.encoding) {
        return CONNECTOR_ERROR_NOT_SUPPORTED;
    }

    g_ctx.config.timeout_ms = config->timeout_ms;
    g_ctx.config.retry_count = config->retry_count;
    g_ctx.config.retry_backoff_ms = config->retry_backoff_ms;
    g_ctx.config.default_priority = config->default_priority;
    g_ctx.config.compression_level = config->compression_level;
    g_ctx.config.enable_checksum = config->enable_checksum;
    g_ctx.config.enable_audit = config->enable_audit;

    return CONNECTOR_SUCCESS;
}

connector_result_t connector_get_stats(connector_stats_t *stats)
{
    if (stats == NULL) {
        return CONNECTOR_ERROR_INVALID_PARAM;
    }
    if (stats->struct_size < sizeof(connector_stats_t)) {
        return CONNECTOR_ERROR_INVALID_PARAM;
    }

    *stats = g_ctx.stats;
    stats->state = g_ctx.state;
    stats->queue_depth = g_ctx.queue.count;
    stats->last_error_code = g_ctx.last_error;
    memcpy(stats->last_error_message, g_ctx.last_error_msg, ERROR_MESSAGE_BUF_SIZE);

    if (g_ctx.started_at_ms > 0) {
        stats->uptime_seconds = (internal_now_ms() - g_ctx.started_at_ms) / 1000;
    }

    return CONNECTOR_SUCCESS;
}

connector_result_t connector_reset_stats(void)
{
    memset(&g_ctx.stats, 0, sizeof(g_ctx.stats));
    g_ctx.last_error = 0;
    memset(g_ctx.last_error_msg, 0, ERROR_MESSAGE_BUF_SIZE);
    return CONNECTOR_SUCCESS;
}

connector_result_t connector_send(const connector_buffer_t *buffer)
{
    connector_operation_t op;

    if (!g_ctx.initialized) {
        return CONNECTOR_ERROR_NOT_INIT;
    }
    if (buffer == NULL || buffer->data == NULL) {
        return CONNECTOR_ERROR_INVALID_PARAM;
    }
    if (buffer->size > g_ctx.config.max_message_size) {
        return CONNECTOR_ERROR_BUFFER_OVERFLOW;
    }

    memset(&op, 0, sizeof(op));
    op.direction = CONNECTOR_DIRECTION_OUTBOUND;
    op.priority = g_ctx.config.default_priority;
    op.timeout_ms = g_ctx.config.timeout_ms;
    op.buffer = (connector_buffer_t *)buffer;

    if (g_ctx.config.mode == CONNECTOR_MODE_SYNC) {
        uint64_t start = internal_now_ms();
        connector_result_t result = internal_process_operation(&op);
        uint64_t latency = internal_now_ms() - start;
        internal_update_stats(result, latency);
        return result;
    }

    return internal_enqueue(&op);
}

connector_result_t connector_receive(connector_buffer_t *buffer)
{
    connector_operation_t op;

    if (!g_ctx.initialized) {
        return CONNECTOR_ERROR_NOT_INIT;
    }
    if (buffer == NULL || buffer->data == NULL) {
        return CONNECTOR_ERROR_INVALID_PARAM;
    }
    if (buffer->capacity == 0) {
        return CONNECTOR_ERROR_INVALID_PARAM;
    }

    memset(&op, 0, sizeof(op));
    op.direction = CONNECTOR_DIRECTION_INBOUND;
    op.priority = g_ctx.config.default_priority;
    op.timeout_ms = g_ctx.config.timeout_ms;
    op.buffer = buffer;

    if (g_ctx.config.mode == CONNECTOR_MODE_SYNC) {
        uint64_t start = internal_now_ms();
        connector_result_t result = internal_process_operation(&op);
        uint64_t latency = internal_now_ms() - start;
        internal_update_stats(result, latency);
        return result;
    }

    return internal_enqueue(&op);
}

connector_result_t connector_submit(connector_operation_t *operation)
{
    if (!g_ctx.initialized) {
        return CONNECTOR_ERROR_NOT_INIT;
    }
    if (operation == NULL) {
        return CONNECTOR_ERROR_INVALID_PARAM;
    }
    if (g_ctx.config.mode == CONNECTOR_MODE_SYNC) {
        return CONNECTOR_ERROR_NOT_SUPPORTED;
    }
    return internal_enqueue(operation);
}

connector_result_t connector_cancel(uint64_t operation_id)
{
    (void)operation_id;
    /* TODO: Implement operation cancellation */
    return CONNECTOR_ERROR_NOT_IMPLEMENTED;
}

connector_result_t connector_wait_all(uint32_t timeout_ms)
{
    return connector_wait_all_ex(timeout_ms, NULL);
}

connector_result_t connector_wait_all_ex(uint32_t timeout_ms, connector_wait_result_t *result)
{
    uint64_t deadline;
    int unfinished;

    if (!g_ctx.initialized) {
        return CONNECTOR_ERROR_NOT_INIT;
    }

    deadline = internal_now_ms() + timeout_ms;

    /* Poll until queue drains or deadline expires. */
    for (;;) {
        pthread_mutex_lock(&g_ctx.queue.mutex);
        unfinished = g_ctx.queue.count;
        pthread_mutex_unlock(&g_ctx.queue.mutex);

        if (unfinished == 0) {
            break;
        }

        if (timeout_ms > 0 && internal_now_ms() >= deadline) {
            break;
        }

        /* Sleep briefly to avoid busy-spinning. */
        usleep(1000); /* 1 ms */
    }

    /* Count final state. */
    pthread_mutex_lock(&g_ctx.queue.mutex);
    unfinished = g_ctx.queue.count;
    pthread_mutex_unlock(&g_ctx.queue.mutex);

    if (result != NULL) {
        /* Estimate total_pending from stats: operations that were in the
         * queue at call time = current queue + operations that drained
         * during the wait. We approximate total_pending as the sum of
         * completed operations during this wait cycle plus remaining. */
        result->total_pending = (g_ctx.stats.total_operations - g_ctx.stats.failed_operations)
                                + unfinished;
        result->completed = result->total_pending - unfinished;
        result->unfinished = (uint32_t)unfinished;
        result->all_completed = (unfinished == 0) ? 1 : 0;
    }

    return (unfinished == 0) ? CONNECTOR_SUCCESS : CONNECTOR_ERROR_TIMEOUT;
}

connector_buffer_t *connector_buffer_alloc(uint64_t size)
{
    connector_buffer_t *buffer;

    if (size == 0 || size > g_ctx.config.max_message_size) {
        return NULL;
    }

    buffer = (connector_buffer_t *)calloc(1, sizeof(connector_buffer_t));
    if (buffer == NULL) {
        return NULL;
    }

    buffer->data = calloc(1, (size_t)size);
    if (buffer->data == NULL && size > 0) {
        free(buffer);
        return NULL;
    }

    buffer->size = 0;
    buffer->capacity = size;
    buffer->offset = 0;
    buffer->encoding = g_ctx.config.encoding;
    buffer->compression = g_ctx.config.compression;
    buffer->checksum = 0;
    buffer->flags = BUF_FLAG_OWNED;

    return buffer;
}

connector_result_t connector_buffer_free(connector_buffer_t *buffer)
{
    if (buffer == NULL) {
        return CONNECTOR_ERROR_INVALID_PARAM;
    }

    if (buffer->flags & BUF_FLAG_OWNED) {
        if (buffer->data != NULL) {
            free(buffer->data);
        }
        free(buffer);
    }

    return CONNECTOR_SUCCESS;
}

connector_result_t connector_buffer_resize(connector_buffer_t *buffer, uint64_t new_size)
{
    void *new_data;

    if (buffer == NULL) {
        return CONNECTOR_ERROR_INVALID_PARAM;
    }
    if (new_size == 0 || new_size > g_ctx.config.max_message_size) {
        return CONNECTOR_ERROR_INVALID_PARAM;
    }

    if (!(buffer->flags & BUF_FLAG_OWNED)) {
        return CONNECTOR_ERROR_PERMISSION;
    }

    new_data = realloc(buffer->data, (size_t)new_size);
    if (new_data == NULL && new_size > 0) {
        return CONNECTOR_ERROR_OUT_OF_MEMORY;
    }

    buffer->data = new_data;
    buffer->capacity = new_size;
    if (buffer->size > new_size) {
        buffer->size = new_size;
    }

    return CONNECTOR_SUCCESS;
}

connector_result_t connector_buffer_reset(connector_buffer_t *buffer)
{
    if (buffer == NULL) {
        return CONNECTOR_ERROR_INVALID_PARAM;
    }
    buffer->size = 0;
    buffer->offset = 0;
    buffer->checksum = 0;
    return CONNECTOR_SUCCESS;
}

const char *connector_version(void)
{
    return CONNECTOR_API_VERSION_STRING;
}

int connector_has_feature(connector_feature_t feature)
{
    return (g_ctx.supported_features & (uint32_t)feature) != 0;
}

uint32_t connector_supported_features(void)
{
    return g_ctx.supported_features;
}

/* ------------------------------------------------------------------ */
/* LEGACY FUNCTIONS                                                    */
/* ------------------------------------------------------------------ */

connector_result_t connector_init_v1(
    connector_mode_t mode,
    uint32_t timeout_ms,
    uint32_t max_connections)
{
    connector_config_t config;
    memset(&config, 0, sizeof(config));
    config.config_version = CONNECTOR_CONFIG_VERSION;
    config.struct_size = sizeof(config);
    config.mode = mode;
    config.timeout_ms = timeout_ms;
    config.max_concurrency = max_connections;

    /* V1 defaults */
    config.receive_buffer_size = 32768;
    config.send_buffer_size = 32768;
    config.max_message_size = 4194304;
    config.encoding = CONNECTOR_ENCODING_LEGACY;
    config.compression = CONNECTOR_COMPRESSION_LEGACY1;
    config.enable_checksum = 1;

    return connector_init(&config);
}

connector_result_t connector_send_v1(
    const void *data,
    uint64_t size,
    uint32_t timeout_ms)
{
    connector_buffer_t buffer;
    connector_result_t result;

    if (data == NULL || size == 0) {
        return CONNECTOR_ERROR_INVALID_PARAM;
    }

    buffer.data = (void *)data;
    buffer.size = size;
    buffer.capacity = size;
    buffer.offset = 0;
    buffer.encoding = CONNECTOR_ENCODING_LEGACY;
    buffer.compression = CONNECTOR_COMPRESSION_LEGACY1;
    buffer.checksum = 0;
    buffer.flags = 0;
    buffer.owner = 0;

    /* Override timeout for v1 call */
    uint32_t saved_timeout = g_ctx.config.timeout_ms;
    g_ctx.config.timeout_ms = timeout_ms;
    result = connector_send(&buffer);
    g_ctx.config.timeout_ms = saved_timeout;

    return result;
}

connector_result_t connector_receive_v1(
    void *buffer,
    uint64_t *size,
    uint32_t timeout_ms)
{
    connector_buffer_t buf;
    connector_result_t result;

    if (buffer == NULL || size == NULL) {
        return CONNECTOR_ERROR_INVALID_PARAM;
    }

    buf.data = buffer;
    buf.size = 0;
    buf.capacity = *size;
    buf.offset = 0;
    buf.encoding = CONNECTOR_ENCODING_LEGACY;
    buf.compression = CONNECTOR_COMPRESSION_LEGACY1;
    buf.checksum = 0;
    buf.flags = 0;
    buf.owner = 0;

    uint32_t saved_timeout = g_ctx.config.timeout_ms;
    g_ctx.config.timeout_ms = timeout_ms;
    result = connector_receive(&buf);
    g_ctx.config.timeout_ms = saved_timeout;

    if (result == CONNECTOR_SUCCESS) {
        *size = buf.size;
    }

    return result;
}

connector_result_t connector_get_stats_v1(
    uint64_t *uptime,
    uint64_t *operations,
    uint64_t *errors,
    uint64_t *bytes)
{
    connector_stats_t stats;

    if (uptime == NULL || operations == NULL || errors == NULL || bytes == NULL) {
        return CONNECTOR_ERROR_INVALID_PARAM;
    }

    stats.struct_size = sizeof(stats);
    connector_result_t result = connector_get_stats(&stats);
    if (result != CONNECTOR_SUCCESS) {
        return result;
    }

    *uptime = stats.uptime_seconds;
    *operations = stats.total_operations;
    *errors = stats.failed_operations;
    *bytes = stats.bytes_sent + stats.bytes_received;

    return CONNECTOR_SUCCESS;
}

/* ------------------------------------------------------------------ */
/* INTERNAL FUNCTIONS                                                 */
/* ------------------------------------------------------------------ */

static connector_result_t internal_validate_config(const connector_config_t *config)
{
    if (config->config_version != CONNECTOR_CONFIG_VERSION) {
        internal_set_error(CONNECTOR_ERROR_VERSION,
            "Config version mismatch: expected %d, got %d",
            CONNECTOR_CONFIG_VERSION, config->config_version);
        return CONNECTOR_ERROR_VERSION;
    }

    if (config->struct_size < sizeof(connector_config_t)) {
        internal_set_error(CONNECTOR_ERROR_INVALID_PARAM,
            "Config struct size too small");
        return CONNECTOR_ERROR_INVALID_PARAM;
    }

    if (config->timeout_ms == 0) {
        internal_set_error(CONNECTOR_ERROR_INVALID_PARAM,
            "timeout_ms cannot be 0");
        return CONNECTOR_ERROR_INVALID_PARAM;
    }

    if (config->max_concurrency > MAX_WORKER_THREADS) {
        internal_set_error(CONNECTOR_ERROR_INVALID_PARAM,
            "max_concurrency (%d) exceeds maximum (%d)",
            config->max_concurrency, MAX_WORKER_THREADS);
        return CONNECTOR_ERROR_INVALID_PARAM;
    }

    return CONNECTOR_SUCCESS;
}

static connector_result_t internal_init_thread_pool(void)
{
    int count = (int)g_ctx.config.max_concurrency;
    if (count <= 0) count = 1;
    if (count > MAX_WORKER_THREADS) count = MAX_WORKER_THREADS;

    g_ctx.worker_count = count;

    for (int i = 0; i < count; i++) {
        g_ctx.workers[i].id = i;
        g_ctx.workers[i].running = 1;
        g_ctx.workers[i].busy = 0;

        if (pthread_create(&g_ctx.workers[i].thread, NULL,
                internal_worker_thread, &g_ctx.workers[i]) != 0) {
            /* Clean up already created threads */
            for (int j = 0; j < i; j++) {
                g_ctx.workers[j].running = 0;
                pthread_cond_signal(&g_ctx.queue.not_empty);
                pthread_join(g_ctx.workers[j].thread, NULL);
            }
            g_ctx.worker_count = 0;
            internal_set_error(CONNECTOR_ERROR_GENERIC,
                "Failed to create worker thread %d: %s", i, strerror(errno));
            return CONNECTOR_ERROR_GENERIC;
        }
    }

    return CONNECTOR_SUCCESS;
}

static connector_result_t internal_destroy_thread_pool(void)
{
    for (int i = 0; i < g_ctx.worker_count; i++) {
        g_ctx.workers[i].running = 0;
    }

    pthread_cond_broadcast(&g_ctx.queue.not_empty);

    for (int i = 0; i < g_ctx.worker_count; i++) {
        pthread_join(g_ctx.workers[i].thread, NULL);
    }

    g_ctx.worker_count = 0;
    return CONNECTOR_SUCCESS;
}

static connector_result_t internal_enqueue(connector_operation_t *op)
{
    queue_entry_t entry;

    memset(&entry, 0, sizeof(entry));
    entry.operation = op;
    entry.submitted_at_ms = internal_now_ms();
    entry.deadline_ms = entry.submitted_at_ms + op->timeout_ms;
    entry.retries_remaining = (int)g_ctx.config.retry_count;

    pthread_mutex_lock(&g_ctx.queue.mutex);

    while (g_ctx.queue.count >= MAX_QUEUE_DEPTH) {
        struct timespec ts;
        clock_gettime(CLOCK_REALTIME, &ts);
        ts.tv_sec += 1;
        int ret = pthread_cond_timedwait(&g_ctx.queue.not_full,
            &g_ctx.queue.mutex, &ts);
        if (ret == ETIMEDOUT) {
            pthread_mutex_unlock(&g_ctx.queue.mutex);
            return CONNECTOR_ERROR_EXHAUSTED;
        }
    }

    g_ctx.queue.entries[g_ctx.queue.tail] = entry;
    g_ctx.queue.tail = (g_ctx.queue.tail + 1) % MAX_QUEUE_DEPTH;
    g_ctx.queue.count++;

    pthread_cond_signal(&g_ctx.queue.not_empty);
    pthread_mutex_unlock(&g_ctx.queue.mutex);

    return CONNECTOR_SUCCESS;
}

static connector_result_t internal_dequeue(connector_operation_t **op, int timeout_ms)
{
    pthread_mutex_lock(&g_ctx.queue.mutex);

    while (g_ctx.queue.count == 0) {
        if (timeout_ms <= 0) {
            pthread_cond_wait(&g_ctx.queue.not_empty, &g_ctx.queue.mutex);
        } else {
            struct timespec ts;
            clock_gettime(CLOCK_REALTIME, &ts);
            ts.tv_sec += timeout_ms / 1000;
            ts.tv_nsec += (timeout_ms % 1000) * 1000000;
            if (ts.tv_nsec >= 1000000000) {
                ts.tv_sec++;
                ts.tv_nsec -= 1000000000;
            }
            int ret = pthread_cond_timedwait(&g_ctx.queue.not_empty,
                &g_ctx.queue.mutex, &ts);
            if (ret == ETIMEDOUT) {
                pthread_mutex_unlock(&g_ctx.queue.mutex);
                return CONNECTOR_ERROR_TIMEOUT;
            }
        }
    }

    *op = g_ctx.queue.entries[g_ctx.queue.head].operation;
    g_ctx.queue.head = (g_ctx.queue.head + 1) % MAX_QUEUE_DEPTH;
    g_ctx.queue.count--;

    pthread_cond_signal(&g_ctx.queue.not_full);
    pthread_mutex_unlock(&g_ctx.queue.mutex);

    return CONNECTOR_SUCCESS;
}

static void *internal_worker_thread(void *arg)
{
    worker_thread_t *worker = (worker_thread_t *)arg;

    while (worker->running) {
        connector_operation_t *op = NULL;
        connector_result_t result = internal_dequeue(&op, 1000);

        if (result == CONNECTOR_SUCCESS && op != NULL) {
            worker->busy = 1;
            uint64_t start = internal_now_ms();
            connector_result_t op_result = internal_process_operation(op);
            uint64_t latency = internal_now_ms() - start;
            internal_update_stats(op_result, latency);

            if (op_result == CONNECTOR_SUCCESS) {
                worker->operations_processed++;
            } else {
                worker->operations_failed++;
            }
            worker->busy = 0;
        }
    }

    return NULL;
}

static connector_result_t internal_process_operation(connector_operation_t *op)
{
    (void)op;
    /* TODO: Implement actual operation processing.
     * This is a stub that always succeeds for now. The real implementation
     * will involve the actual I/O subsystem which is being rewritten.
     * The stub exists so that the connector API can be tested end-to-end
     * without the I/O subsystem being available. */
    return CONNECTOR_SUCCESS;
}

static void internal_update_stats(connector_result_t result, uint64_t latency_us)
{
    g_ctx.stats.total_operations++;
    if (result == CONNECTOR_SUCCESS) {
        g_ctx.stats.successful_operations++;
    } else {
        g_ctx.stats.failed_operations++;
        if (result == CONNECTOR_ERROR_TIMEOUT) {
            g_ctx.stats.timed_out_operations++;
        }
    }

    if (latency_us > g_ctx.stats.peak_latency_us) {
        g_ctx.stats.peak_latency_us = latency_us;
    }

    g_ctx.stats.average_latency_us =
        (g_ctx.stats.average_latency_us * 9 + latency_us) / 10;
}

static uint64_t internal_now_ms(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (uint64_t)tv.tv_sec * 1000 + (uint64_t)tv.tv_usec / 1000;
}

static void internal_set_error(int code, const char *fmt, ...)
{
    va_list args;
    g_ctx.last_error = code;
    va_start(args, fmt);
    vsnprintf(g_ctx.last_error_msg, ERROR_MESSAGE_BUF_SIZE - 1, fmt, args);
    va_end(args);
}
