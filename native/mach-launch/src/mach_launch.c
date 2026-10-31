// mach_launch — a driven turn's launch hand-over over raw Mach (O4b, packet B' step 1).
//
// Two halves, one wire format:
//
// - The daemon side checks in the launchd-declared service name (`bootstrap_check_in`), receives on a
//   thread of its own so the Node event loop never waits on Mach, reads the audit token the kernel
//   attaches to each message (MACH_RCV_TRAILER_AUDIT), and hands each request to JavaScript through a
//   thread-safe function. JavaScript answers with `respond`. `close` stops the thread, answers every
//   request still held or still queued with STOPPING, and destroys every right this side holds.
// - The relay side (`claim`) looks the name up, sends one request carrying a send-once reply right it
//   alone holds, and waits for the answer for at most its timeout, off the event loop.
//
// There is no other transport here and nothing to fall back to: every failure is a named code.
// Darwin only — Mach ports, the bootstrap server and audit tokens have no equivalent elsewhere.
#ifndef __APPLE__
#error "mach_launch.c is Darwin-only; it must not be built or loaded on other platforms"
#endif

#include <node_api.h>

#include <bsm/libbsm.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach/notify.h>
#include <pthread.h>
#include <servers/bootstrap.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <time.h>

#define ML_REQUEST_ID 0x41434d31u /* "ACM1" */
#define ML_REPLY_ID 0x41434d32u
#define ML_STOP_ID 0x41434d33u
#define ML_MAX_BODY 8192u
#define ML_MAX_PENDING 64u
#define ML_MAX_DRAIN 1024u
#define ML_MAX_TIMEOUT_MS 600000u

enum { ML_OK = 0, ML_REFUSED = 1, ML_STOPPING = 2, ML_BUSY = 3, ML_MALFORMED = 4 };

typedef struct {
  mach_msg_header_t header;
  uint32_t status; /* a reply's status; zero in a request */
  uint32_t length; /* meaningful bytes of body */
  uint8_t body[ML_MAX_BODY];
} ml_message_t;

#define ML_FIXED_SIZE ((mach_msg_size_t)offsetof(ml_message_t, body))

typedef struct {
  ml_message_t message;
  uint8_t trailer[MAX_TRAILER_SIZE];
} ml_receive_buffer_t;

static mach_msg_size_t ml_wire_size(uint32_t length) { return ML_FIXED_SIZE + ((length + 3u) & ~3u); }

static uint64_t ml_now_ms(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000000ull; }

// The audit trailer sits after the message, at its rounded size. The kernel wrote it only if the
// receive asked for it and the buffer had room, so both are checked rather than assumed.
static const mach_msg_audit_trailer_t *ml_audit_trailer(const ml_receive_buffer_t *buffer) {
  const mach_msg_header_t *header = &buffer->message.header;
  size_t offset = round_msg(header->msgh_size);
  if (offset + sizeof(mach_msg_audit_trailer_t) > sizeof *buffer) return NULL;
  const mach_msg_audit_trailer_t *trailer = (const void *)((const uint8_t *)header + offset);
  if (trailer->msgh_trailer_type != MACH_MSG_TRAILER_FORMAT_0 ||
      trailer->msgh_trailer_size < sizeof(mach_msg_audit_trailer_t)) {
    return NULL;
  }
  return trailer;
}

// A request's body is well formed when its length fits both the cap and what was actually sent.
static int ml_body_fits(const ml_message_t *message) {
  mach_msg_size_t size = message->header.msgh_size;
  return size >= ML_FIXED_SIZE && message->length <= ML_MAX_BODY && ML_FIXED_SIZE + message->length <= size;
}

// Answers one request on its send-once right. The right is consumed by a successful send; a send to
// a right whose receiver has gone fails MACH_SEND_INVALID_DEST and leaves a dead name, released here.
// A send-once destination is never subject to a queue limit, so this send does not block.
static kern_return_t ml_send_reply(mach_port_t reply, uint32_t status, const uint8_t *body, uint32_t length) {
  ml_message_t *message = calloc(1, sizeof *message);
  if (message == NULL) {
    mach_port_deallocate(mach_task_self(), reply);
    return KERN_RESOURCE_SHORTAGE;
  }
  if (length > ML_MAX_BODY) length = 0;
  message->header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_MOVE_SEND_ONCE, 0);
  message->header.msgh_size = ml_wire_size(length);
  message->header.msgh_remote_port = reply;
  message->header.msgh_local_port = MACH_PORT_NULL;
  message->header.msgh_id = ML_REPLY_ID;
  message->status = status;
  message->length = length;
  if (length > 0) memcpy(message->body, body, length);
  kern_return_t kr = mach_msg(&message->header, MACH_SEND_MSG, message->header.msgh_size, 0, MACH_PORT_NULL,
                              MACH_MSG_TIMEOUT_NONE, MACH_PORT_NULL);
  if (kr != KERN_SUCCESS) {
    mach_port_type_t type = 0;
    if (mach_port_type(mach_task_self(), reply, &type) == KERN_SUCCESS &&
        (type & (MACH_PORT_TYPE_SEND_ONCE | MACH_PORT_TYPE_DEAD_NAME)) != 0) {
      mach_port_deallocate(mach_task_self(), reply);
    }
  }
  free(message);
  return kr;
}

