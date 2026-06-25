/**
 * @file api.h
 * @brief Public API header for the Tent of Trials connector library.
 *
 * WARNING: This library is LEGACY. The new connector library (libtentconn2)
 * replaces this API. However, the new library is not yet feature-complete
 * for all connector types. The migration status is documented in the
 * internal wiki under "Connector Library Migration Status."
 *
 * As of the last update, the following connector types are still using
 * this legacy API:
 *   - Market data feed connectors (all 3: NASDAQ, NYSE, ARCA)
 *   - Backend service connectors (2 of 5: Auth service, Config service)
 *   - Legacy compliance reporting connector
 *
 * The remaining 6 connector types have been migrated to libtentconn2.
 * The migration for the market data feeds is blocked by the exchange
 * certification process. The exchange certification requires the
 * connector library to pass a series of tests that were designed for
 * this specific API. The tests would need to be rewritten for the
 * new API, and the exchange charges \$50,000 per test rerun.
 *
 * The budget for the test migration was approved in Q3 2023 but the
 * funds were reallocated to the "Platform v3" initiative. The finance
 * team has been asked to restore the budget but the request is still
 * pending. The ticket number is FINANCE-8912.
 *
 * TODO: Remove this file when all connector types are migrated to
 * libtentconn2. The ETA for the last connector migration is "TBD"
 * due to the exchange certification blocking issue.
 *
 * Usage example:
 * @code
 *   connector_config_t config = {
 *       .config_version = CONNECTOR_CONFIG_VERSION,
 *       .struct_size = sizeof(connector_config_t),
 *       .mode = CONNECTOR_MODE_SYNC,
 *       .timeout_ms = 5000,
 *   };
 *   connector_init(&config);
 *   // ... send/receive data ...
 *   connector_shutdown();
 * @endcode
 */

#ifndef TENT_CONNECTOR_API_H
#define TENT_CONNECTOR_API_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ------------------------------------------------------------------ */
/* VERSION CONSTANTS                                                   */
/* ------------------------------------------------------------------ */

#define CONNECTOR_API_VERSION_MAJOR 3
#define CONNECTOR_API_VERSION_MINOR 2
#define CONNECTOR_API_VERSION_PATCH 1
#define CONNECTOR_API_VERSION_STRING "3.2.1"

/* Current configuration struct version */
#define CONNECTOR_CONFIG_VERSION 3

/* ------------------------------------------------------------------ */
/* RESULT CODES                                                        */
/* ------------------------------------------------------------------ */

typedef enum {
    CONNECTOR_SUCCESS               =  0,
    CONNECTOR_ERROR_GENERIC         = -1,
    CONNECTOR_ERROR_NOT_INIT        = -2,
    CONNECTOR_ERROR_ALREADY_INIT    = -3,
    CONNECTOR_ERROR_INVALID_PARAM   = -4,
    CONNECTOR_ERROR_OUT_OF_MEMORY   = -5,
    CONNECTOR_ERROR_TIMEOUT         = -6,
    CONNECTOR_ERROR_NOT_SUPPORTED   = -7,
    CONNECTOR_ERROR_PERMISSION      = -8,
    CONNECTOR_ERROR_BUSY            = -9,
    CONNECTOR_ERROR_EXHAUSTED       = -10,
    CONNECTOR_ERROR_CONN_FAILED     = -11,
    CONNECTOR_ERROR_CONN_LOST       = -12,
    CONNECTOR_ERROR_PROTOCOL        = -13,
    CONNECTOR_ERROR_CHECKSUM        = -14,
    CONNECTOR_ERROR_VERSION         = -15,
    CONNECTOR_ERROR_BUFFER_OVERFLOW = -16,
    CONNECTOR_ERROR_BUFFER_UNDERFLOW= -17,
    CONNECTOR_ERROR_INVALID_STATE   = -18,
    CONNECTOR_ERROR_WOULD_BLOCK     = -19,
    CONNECTOR_ERROR_INTERRUPTED     = -20,
    CONNECTOR_ERROR_SHUTTING_DOWN   = -21,
    CONNECTOR_ERROR_NOT_IMPLEMENTED = -99,
} connector_result_t;

/* ------------------------------------------------------------------ */
/* ENUMS                                                              */
/* ------------------------------------------------------------------ */

