#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1U << 1)
#endif

#ifndef XINGHENG_RELEASE_PARENT
#define XINGHENG_RELEASE_PARENT "/opt/xingheng-release"
#endif
#ifndef XINGHENG_STATE_PATH
#define XINGHENG_STATE_PATH "/var/lib/xingheng/release-promotion/current.json"
#endif
#ifndef XINGHENG_LOCK_ROOT
#define XINGHENG_LOCK_ROOT "/run/lock/xingheng"
#endif

#ifdef XINGHENG_TEST_BUILD
static const char test_build_marker[] __attribute__((used)) = "XINGHENG_PROMOTION_TEST_BUILD";
#endif

typedef struct {
  uint32_t state[8];
  uint64_t bit_length;
  unsigned char block[64];
  size_t block_length;
} sha256_context;

static const uint32_t sha256_constants[64] = {
  0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U,
  0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
  0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U,
  0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
  0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
  0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
  0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
  0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
  0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U,
  0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
  0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U,
  0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
  0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U,
  0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
  0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
  0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U,
};

static uint32_t rotate_right(uint32_t value, unsigned int count) {
  return (value >> count) | (value << (32U - count));
}

static void sha256_transform(sha256_context *context) {
  uint32_t words[64];
  uint32_t a, b, c, d, e, f, g, h;
  for (size_t index = 0; index < 16; index++) {
    size_t offset = index * 4;
    words[index] = ((uint32_t)context->block[offset] << 24)
      | ((uint32_t)context->block[offset + 1] << 16)
      | ((uint32_t)context->block[offset + 2] << 8)
      | (uint32_t)context->block[offset + 3];
  }
  for (size_t index = 16; index < 64; index++) {
    uint32_t s0 = rotate_right(words[index - 15], 7)
      ^ rotate_right(words[index - 15], 18) ^ (words[index - 15] >> 3);
    uint32_t s1 = rotate_right(words[index - 2], 17)
      ^ rotate_right(words[index - 2], 19) ^ (words[index - 2] >> 10);
    words[index] = words[index - 16] + s0 + words[index - 7] + s1;
  }
  a = context->state[0]; b = context->state[1]; c = context->state[2];
  d = context->state[3]; e = context->state[4]; f = context->state[5];
  g = context->state[6]; h = context->state[7];
  for (size_t index = 0; index < 64; index++) {
    uint32_t sum1 = rotate_right(e, 6) ^ rotate_right(e, 11) ^ rotate_right(e, 25);
    uint32_t choice = (e & f) ^ ((~e) & g);
    uint32_t temporary1 = h + sum1 + choice + sha256_constants[index] + words[index];
    uint32_t sum0 = rotate_right(a, 2) ^ rotate_right(a, 13) ^ rotate_right(a, 22);
    uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    uint32_t temporary2 = sum0 + majority;
    h = g; g = f; f = e; e = d + temporary1;
    d = c; c = b; b = a; a = temporary1 + temporary2;
  }
  context->state[0] += a; context->state[1] += b;
  context->state[2] += c; context->state[3] += d;
  context->state[4] += e; context->state[5] += f;
  context->state[6] += g; context->state[7] += h;
}

static void sha256_initialize(sha256_context *context) {
  memset(context, 0, sizeof(*context));
  context->state[0] = 0x6a09e667U; context->state[1] = 0xbb67ae85U;
  context->state[2] = 0x3c6ef372U; context->state[3] = 0xa54ff53aU;
  context->state[4] = 0x510e527fU; context->state[5] = 0x9b05688cU;
  context->state[6] = 0x1f83d9abU; context->state[7] = 0x5be0cd19U;
}

static void sha256_update(sha256_context *context, const unsigned char *bytes, size_t length) {
  for (size_t index = 0; index < length; index++) {
    context->block[context->block_length++] = bytes[index];
    if (context->block_length == 64) {
      sha256_transform(context);
      context->bit_length += 512;
      context->block_length = 0;
    }
  }
}