// A received message this side will not answer: every right it carried is released.
static void ml_discard(mach_msg_header_t *header) { mach_msg_destroy(header); }

// A received request whose reply right is usable: a send-once right, valid, and nothing else carried.
static int ml_is_answerable_request(const mach_msg_header_t *header) {
  return (header->msgh_bits & MACH_MSGH_BITS_COMPLEX) == 0 && header->msgh_id == ML_REQUEST_ID &&
         MACH_MSGH_BITS_REMOTE(header->msgh_bits) == MACH_MSG_TYPE_PORT_SEND_ONCE &&
         MACH_PORT_VALID(header->msgh_remote_port);
}

// ---------------------------------------------------------------------------------------------------
// Daemon side
// ---------------------------------------------------------------------------------------------------

typedef struct ml_pending {
  uint32_t id;
  mach_port_t reply;
  struct ml_pending *next;
} ml_pending_t;

typedef struct {
  napi_env env;
  mach_port_t service; /* the receive right bootstrap_check_in returned */
  mach_port_t control; /* receive right plus one send right: how close() wakes the thread */
  mach_port_t set;     /* the port set the thread receives on */
  pthread_t thread;
  int thread_started;
  napi_threadsafe_function tsfn;
  pthread_mutex_t lock;
  ml_pending_t *pending; /* guarded by lock */
  uint32_t pending_count;
  uint32_t next_id;
  int stopping;      /* guarded by lock */
  int closed;        /* JS thread only */
  int hook_added;    /* JS thread only */
  int in_hook;       /* JS thread only */
  uint32_t received; /* receiver thread only, read after join */
  uint32_t discarded;
} ml_service_t;

typedef struct {
  uint32_t id;
  uint32_t length;
  uint8_t *body;
  audit_token_t token;
  int live;
} ml_delivery_t;

// Takes one pending entry out of the table; the caller then owns its reply right.
static ml_pending_t *ml_take_pending(ml_service_t *service, uint32_t id) {
  pthread_mutex_lock(&service->lock);
  ml_pending_t **link = &service->pending;
  while (*link != NULL && (*link)->id != id) link = &(*link)->next;
  ml_pending_t *found = *link;
  if (found != NULL) {
    *link = found->next;
    service->pending_count--;
  }
  pthread_mutex_unlock(&service->lock);
  return found;
}

static void ml_call_js(napi_env env, napi_value callback, void *context, void *data) {
  (void)context;
  ml_delivery_t *delivery = data;
  if (env != NULL && callback != NULL) {
    napi_value request, value, sender, undefined;
    napi_create_object(env, &request);
    napi_create_uint32(env, delivery->id, &value);
    napi_set_named_property(env, request, "id", value);
    void *copy = NULL;
    napi_create_buffer_copy(env, delivery->length, delivery->body, &copy, &value);
    napi_set_named_property(env, request, "body", value);
    napi_create_buffer_copy(env, sizeof delivery->token, &delivery->token, &copy, &value);
    napi_set_named_property(env, request, "token", value);
    napi_get_boolean(env, delivery->live, &value);
    napi_set_named_property(env, request, "live", value);
    napi_create_object(env, &sender);
    const struct { const char *name; int64_t value; } fields[] = {
        {"pid", audit_token_to_pid(delivery->token)},     {"pidversion", audit_token_to_pidversion(delivery->token)},
        {"euid", audit_token_to_euid(delivery->token)},   {"egid", audit_token_to_egid(delivery->token)},
        {"ruid", audit_token_to_ruid(delivery->token)},   {"rgid", audit_token_to_rgid(delivery->token)},
        {"auid", audit_token_to_auid(delivery->token)},   {"asid", audit_token_to_asid(delivery->token)},
    };
    for (size_t i = 0; i < sizeof fields / sizeof fields[0]; i++) {
      napi_create_int64(env, fields[i].value, &value);
      napi_set_named_property(env, sender, fields[i].name, value);
    }
    napi_set_named_property(env, request, "sender", sender);
    napi_get_undefined(env, &undefined);
    napi_call_function(env, undefined, callback, 1, &request, NULL);
  }
  free(delivery->body);
  free(delivery);
}