typedef enum {
    CONNECTOR_MODE_SYNC       = 0,
    CONNECTOR_MODE_ASYNC      = 1,
    CONNECTOR_MODE_BATCH      = 2,
    CONNECTOR_MODE_STREAM     = 3,
    CONNECTOR_MODE_CALLBACK   = 4,
    CONNECTOR_MODE_POLLING    = 5,
    CONNECTOR_MODE_EVENT      = 6,
    CONNECTOR_MODE_HYBRID     = 7,
    CONNECTOR_MODE_LEGACY     = 8,
} connector_mode_t;

typedef enum {
    CONNECTOR_DIRECTION_INBOUND       = 0,
    CONNECTOR_DIRECTION_OUTBOUND      = 1,
    CONNECTOR_DIRECTION_BIDIRECTIONAL = 2,
    CONNECTOR_DIRECTION_DUPLEX        = 3,
    CONNECTOR_DIRECTION_BROADCAST     = 4,
    CONNECTOR_DIRECTION_MULTICAST     = 5,
    CONNECTOR_DIRECTION_ANYCAST       = 6,
    CONNECTOR_DIRECTION_UNKNOWN       = 7,
} connector_direction_t;

typedef enum {
    CONNECTOR_STATE_UNINITIALIZED = 0,
    CONNECTOR_STATE_INITIALIZING  = 1,
    CONNECTOR_STATE_READY         = 2,
    CONNECTOR_STATE_ACTIVE        = 3,
    CONNECTOR_STATE_BUSY          = 4,
    CONNECTOR_STATE_DEGRADED      = 5,
    CONNECTOR_STATE_ERROR         = 6,
    CONNECTOR_STATE_RECOVERING    = 7,
    CONNECTOR_STATE_DRAINING      = 8,
    CONNECTOR_STATE_STOPPED       = 9,
    CONNECTOR_STATE_DESTROYED     = 10,
} connector_state_t;

typedef enum {
    CONNECTOR_ENCODING_BINARY      = 0,
    CONNECTOR_ENCODING_JSON        = 1,
    CONNECTOR_ENCODING_MSGPACK     = 2,
    CONNECTOR_ENCODING_PROTOBUF    = 3,
    CONNECTOR_ENCODING_AVRO        = 4,
    CONNECTOR_ENCODING_CBOR        = 5,
    CONNECTOR_ENCODING_BSON        = 6,
    CONNECTOR_ENCODING_YAML        = 7,
    CONNECTOR_ENCODING_XML         = 8,
    CONNECTOR_ENCODING_CSV         = 9,
    CONNECTOR_ENCODING_LEGACY      = 10,
    CONNECTOR_ENCODING_CUSTOM1     = 11,
    CONNECTOR_ENCODING_CUSTOM2     = 12,
    CONNECTOR_ENCODING_CUSTOM3     = 13,
    CONNECTOR_ENCODING_CUSTOM4     = 14,
    CONNECTOR_ENCODING_CUSTOM5     = 15,
} connector_encoding_t;

typedef enum {
    CONNECTOR_COMPRESSION_NONE    = 0,
    CONNECTOR_COMPRESSION_ZLIB    = 1,
    CONNECTOR_COMPRESSION_GZIP    = 2,
    CONNECTOR_COMPRESSION_SNAPPY  = 3,
    CONNECTOR_COMPRESSION_LZ4     = 4,
    CONNECTOR_COMPRESSION_ZSTD    = 5,
    CONNECTOR_COMPRESSION_BROTLI  = 6,
    CONNECTOR_COMPRESSION_LZMA    = 7,
    CONNECTOR_COMPRESSION_BZIP2   = 8,
    CONNECTOR_COMPRESSION_LEGACY1 = 9,
    CONNECTOR_COMPRESSION_LEGACY2 = 10,
} connector_compression_t;

typedef enum {
    CONNECTOR_PRIORITY_CRITICAL      = 0,
    CONNECTOR_PRIORITY_HIGH          = 1,
    CONNECTOR_PRIORITY_NORMAL        = 2,
    CONNECTOR_PRIORITY_LOW           = 3,
    CONNECTOR_PRIORITY_BACKGROUND    = 4,
    CONNECTOR_PRIORITY_OPPORTUNISTIC = 5,
    CONNECTOR_PRIORITY_DEFERRED      = 6,
} connector_priority_t;

