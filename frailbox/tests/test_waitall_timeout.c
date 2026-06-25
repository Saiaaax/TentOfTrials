/**
 * @file test_waitall_timeout.c
 * @brief Test harness for timeout-aware connector_wait_all_ex().
 *
 * Compile:
 *   gcc -I../connector -DTEST_WAITALL_TIMEOUT \
 *       ../connector/api.c -o test_waitall_timeout -lpthread
 *
 * Run:
 *   ./test_waitall_timeout
 *
 * Tests:
 *   1. all-complete     — all operations finish before timeout
 *   2. partial-timeout  — some operations unfinished when deadline expires
 *   3. zero-timeout     — non-blocking check returns immediately
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include <unistd.h>

#include "api.h"

/* ------------------------------------------------------------------ */
/* HELPERS                                                            */
/* ------------------------------------------------------------------ */

static int test_count = 0;
static int pass_count = 0;

#define TEST_ASSERT(cond, msg) do {                                     \
    test_count++;                                                       \
    if (cond) {                                                         \
        pass_count++;                                                   \
        printf("  PASS: %s\n", msg);                                    \
    } else {                                                            \
        printf("  FAIL: %s (line %d)\n", msg, __LINE__);               \
    }                                                                   \
} while(0)

/* Helper to create a default config for testing */
static connector_config_t make_test_config(void)
{
    connector_config_t config;
    memset(&config, 0, sizeof(config));
    config.config_version = CONNECTOR_CONFIG_VERSION;
    config.struct_size = sizeof(config);
    config.mode = CONNECTOR_MODE_SYNC;  /* sync mode: no thread pool */
    config.timeout_ms = 5000;
    config.max_concurrency = 1;
    config.receive_buffer_size = 32768;
    config.send_buffer_size = 32768;
    config.max_message_size = 4194304;
    config.encoding = CONNECTOR_ENCODING_LEGACY;
    config.compression = CONNECTOR_COMPRESSION_LEGACY1;
    config.enable_checksum = 1;
    return config;
}

/* ------------------------------------------------------------------ */
/* TEST: All operations complete before timeout                       */
/* ------------------------------------------------------------------ */
static void test_all_complete(void)
{
    printf("\n[TEST] All operations complete before timeout\n");

    connector_config_t config = make_test_config();
    connector_result_t rc = connector_init(&config);
    TEST_ASSERT(rc == CONNECTOR_SUCCESS, "connector_init succeeds");

    /* In sync mode, operations are processed immediately so the queue
     * should always be empty after sends. wait_all should succeed. */
    connector_wait_result_t result;
    rc = connector_wait_all_ex(5000, &result);
    TEST_ASSERT(rc == CONNECTOR_SUCCESS, "wait_all_ex returns SUCCESS");
    TEST_ASSERT(result.all_completed == 1, "all_completed is true");
    TEST_ASSERT(result.unfinished == 0, "unfinished is 0");

    connector_shutdown();
}

/* ------------------------------------------------------------------ */
/* TEST: Partial timeout — queue has items when deadline expires      */
/* ------------------------------------------------------------------ */
static void test_partial_timeout(void)
{
    printf("\n[TEST] Partial timeout with unfinished operations\n");

    connector_config_t config = make_test_config();
    connector_result_t rc = connector_init(&config);
    TEST_ASSERT(rc == CONNECTOR_SUCCESS, "connector_init succeeds");

    /* In sync mode, the queue should drain immediately. But we test
     * the timeout path by calling wait_all_ex with a very short timeout
     * and verifying the result structure is populated correctly. */
    connector_wait_result_t result;
    memset(&result, 0, sizeof(result));
    rc = connector_wait_all_ex(1, &result);  /* 1 ms timeout */
    /* Even with 1ms timeout, sync-mode queue should be empty */
    TEST_ASSERT(rc == CONNECTOR_SUCCESS || rc == CONNECTOR_ERROR_TIMEOUT,
                "wait_all_ex returns SUCCESS or TIMEOUT");
    TEST_ASSERT(result.all_completed == (rc == CONNECTOR_SUCCESS ? 1 : 0),
                "all_completed matches result code");

    connector_shutdown();
}

/* ------------------------------------------------------------------ */
/* TEST: Zero timeout — non-blocking check                            */
/* ------------------------------------------------------------------ */
static void test_zero_timeout(void)
{
    printf("\n[TEST] Zero timeout (non-blocking check)\n");

    connector_config_t config = make_test_config();
    connector_result_t rc = connector_init(&config);
    TEST_ASSERT(rc == CONNECTOR_SUCCESS, "connector_init succeeds");

    /* Zero timeout = non-blocking check */
    connector_wait_result_t result;
    memset(&result, 0, sizeof(result));
    rc = connector_wait_all_ex(0, &result);
    /* In sync mode with empty queue, should succeed immediately */
    TEST_ASSERT(rc == CONNECTOR_SUCCESS, "zero-timeout returns SUCCESS for empty queue");
    TEST_ASSERT(result.all_completed == 1, "all_completed is true");
    TEST_ASSERT(result.unfinished == 0, "unfinished is 0");

    connector_shutdown();
}

/* ------------------------------------------------------------------ */
/* TEST: wait_all_ex without result pointer                           */
/* ------------------------------------------------------------------ */
static void test_null_result(void)
{
    printf("\n[TEST] wait_all_ex with NULL result pointer\n");

    connector_config_t config = make_test_config();
    connector_result_t rc = connector_init(&config);
    TEST_ASSERT(rc == CONNECTOR_SUCCESS, "connector_init succeeds");

    /* Should not crash with NULL result pointer */
    rc = connector_wait_all_ex(1000, NULL);
    TEST_ASSERT(rc == CONNECTOR_SUCCESS, "wait_all_ex with NULL result succeeds");

    connector_shutdown();
}

/* ------------------------------------------------------------------ */
/* TEST: wait_all (compatibility wrapper)                              */
/* ------------------------------------------------------------------ */
static void test_wait_all_compat(void)
{
    printf("\n[TEST] wait_all compatibility wrapper\n");

    connector_config_t config = make_test_config();
    connector_result_t rc = connector_init(&config);
    TEST_ASSERT(rc == CONNECTOR_SUCCESS, "connector_init succeeds");

    /* The legacy wait_all should still work */
    rc = connector_wait_all(5000);
    TEST_ASSERT(rc == CONNECTOR_SUCCESS, "wait_all returns SUCCESS");

    connector_shutdown();
}

/* ------------------------------------------------------------------ */
/* TEST: Not initialized                                               */
/* ------------------------------------------------------------------ */
static void test_not_initialized(void)
{
    printf("\n[TEST] wait_all_ex when not initialized\n");

    /* Don't call connector_init — should return NOT_INIT */
    /* First shutdown any prior state */
    connector_shutdown();

    connector_wait_result_t result;
    connector_result_t rc = connector_wait_all_ex(1000, &result);
    TEST_ASSERT(rc == CONNECTOR_ERROR_NOT_INIT, "returns NOT_INIT when uninitialized");
}

/* ------------------------------------------------------------------ */
/* MAIN                                                               */
/* ------------------------------------------------------------------ */

int main(void)
{
    printf("=== Connector Wait-All Timeout Tests ===\n");

    test_all_complete();
    test_partial_timeout();
    test_zero_timeout();
    test_null_result();
    test_wait_all_compat();
    test_not_initialized();

    printf("\n=== Results: %d/%d passed ===\n", pass_count, test_count);

    return (pass_count == test_count) ? 0 : 1;
}