static void ml_handle_request(ml_service_t *service, ml_receive_buffer_t *buffer) {
  mach_msg_header_t *header = &buffer->message.header;
  if (!ml_is_answerable_request(header)) {
    service->discarded++;
    ml_discard(header);
    return;
  }
  mach_port_t reply = header->msgh_remote_port;
  const mach_msg_audit_trailer_t *trailer = ml_audit_trailer(buffer);
  if (!ml_body_fits(&buffer->message) || trailer == NULL) {
    ml_send_reply(reply, ML_MALFORMED, NULL, 0);
    return;
  }
  // Read here, beside the receive, so the caller learns whether the token's process was still that
  // instance as close to delivery as this side can observe it.
  char path[PROC_PIDPATHINFO_MAXSIZE];
  audit_token_t token = trailer->msgh_audit;
  int live = proc_pidpath_audittoken(&token, path, sizeof path) > 0;

  ml_pending_t *entry = calloc(1, sizeof *entry);
  ml_delivery_t *delivery = calloc(1, sizeof *delivery);
  uint8_t *body = malloc(buffer->message.length > 0 ? buffer->message.length : 1);
  if (entry == NULL || delivery == NULL || body == NULL) {
    free(entry), free(delivery), free(body);
    ml_send_reply(reply, ML_BUSY, NULL, 0);
    return;
  }
  pthread_mutex_lock(&service->lock);
  int refusal = service->stopping ? ML_STOPPING : service->pending_count >= ML_MAX_PENDING ? ML_BUSY : ML_OK;
  if (refusal == ML_OK) {
    if (++service->next_id == 0) service->next_id = 1;
    entry->id = service->next_id;
    entry->reply = reply;
    entry->next = service->pending;
    service->pending = entry;
    service->pending_count++;
  }
  pthread_mutex_unlock(&service->lock);
  if (refusal != ML_OK) {
    free(entry), free(delivery), free(body);
    ml_send_reply(reply, (uint32_t)refusal, NULL, 0);
    return;
  }
  memcpy(body, buffer->message.body, buffer->message.length);
  delivery->id = entry->id;
  delivery->length = buffer->message.length;
  delivery->body = body;
  delivery->token = token;
  delivery->live = live;
  service->received++;
  if (napi_call_threadsafe_function(service->tsfn, delivery, napi_tsfn_nonblocking) != napi_ok) {
    // The function is closing: nobody will answer this request, so it is answered here.
    uint32_t id = delivery->id;
    free(delivery->body);
    free(delivery);
    ml_pending_t *taken = ml_take_pending(service, id);
    if (taken != NULL) {
      ml_send_reply(taken->reply, ML_STOPPING, NULL, 0);
      free(taken);
    }
  }
}

static void *ml_receive_loop(void *argument) {
  ml_service_t *service = argument;
  pthread_setname_np("acp.mach-launch.receive");
  ml_receive_buffer_t *buffer = malloc(sizeof *buffer);
  if (buffer == NULL) return NULL;
  for (;;) {
    memset(&buffer->message.header, 0, sizeof buffer->message.header);
    kern_return_t kr = mach_msg(&buffer->message.header,
                                MACH_RCV_MSG | MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
                                    MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
                                0, sizeof *buffer, service->set, MACH_MSG_TIMEOUT_NONE, MACH_PORT_NULL);
    // Without MACH_RCV_LARGE the kernel has already destroyed a message that did not fit.
    if (kr == MACH_RCV_TOO_LARGE || kr == MACH_RCV_INTERRUPTED) continue;
    if (kr != KERN_SUCCESS) break; /* the set is gone: there is nothing left to receive from */
    if (buffer->message.header.msgh_local_port == service->control) {
      ml_discard(&buffer->message.header);
      break;
    }
    ml_handle_request(service, buffer);
  }
  free(buffer);
  return NULL;
}

typedef struct {
  uint32_t drained;
  uint32_t refused;
  int released;
} ml_close_result_t;