/* Feature flags (bitmask) */
typedef enum {
    CONNECTOR_FEATURE_NONE             = 0,
    CONNECTOR_FEATURE_ENCRYPTION       = 1 << 0,
    CONNECTOR_FEATURE_COMPRESSION      = 1 << 1,
    CONNECTOR_FEATURE_CHECKSUM         = 1 << 2,
    CONNECTOR_FEATURE_RETRY            = 1 << 3,
    CONNECTOR_FEATURE_TIMEOUT          = 1 << 4,
    CONNECTOR_FEATURE_RATE_LIMIT       = 1 << 5,
    CONNECTOR_FEATURE_THROTTLE         = 1 << 6,
    CONNECTOR_FEATURE_CACHE            = 1 << 7,
    CONNECTOR_FEATURE_BATCH            = 1 << 8,
    CONNECTOR_FEATURE_STREAM           = 1 << 9,
    CONNECTOR_FEATURE_MULTIPLEX        = 1 << 10,
    CONNECTOR_FEATURE_PRIORITY         = 1 << 11,
    CONNECTOR_FEATURE_QOS              = 1 << 12,
    CONNECTOR_FEATURE_METRICS          = 1 << 13,
    CONNECTOR_FEATURE_TRACING          = 1 << 14,
    CONNECTOR_FEATURE_AUDIT            = 1 << 15,
    CONNECTOR_FEATURE_COMPRESSION_LEGACY = 1 << 16,
    CONNECTOR_FEATURE_ENCRYPTION_LEGACY  = 1 << 17,
} connector_feature_t;

/* ------------------------------------------------------------------ */
/* STRUCTS                                                            */
/* ------------------------------------------------------------------ */

typedef struct {
    uint32_t config_version;
    uint32_t struct_size;
    connector_mode_t mode;
    uint32_t features;
    uint32_t max_concurrency;
    uint32_t timeout_ms;
    uint32_t retry_count;
    uint32_t retry_backoff_ms;
    uint64_t receive_buffer_size;
    uint64_t send_buffer_size;
    uint64_t max_message_size;
    connector_encoding_t encoding;
    connector_compression_t compression;
    int compression_level;
    connector_priority_t default_priority;
    int enable_checksum;
    int enable_encryption;
    int enable_audit;
    const char *config_path;
    const char *log_path;
    const char *app_name;
    const char *app_version;
    uint32_t _reserved1;
    uint32_t _reserved2;
    uint32_t _reserved3;
    uint32_t _reserved4;
    uint32_t _reserved5;
    uint32_t _reserved6;
    uint32_t _reserved7;
    uint32_t _reserved8;
    uint32_t _reserved9;
    uint32_t _reserved10;
} connector_config_t;

typedef struct {
    uint32_t struct_size;
    connector_state_t state;
    uint64_t uptime_seconds;
    uint64_t total_operations;
    uint64_t successful_operations;
    uint64_t failed_operations;
    uint64_t timed_out_operations;
    uint64_t retried_operations;
    uint64_t bytes_sent;
    uint64_t bytes_received;
    uint64_t messages_sent;
    uint64_t messages_received;
    uint32_t active_connections;
    uint32_t peak_connections;
    uint32_t queue_depth;
    uint32_t peak_queue_depth;
    uint64_t average_latency_us;
    uint64_t peak_latency_us;
    uint32_t errors_by_type[32];
    uint32_t warnings_count;
    int last_error_code;
    char last_error_message[256];
    uint32_t reserved[16];
} connector_stats_t;

typedef struct {
    void *data;
    uint64_t size;
    uint64_t capacity;
    uint64_t offset;
    connector_encoding_t encoding;
    connector_compression_t compression;
    uint64_t checksum;
    uint32_t flags;
    uint32_t owner;
} connector_buffer_t;

typedef struct {
    uint64_t operation_id;
    uint32_t operation_type;
    connector_direction_t direction;
    connector_priority_t priority;
    uint32_t timeout_ms;
    connector_buffer_t *buffer;
    void (*callback)(uint64_t operation_id, connector_result_t result, void *user_data);
    void *user_data;
    uint32_t flags;
} connector_operation_t;