static void sha256_finish(sha256_context *context, unsigned char digest[32]) {
  size_t index = context->block_length;
  context->block[index++] = 0x80;
  if (index > 56) {
    while (index < 64) context->block[index++] = 0;
    sha256_transform(context);
    index = 0;
  }
  while (index < 56) context->block[index++] = 0;
  context->bit_length += context->block_length * 8;
  for (size_t shift = 0; shift < 8; shift++) {
    context->block[63 - shift] = (unsigned char)(context->bit_length >> (shift * 8));
  }
  sha256_transform(context);
  for (index = 0; index < 8; index++) {
    digest[index * 4] = (unsigned char)(context->state[index] >> 24);
    digest[index * 4 + 1] = (unsigned char)(context->state[index] >> 16);
    digest[index * 4 + 2] = (unsigned char)(context->state[index] >> 8);
    digest[index * 4 + 3] = (unsigned char)context->state[index];
  }
}

static int fail(const char *message) {
  fprintf(stderr, "promotion atomic exchange rejected: %s\n", message);
  return 1;
}

static int valid_operation_id(const char *value) {
  if (value == NULL || strlen(value) != 36) return 0;
  for (size_t index = 0; index < 36; index++) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (value[index] != '-') return 0;
    } else if (!((value[index] >= '0' && value[index] <= '9')
        || (value[index] >= 'a' && value[index] <= 'f'))) return 0;
  }
  return value[14] == '4'
    && (value[19] == '8' || value[19] == '9' || value[19] == 'a' || value[19] == 'b');
}

static int valid_sha256(const char *value) {
  if (value == NULL || strlen(value) != 64) return 0;
  for (size_t index = 0; index < 64; index++) {
    if (!((value[index] >= '0' && value[index] <= '9')
        || (value[index] >= 'a' && value[index] <= 'f'))) return 0;
  }
  return 1;
}

static int parse_unsigned(const char *value, unsigned long long *output) {
  char *end = NULL;
  if (value == NULL || *value == '\0') return 0;
  for (const char *cursor = value; *cursor != '\0'; cursor++) {
    if (*cursor < '0' || *cursor > '9') return 0;
  }
  errno = 0;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') return 0;
  *output = parsed;
  return 1;
}

static int secure_directory(const struct stat *metadata) {
  return S_ISDIR(metadata->st_mode) && metadata->st_uid == 0 && metadata->st_gid == 0
    && (metadata->st_mode & 0022) == 0;
}

static int validate_lock(int root_fd, int descriptor, const char *name) {
  struct stat opened;
  struct stat named;
  if (fstat(descriptor, &opened) != 0
      || fstatat(root_fd, name, &named, AT_SYMLINK_NOFOLLOW) != 0) return 0;
  return S_ISREG(opened.st_mode) && opened.st_nlink == 1
    && opened.st_uid == 0 && opened.st_gid == 0 && (opened.st_mode & 0777) == 0600
    && opened.st_dev == named.st_dev && opened.st_ino == named.st_ino
    && S_ISREG(named.st_mode) && !S_ISLNK(named.st_mode) && named.st_nlink == 1
    && named.st_uid == 0 && named.st_gid == 0 && (named.st_mode & 0777) == 0600;
}

static int hash_descriptor(int descriptor, char output[65]) {
  sha256_context context;
  unsigned char digest[32];
  unsigned char buffer[65536];
  ssize_t count;
  if (lseek(descriptor, 0, SEEK_SET) < 0) return 0;
  sha256_initialize(&context);
  while ((count = read(descriptor, buffer, sizeof(buffer))) > 0) {
    sha256_update(&context, buffer, (size_t)count);
  }
  memset(buffer, 0, sizeof(buffer));
  if (count < 0) return 0;
  sha256_finish(&context, digest);
  for (size_t index = 0; index < 32; index++) {
    snprintf(output + index * 2, 3, "%02x", digest[index]);
  }
  output[64] = '\0';
  return 1;
}

static int atomic_exchange(int parent_fd, const char *staging_name) {
#ifdef __linux__
  return (int)syscall(
    SYS_renameat2,
    parent_fd,
    "code",
    parent_fd,
    staging_name,
    RENAME_EXCHANGE
  );
#else
  (void)parent_fd;
  (void)staging_name;
  errno = ENOSYS;
  return -1;
#endif
}