// Stops the receive thread, answers every request this side still holds or that is still queued with
// STOPPING, and destroys every right it holds. Idempotent; JS thread only.
static ml_close_result_t ml_teardown(ml_service_t *service) {
  ml_close_result_t result = {0, 0, 1};
  if (service->closed) return result;
  service->closed = 1;
  mach_port_t task = mach_task_self();
  pthread_mutex_lock(&service->lock);
  service->stopping = 1;
  pthread_mutex_unlock(&service->lock);

  if (service->thread_started) {
    mach_msg_header_t stop;
    memset(&stop, 0, sizeof stop);
    stop.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
    stop.msgh_size = sizeof stop;
    stop.msgh_remote_port = service->control;
    stop.msgh_id = ML_STOP_ID;
    if (mach_msg(&stop, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof stop, 0, MACH_PORT_NULL, 1000, MACH_PORT_NULL) !=
        KERN_SUCCESS) {
      // Destroying the set ends the receive with MACH_RCV_PORT_DIED, which the loop treats as the end.
      if (mach_port_mod_refs(task, service->set, MACH_PORT_RIGHT_PORT_SET, -1) != KERN_SUCCESS) result.released = 0;
      service->set = MACH_PORT_NULL;
    }
    pthread_join(service->thread, NULL);
    service->thread_started = 0;
  }
  // `released` is the release calls' own success, not a later look-up of the names: another thread of this
  // task may allocate a port that reuses a just-freed name, so a look-up can only race.
  if (MACH_PORT_VALID(service->set) &&
      mach_port_mod_refs(task, service->set, MACH_PORT_RIGHT_PORT_SET, -1) != KERN_SUCCESS) result.released = 0;
  if (MACH_PORT_VALID(service->control) &&
      mach_port_destruct(task, service->control, -1, 0) != KERN_SUCCESS) result.released = 0;

  // Requests already queued on the service port are answered, not left for a timeout.
  if (MACH_PORT_VALID(service->service)) {
    ml_receive_buffer_t *buffer = malloc(sizeof *buffer);
    for (uint32_t i = 0; buffer != NULL && i < ML_MAX_DRAIN; i++) {
      memset(&buffer->message.header, 0, sizeof buffer->message.header);
      kern_return_t kr = mach_msg(&buffer->message.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT, 0, sizeof *buffer,
                                  service->service, 0, MACH_PORT_NULL);
      if (kr == MACH_RCV_TOO_LARGE) continue;
      if (kr != KERN_SUCCESS) break;
      if (ml_is_answerable_request(&buffer->message.header)) {
        ml_send_reply(buffer->message.header.msgh_remote_port, ML_STOPPING, NULL, 0);
        result.drained++;
      } else {
        ml_discard(&buffer->message.header);
      }
    }
    free(buffer);
  }

  // Requests handed to JavaScript and never answered.
  pthread_mutex_lock(&service->lock);
  ml_pending_t *pending = service->pending;
  service->pending = NULL;
  service->pending_count = 0;
  pthread_mutex_unlock(&service->lock);
  while (pending != NULL) {
    ml_pending_t *next = pending->next;
    ml_send_reply(pending->reply, ML_STOPPING, NULL, 0);
    result.refused++;
    free(pending);
    pending = next;
  }

  // Release exactly what this listener owns: the one receive right bootstrap_check_in returned (it returns
  // no send right). A send uref on the same name held by other code in this task — a claim in flight from
  // the same process — belongs to that code, which deallocates it; taking it here would race that code
  // and could leave the receive right undestroyed (measured).
  if (MACH_PORT_VALID(service->service) &&
      mach_port_mod_refs(task, service->service, MACH_PORT_RIGHT_RECEIVE, -1) != KERN_SUCCESS) result.released = 0;
  service->service = service->control = service->set = MACH_PORT_NULL;

  if (service->tsfn != NULL) {
    napi_release_threadsafe_function(service->tsfn, napi_tsfn_abort);
    service->tsfn = NULL;
  }
  return result;
}

static void ml_env_cleanup(void *argument) {
  ml_service_t *service = argument;
  service->in_hook = 1;
  ml_teardown(service);
  service->hook_added = 0;
}

static void ml_remove_hook(ml_service_t *service) {
  if (service->hook_added && !service->in_hook) {
    napi_remove_env_cleanup_hook(service->env, ml_env_cleanup, service);
    service->hook_added = 0;
  }
}

static void ml_service_finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  ml_service_t *service = data;
  ml_teardown(service);
  ml_remove_hook(service);
  pthread_mutex_destroy(&service->lock);
  free(service);
}

// ---------------------------------------------------------------------------------------------------
// JavaScript plumbing
// ---------------------------------------------------------------------------------------------------

static napi_value ml_throw(napi_env env, const char *code, const char *message, int64_t kr) {
  napi_value error, code_value, message_value, kr_value;
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value);
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value);
  napi_create_error(env, code_value, message_value, &error);
  if (kr != 0) {
    napi_create_int64(env, kr, &kr_value);
    napi_set_named_property(env, error, "kr", kr_value);
  }
  napi_throw(env, error);
  return NULL;
}

static int ml_string_arg(napi_env env, napi_value value, char *out, size_t size) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length == 0 || length >= size) return 0;
  return napi_get_value_string_utf8(env, value, out, size, &length) == napi_ok;
}

static int ml_absent(napi_env env, napi_value value) {
  napi_valuetype type = napi_undefined;
  return napi_typeof(env, value, &type) == napi_ok && (type == napi_undefined || type == napi_null);
}

static int ml_bytes_arg(napi_env env, napi_value value, const uint8_t **data, size_t *length) {
  bool is_buffer = false;
  if (napi_is_buffer(env, value, &is_buffer) != napi_ok || !is_buffer) return 0;
  void *bytes = NULL;
  if (napi_get_buffer_info(env, value, &bytes, length) != napi_ok) return 0;
  *data = bytes;
  return 1;
}

static ml_service_t *ml_service_arg(napi_env env, napi_value value) {
  napi_valuetype type;
  void *data = NULL;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_external) return NULL;
  if (napi_get_value_external(env, value, &data) != napi_ok) return NULL;
  return data;
}