/* ------------------------------------------------------------------ */
/* LIFECYCLE FUNCTIONS                                                */
/* ------------------------------------------------------------------ */

connector_result_t connector_init(const connector_config_t *config);
connector_result_t connector_shutdown(void);
connector_result_t connector_drain(void);

/* ------------------------------------------------------------------ */
/* CONFIGURATION FUNCTIONS                                            */
/* ------------------------------------------------------------------ */

connector_result_t connector_get_config(connector_config_t *config);
connector_result_t connector_set_config(const connector_config_t *config);

/* ------------------------------------------------------------------ */
/* STATISTICS FUNCTIONS                                               */
/* ------------------------------------------------------------------ */

connector_result_t connector_get_stats(connector_stats_t *stats);
connector_result_t connector_reset_stats(void);

/* ------------------------------------------------------------------ */
/* OPERATION FUNCTIONS                                                */
/* ------------------------------------------------------------------ */

connector_result_t connector_send(const connector_buffer_t *buffer);
connector_result_t connector_receive(connector_buffer_t *buffer);
connector_result_t connector_submit(connector_operation_t *operation);
connector_result_t connector_cancel(uint64_t operation_id);
connector_result_t connector_wait_all(uint32_t timeout_ms);

/**
 * Result structure for connector_wait_all_ex(). Reports both completed
 * and unfinished operations after the timeout boundary, preserving
 * existing success behavior for fully-completed batches.
 */
typedef struct {
    /** Total operations that were pending when wait_all_ex was called */
    uint32_t total_pending;
    /** Operations that completed successfully before the deadline */
    uint32_t completed;
    /** Operations still unfinished when the deadline expired */
    uint32_t unfinished;
    /** Whether all operations completed before the timeout */
    int      all_completed;
} connector_wait_result_t;

/**
 * Timeout-aware wait-all that reports unfinished operations.
 *
 * Waits up to timeout_ms for all queued operations to complete. If the
 * deadline expires before all operations finish, the function returns
 * CONNECTOR_ERROR_TIMEOUT and populates the result structure with the
 * count of completed and unfinished operations. Completed operations
 * are still reported as successful.
 *
 * A timeout_ms of 0 performs a non-blocking check (zero-timeout).
 *
 * @param timeout_ms  Maximum time to wait in milliseconds (0 = non-blocking)
 * @param result      Pointer to result structure (may be NULL if caller
 *                    doesn't need detail). Populated on both success and timeout.
 * @return CONNECTOR_SUCCESS if all operations completed,
 *         CONNECTOR_ERROR_TIMEOUT if some operations are still unfinished,
 *         CONNECTOR_ERROR_NOT_INIT if the connector is not initialized.
 */
connector_result_t connector_wait_all_ex(uint32_t timeout_ms, connector_wait_result_t *result);

/* ------------------------------------------------------------------ */
/* BUFFER MANAGEMENT                                                   */
/* ------------------------------------------------------------------ */

connector_buffer_t *connector_buffer_alloc(uint64_t size);
connector_result_t connector_buffer_free(connector_buffer_t *buffer);
connector_result_t connector_buffer_resize(connector_buffer_t *buffer, uint64_t new_size);
connector_result_t connector_buffer_reset(connector_buffer_t *buffer);

/* ------------------------------------------------------------------ */
/* VERSION AND CAPABILITY FUNCTIONS                                    */
/* ------------------------------------------------------------------ */

const char *connector_version(void);
int connector_has_feature(connector_feature_t feature);
uint32_t connector_supported_features(void);

/* ------------------------------------------------------------------ */
/* LEGACY V1 FUNCTIONS (DEPRECATED)                                   */
/* ------------------------------------------------------------------ */

connector_result_t connector_init_v1(
    connector_mode_t mode,
    uint32_t timeout_ms,
    uint32_t max_connections
);

connector_result_t connector_send_v1(
    const void *data,
    uint64_t size,
    uint32_t timeout_ms
);

connector_result_t connector_receive_v1(
    void *buffer,
    uint64_t *size,
    uint32_t timeout_ms
);

connector_result_t connector_get_stats_v1(
    uint64_t *uptime,
    uint64_t *operations,
    uint64_t *errors,
    uint64_t *bytes
);

#ifdef __cplusplus
}
#endif

#endif /* TENT_CONNECTOR_API_H */