int main(int argc, char **argv) {
  struct stat parent_metadata, canonical_before, staging_before;
  struct stat canonical_after, staging_after, context_opened, context_named;
  unsigned long long canonical_dev, canonical_ino, staging_dev, staging_ino;
  char staging_name[96];
  char context_sha[65];
  int parent_fd = -1, canonical_fd = -1, staging_fd = -1, lock_root_fd = -1;
  const char *lock_context = getenv("XINGHENG_OPERATION_LOCK_CONTEXT");
  const char *environment_sha = getenv("XINGHENG_PROMOTION_CONTEXT_SHA256");

#ifdef XINGHENG_TEST_BUILD
  (void)test_build_marker;
#endif
  if (argc != 7) return fail("invalid arguments");
  if (getuid() != 0 || getgid() != 0) return fail("controlled root is required");
  if (lock_context == NULL || strcmp(lock_context, "promotion") != 0) {
    return fail("promotion context is invalid");
  }
  if (!valid_operation_id(argv[1]) || !valid_sha256(argv[2])
      || environment_sha == NULL || strcmp(environment_sha, argv[2]) != 0
      || !parse_unsigned(argv[3], &canonical_dev)
      || !parse_unsigned(argv[4], &canonical_ino)
      || !parse_unsigned(argv[5], &staging_dev)
      || !parse_unsigned(argv[6], &staging_ino)) return fail("context identity is invalid");
  if (snprintf(staging_name, sizeof(staging_name), ".promotion-staging-%s", argv[1]) < 0) {
    return fail("staging name is invalid");
  }

  lock_root_fd = open(XINGHENG_LOCK_ROOT, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (lock_root_fd < 0 || !validate_lock(lock_root_fd, 3, "release-global.lock")
      || !validate_lock(lock_root_fd, 4, "production.lock")) return fail("lock descriptors are invalid");

  if (fstat(5, &context_opened) != 0
      || fstatat(AT_FDCWD, XINGHENG_STATE_PATH, &context_named, AT_SYMLINK_NOFOLLOW) != 0
      || !S_ISREG(context_opened.st_mode) || context_opened.st_nlink != 1
      || context_opened.st_uid != 0 || context_opened.st_gid != 0
      || (context_opened.st_mode & 0777) != 0400
      || context_opened.st_dev != context_named.st_dev
      || context_opened.st_ino != context_named.st_ino
      || !S_ISREG(context_named.st_mode) || S_ISLNK(context_named.st_mode)
      || context_named.st_nlink != 1 || context_named.st_uid != 0
      || context_named.st_gid != 0 || (context_named.st_mode & 0777) != 0400
      || !hash_descriptor(5, context_sha) || strcmp(context_sha, argv[2]) != 0) {
    return fail("promotion record descriptor is invalid");
  }

  parent_fd = open(XINGHENG_RELEASE_PARENT, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (parent_fd < 0 || fstat(parent_fd, &parent_metadata) != 0
      || !secure_directory(&parent_metadata)) return fail("release parent boundary is invalid");
  canonical_fd = openat(parent_fd, "code", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  staging_fd = openat(parent_fd, staging_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (canonical_fd < 0 || staging_fd < 0
      || fstat(canonical_fd, &canonical_before) != 0
      || fstat(staging_fd, &staging_before) != 0
      || !secure_directory(&canonical_before) || !secure_directory(&staging_before)
      || (unsigned long long)canonical_before.st_dev != canonical_dev
      || (unsigned long long)canonical_before.st_ino != canonical_ino
      || (unsigned long long)staging_before.st_dev != staging_dev
      || (unsigned long long)staging_before.st_ino != staging_ino
      || canonical_before.st_dev != staging_before.st_dev) {
    return fail("exchange directory identity is invalid");
  }

  if (atomic_exchange(parent_fd, staging_name) != 0) {
    return fail("renameat2 exchange failed");
  }
  if (fstatat(parent_fd, "code", &canonical_after, AT_SYMLINK_NOFOLLOW) != 0
      || fstatat(parent_fd, staging_name, &staging_after, AT_SYMLINK_NOFOLLOW) != 0
      || canonical_after.st_dev != staging_before.st_dev
      || canonical_after.st_ino != staging_before.st_ino
      || staging_after.st_dev != canonical_before.st_dev
      || staging_after.st_ino != canonical_before.st_ino
      || fsync(parent_fd) != 0) return fail("post-exchange verification failed");

  close(staging_fd); close(canonical_fd); close(parent_fd); close(lock_root_fd);
  printf("PROMOTION_ATOMIC_EXCHANGE=PASS\n");
  return 0;
}