// listen(serviceName, onRequest) -> handle. Throws MACH_LAUNCH_CHECK_IN_REFUSED (with `kr`) when the
// bootstrap server will not hand this process the name's receive right.
static napi_value ml_listen(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char name[BOOTSTRAP_MAX_NAME_LEN];
  napi_valuetype callback_type = napi_undefined;
  if (argc < 2 || !ml_string_arg(env, argv[0], name, sizeof name) ||
      napi_typeof(env, argv[1], &callback_type) != napi_ok || callback_type != napi_function) {
    return ml_throw(env, "MACH_LAUNCH_INVALID_ARGUMENT", "listen(serviceName, onRequest)", 0);
  }
  mach_port_t task = mach_task_self();
  mach_port_t service_port = MACH_PORT_NULL;
  kern_return_t kr = bootstrap_check_in(bootstrap_port, name, &service_port);
  if (kr != KERN_SUCCESS) return ml_throw(env, "MACH_LAUNCH_CHECK_IN_REFUSED", bootstrap_strerror(kr), kr);

  ml_service_t *service = calloc(1, sizeof *service);
  if (service == NULL) {
    mach_port_mod_refs(task, service_port, MACH_PORT_RIGHT_RECEIVE, -1);
    return ml_throw(env, "MACH_LAUNCH_RESOURCE", "out of memory", 0);
  }
  service->env = env;
  service->service = service_port;
  pthread_mutex_init(&service->lock, NULL);
  const char *failed = NULL;
  if (mach_port_allocate(task, MACH_PORT_RIGHT_PORT_SET, &service->set) != KERN_SUCCESS) failed = "port set";
  else if (mach_port_allocate(task, MACH_PORT_RIGHT_RECEIVE, &service->control) != KERN_SUCCESS) failed = "control port";
  else if (mach_port_insert_right(task, service->control, service->control, MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS)
    failed = "control send right";
  else if (mach_port_move_member(task, service->service, service->set) != KERN_SUCCESS ||
           mach_port_move_member(task, service->control, service->set) != KERN_SUCCESS)
    failed = "port set membership";
  if (failed == NULL) {
    napi_value resource;
    napi_create_string_utf8(env, "acp.mach-launch", NAPI_AUTO_LENGTH, &resource);
    if (napi_create_threadsafe_function(env, argv[1], NULL, resource, 0, 1, NULL, NULL, NULL, ml_call_js,
                                        &service->tsfn) != napi_ok) {
      failed = "thread-safe function";
    }
  }
  if (failed == NULL) {
    if (pthread_create(&service->thread, NULL, ml_receive_loop, service) != 0) failed = "receive thread";
    else service->thread_started = 1;
  }
  napi_value handle;
  if (failed == NULL && napi_create_external(env, service, ml_service_finalize, NULL, &handle) != napi_ok) {
    failed = "handle";
  }
  if (failed != NULL) {
    ml_teardown(service);
    pthread_mutex_destroy(&service->lock);
    free(service);
    return ml_throw(env, "MACH_LAUNCH_RESOURCE", failed, 0);
  }
  if (napi_add_env_cleanup_hook(env, ml_env_cleanup, service) == napi_ok) service->hook_added = 1;
  return handle;
}

// respond(handle, id, status, body?) -> boolean: true when the answer was queued to the requester.
static napi_value ml_respond(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  ml_service_t *service = argc >= 3 ? ml_service_arg(env, argv[0]) : NULL;
  uint32_t id = 0, status = 0;
  const uint8_t *body = NULL;
  size_t length = 0;
  if (service == NULL || napi_get_value_uint32(env, argv[1], &id) != napi_ok ||
      napi_get_value_uint32(env, argv[2], &status) != napi_ok ||
      (argc >= 4 && !ml_absent(env, argv[3]) && !ml_bytes_arg(env, argv[3], &body, &length))) {
    return ml_throw(env, "MACH_LAUNCH_INVALID_ARGUMENT", "respond(handle, id, status, body?)", 0);
  }
  if (length > ML_MAX_BODY) return ml_throw(env, "MACH_LAUNCH_INVALID_ARGUMENT", "body exceeds the maximum", 0);
  napi_value answered;
  ml_pending_t *entry = service->closed ? NULL : ml_take_pending(service, id);
  if (entry == NULL) {
    napi_get_boolean(env, false, &answered);
    return answered;
  }
  kern_return_t kr = ml_send_reply(entry->reply, status, body, (uint32_t)length);
  free(entry);
  napi_get_boolean(env, kr == KERN_SUCCESS, &answered);
  return answered;
}

// close(handle) -> { drained, refused, released }
static napi_value ml_close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  ml_service_t *service = argc >= 1 ? ml_service_arg(env, argv[0]) : NULL;
  if (service == NULL) return ml_throw(env, "MACH_LAUNCH_INVALID_ARGUMENT", "close(handle)", 0);
  ml_close_result_t closed = ml_teardown(service);
  ml_remove_hook(service);
  napi_value result, value;
  napi_create_object(env, &result);
  napi_create_uint32(env, closed.drained, &value);
  napi_set_named_property(env, result, "drained", value);
  napi_create_uint32(env, closed.refused, &value);
  napi_set_named_property(env, result, "refused", value);
  napi_get_boolean(env, closed.released, &value);
  napi_set_named_property(env, result, "released", value);
  return result;
}

// instanceLive(token) -> boolean: the token's pid is still the token's instance (its pidversion).
static napi_value ml_instance_live(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  const uint8_t *bytes = NULL;
  size_t length = 0;
  if (argc < 1 || !ml_bytes_arg(env, argv[0], &bytes, &length) || length != sizeof(audit_token_t)) {
    return ml_throw(env, "MACH_LAUNCH_INVALID_ARGUMENT", "instanceLive(token: 32-byte Buffer)", 0);
  }
  audit_token_t token;
  memcpy(&token, bytes, sizeof token);
  char path[PROC_PIDPATHINFO_MAXSIZE];
  napi_value live;
  napi_get_boolean(env, proc_pidpath_audittoken(&token, path, sizeof path) > 0, &live);
  return live;
}

// bsdInfo(pid) -> { ppid, startSec, startUsec } | null. PROC_PIDTBSDINFO gives a pid's parent and its
// start time; the daemon's admission reads it to walk the sender's parent chain and to bind each
// process's own instance by its start token (the sender's own instance is bound by the audit token's
// pidversion through `instanceLive`, which pid reuse cannot forge). The reads are synchronous, so the
// admission's before/after re-reads happen with no other process event interleaved on this thread.
static napi_value ml_bsd_info(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t pid = -1;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 0) {
    return ml_throw(env, "MACH_LAUNCH_INVALID_ARGUMENT", "bsdInfo(pid)", 0);
  }
  struct proc_bsdinfo bi;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bi, sizeof bi) != (int)sizeof bi) {
    napi_value nul;
    napi_get_null(env, &nul);
    return nul;
  }
  napi_value result, v;
  napi_create_object(env, &result);
  napi_create_int64(env, (int64_t)bi.pbi_ppid, &v);
  napi_set_named_property(env, result, "ppid", v);
  napi_create_int64(env, (int64_t)bi.pbi_start_tvsec, &v);
  napi_set_named_property(env, result, "startSec", v);
  napi_create_int64(env, (int64_t)bi.pbi_start_tvusec, &v);
  napi_set_named_property(env, result, "startUsec", v);
  return result;
}

// auditTokenOfPid(pid) -> 32-byte Buffer | null. The live audit token of a same-uid process, read by the
// daemon itself through the public task_name_for_pid + task_info(TASK_AUDIT_TOKEN). Its pidversion changes
// on every exec, so a token bound once and checked later with `instanceLive` refuses a process that has
// exec'd (or died and been reused) since. Nothing reported by another process is involved.
static napi_value ml_audit_token_of_pid(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t pid = -1;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 0) {
    return ml_throw(env, "MACH_LAUNCH_INVALID_ARGUMENT", "auditTokenOfPid(pid)", 0);
  }
  napi_value result;
  napi_get_null(env, &result);
  mach_port_t name = MACH_PORT_NULL;
  if (task_name_for_pid(mach_task_self(), pid, &name) != KERN_SUCCESS) return result;
  audit_token_t token;
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  kern_return_t kr = task_info(name, TASK_AUDIT_TOKEN, (task_info_t)&token, &count);
  mach_port_deallocate(mach_task_self(), name);
  if (kr != KERN_SUCCESS || audit_token_to_pid(token) != pid) return result;
  void *copy = NULL;
  napi_create_buffer_copy(env, sizeof token, &token, &copy, &result);
  return result;
}

// childPids(pid) -> number[]. The live children of a process (public proc_listchildpids).
static napi_value ml_child_pids(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t pid = -1;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 0) {
    return ml_throw(env, "MACH_LAUNCH_INVALID_ARGUMENT", "childPids(pid)", 0);
  }
  pid_t children[256];
  // proc_listchildpids returns the number of pids written (measured), not a byte count.
  int n = proc_listchildpids(pid, children, (int)sizeof children);
  if (n < 0) n = 0;
  if (n > 256) n = 256;
  napi_value result, value;
  napi_create_array_with_length(env, (size_t)n, &result);
  for (int i = 0; i < n; i++) {
    napi_create_int32(env, children[i], &value);
    napi_set_element(env, result, (uint32_t)i, value);
  }
  return result;
}

// executablePath(pid) -> string | null. The path of the image a process is currently running (public
// proc_pidpath); it follows exec, so it tells the daemon when a process has left the holder's wrappers.
static napi_value ml_executable_path(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t pid = -1;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 0) {
    return ml_throw(env, "MACH_LAUNCH_INVALID_ARGUMENT", "executablePath(pid)", 0);
  }
  char path[PROC_PIDPATHINFO_MAXSIZE];
  napi_value result;
  if (proc_pidpath(pid, path, sizeof path) <= 0) {
    napi_get_null(env, &result);
    return result;
  }
  napi_create_string_utf8(env, path, NAPI_AUTO_LENGTH, &result);
  return result;
}

// ---------------------------------------------------------------------------------------------------
// Relay side
// ---------------------------------------------------------------------------------------------------

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  char name[BOOTSTRAP_MAX_NAME_LEN];
  uint8_t *body;
  uint32_t length;
  uint32_t timeout_ms;
  const char *code;
  int64_t kr;
  uint32_t status;
  uint8_t *reply_body;
  uint32_t reply_length;
  int have_replier;
  audit_token_t replier;
} ml_claim_t;

static const char *ml_status_code(uint32_t status) {
  switch (status) {
    case ML_OK: return "OK";
    case ML_REFUSED: return "REFUSED";
    case ML_STOPPING: return "STOPPING";
    case ML_BUSY: return "BUSY";
    case ML_MALFORMED: return "MALFORMED_REQUEST";
    default: return "MALFORMED_REPLY";
  }
}

static uint32_t ml_remaining(uint64_t deadline) {
  uint64_t now = ml_now_ms();
  return now >= deadline ? 0 : (uint32_t)(deadline - now);
}

static void ml_claim_execute(napi_env env, void *data) {
  (void)env;
  ml_claim_t *claim = data;
  mach_port_t task = mach_task_self();
  uint64_t deadline = ml_now_ms() + claim->timeout_ms;
  mach_port_t service = MACH_PORT_NULL, reply = MACH_PORT_NULL;
  ml_message_t *message = NULL;
  ml_receive_buffer_t *buffer = NULL;

  kern_return_t kr = bootstrap_look_up(bootstrap_port, claim->name, &service);
  if (kr != KERN_SUCCESS) {
    claim->code = "SERVICE_UNAVAILABLE";
    claim->kr = kr;
    goto done;
  }
  kr = mach_port_allocate(task, MACH_PORT_RIGHT_RECEIVE, &reply);
  message = calloc(1, sizeof *message);
  buffer = malloc(sizeof *buffer);
  if (kr != KERN_SUCCESS || message == NULL || buffer == NULL) {
    claim->code = "RESOURCE";
    claim->kr = kr;
    goto done;
  }
  message->header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_MAKE_SEND_ONCE);
  message->header.msgh_size = ml_wire_size(claim->length);
  message->header.msgh_remote_port = service;
  message->header.msgh_local_port = reply;
  message->header.msgh_id = ML_REQUEST_ID;
  message->length = claim->length;
  if (claim->length > 0) memcpy(message->body, claim->body, claim->length);
  kr = mach_msg(&message->header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, message->header.msgh_size, 0, MACH_PORT_NULL,
                ml_remaining(deadline), MACH_PORT_NULL);
  if (kr != KERN_SUCCESS) {
    // A timed-out or interrupted send hands its rights back as if received; release them.
    if (kr == MACH_SEND_TIMED_OUT || kr == MACH_SEND_INTERRUPTED) mach_msg_destroy(&message->header);
    claim->code = kr == MACH_SEND_TIMED_OUT ? "TIMED_OUT" : "SEND_FAILED";
    claim->kr = kr;
    goto done;
  }
  memset(&buffer->message.header, 0, sizeof buffer->message.header);
  kr = mach_msg(&buffer->message.header,
                MACH_RCV_MSG | MACH_RCV_TIMEOUT | MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
                    MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
                0, sizeof *buffer, reply, ml_remaining(deadline), MACH_PORT_NULL);
  if (kr != KERN_SUCCESS) {
    claim->code = kr == MACH_RCV_TIMED_OUT ? "TIMED_OUT" : kr == MACH_RCV_TOO_LARGE ? "MALFORMED_REPLY" : "RECEIVE_FAILED";
    claim->kr = kr;
    goto done;
  }
  mach_msg_header_t *header = &buffer->message.header;
  if (header->msgh_id == MACH_NOTIFY_SEND_ONCE) {
    // The kernel's notice that the reply right was destroyed unanswered: the receiver went away.
    claim->code = "DROPPED";
    ml_discard(header);
    goto done;
  }
  const mach_msg_audit_trailer_t *trailer = ml_audit_trailer(buffer);
  if ((header->msgh_bits & MACH_MSGH_BITS_COMPLEX) != 0 || header->msgh_id != ML_REPLY_ID ||
      !ml_body_fits(&buffer->message) || trailer == NULL) {
    claim->code = "MALFORMED_REPLY";
    ml_discard(header);
    goto done;
  }
  claim->have_replier = 1;
  claim->replier = trailer->msgh_audit;
  claim->status = buffer->message.status;
  claim->code = ml_status_code(buffer->message.status);
  claim->reply_length = buffer->message.length;
  claim->reply_body = malloc(claim->reply_length > 0 ? claim->reply_length : 1);
  if (claim->reply_body == NULL) {
    claim->code = "RESOURCE";
    claim->reply_length = 0;
  } else {
    memcpy(claim->reply_body, buffer->message.body, claim->reply_length);
  }
done:
  if (MACH_PORT_VALID(reply)) mach_port_mod_refs(task, reply, MACH_PORT_RIGHT_RECEIVE, -1);
  if (MACH_PORT_VALID(service)) mach_port_deallocate(task, service);
  free(message);
  free(buffer);
}

static void ml_claim_complete(napi_env env, napi_status status, void *data) {
  ml_claim_t *claim = data;
  napi_value result, value;
  napi_create_object(env, &result);
  napi_create_string_utf8(env, status == napi_ok ? claim->code : "CANCELLED", NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "code", value);
  if (claim->kr != 0) {
    napi_create_int64(env, claim->kr, &value);
    napi_set_named_property(env, result, "kr", value);
  }
  if (claim->reply_body != NULL) {
    void *copy = NULL;
    napi_create_uint32(env, claim->status, &value);
    napi_set_named_property(env, result, "status", value);
    napi_create_buffer_copy(env, claim->reply_length, claim->reply_body, &copy, &value);
    napi_set_named_property(env, result, "body", value);
  }
  if (claim->have_replier) {
    napi_value replier;
    napi_create_object(env, &replier);
    napi_create_int64(env, audit_token_to_pid(claim->replier), &value);
    napi_set_named_property(env, replier, "pid", value);
    napi_create_int64(env, audit_token_to_pidversion(claim->replier), &value);
    napi_set_named_property(env, replier, "pidversion", value);
    napi_create_int64(env, audit_token_to_euid(claim->replier), &value);
    napi_set_named_property(env, replier, "euid", value);
    napi_set_named_property(env, result, "replier", replier);
  }
  napi_resolve_deferred(env, claim->deferred, result);
  napi_delete_async_work(env, claim->work);
  free(claim->body);
  free(claim->reply_body);
  free(claim);
}

// claim(serviceName, body, timeoutMs) -> Promise<{ code, kr?, status?, body?, replier? }>. Never rejects
// for a Mach outcome: every one of them is a named code. Throws only for invalid arguments.
static napi_value ml_claim(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  ml_claim_t *claim = calloc(1, sizeof *claim);
  if (claim == NULL) return ml_throw(env, "MACH_LAUNCH_RESOURCE", "out of memory", 0);
  const uint8_t *body = NULL;
  size_t length = 0;
  if (argc < 3 || !ml_string_arg(env, argv[0], claim->name, sizeof claim->name) ||
      !ml_bytes_arg(env, argv[1], &body, &length) || length > ML_MAX_BODY ||
      napi_get_value_uint32(env, argv[2], &claim->timeout_ms) != napi_ok || claim->timeout_ms == 0 ||
      claim->timeout_ms > ML_MAX_TIMEOUT_MS) {
    free(claim);
    return ml_throw(env, "MACH_LAUNCH_INVALID_ARGUMENT", "claim(serviceName, body: Buffer, timeoutMs)", 0);
  }
  claim->length = (uint32_t)length;
  claim->body = malloc(length > 0 ? length : 1);
  if (claim->body == NULL) {
    free(claim);
    return ml_throw(env, "MACH_LAUNCH_RESOURCE", "out of memory", 0);
  }
  if (length > 0) memcpy(claim->body, body, length);
  claim->code = "RESOURCE";
  napi_value promise, resource;
  napi_create_promise(env, &claim->deferred, &promise);
  napi_create_string_utf8(env, "acp.mach-launch.claim", NAPI_AUTO_LENGTH, &resource);
  if (napi_create_async_work(env, NULL, resource, ml_claim_execute, ml_claim_complete, claim, &claim->work) != napi_ok ||
      napi_queue_async_work(env, claim->work) != napi_ok) {
    free(claim->body);
    free(claim);
    return ml_throw(env, "MACH_LAUNCH_RESOURCE", "could not queue the claim", 0);
  }
  return promise;
}

// ---------------------------------------------------------------------------------------------------

NAPI_MODULE_INIT() {
  const struct { const char *name; napi_callback fn; } functions[] = {
      {"listen", ml_listen}, {"respond", ml_respond}, {"close", ml_close},
      {"instanceLive", ml_instance_live}, {"bsdInfo", ml_bsd_info}, {"claim", ml_claim},
      {"auditTokenOfPid", ml_audit_token_of_pid}, {"childPids", ml_child_pids}, {"executablePath", ml_executable_path},
  };
  for (size_t i = 0; i < sizeof functions / sizeof functions[0]; i++) {
    napi_value fn;
    napi_create_function(env, functions[i].name, NAPI_AUTO_LENGTH, functions[i].fn, NULL, &fn);
    napi_set_named_property(env, exports, functions[i].name, fn);
  }
  napi_value statuses, value;
  napi_create_object(env, &statuses);
  const struct { const char *name; uint32_t value; } codes[] = {
      {"OK", ML_OK}, {"REFUSED", ML_REFUSED}, {"STOPPING", ML_STOPPING}, {"BUSY", ML_BUSY}, {"MALFORMED", ML_MALFORMED},
  };
  for (size_t i = 0; i < sizeof codes / sizeof codes[0]; i++) {
    napi_create_uint32(env, codes[i].value, &value);
    napi_set_named_property(env, statuses, codes[i].name, value);
  }
  napi_object_freeze(env, statuses);
  napi_set_named_property(env, exports, "STATUS", statuses);
  napi_create_uint32(env, ML_MAX_BODY, &value);
  napi_set_named_property(env, exports, "MAX_BODY", value);
  return exports;
}
